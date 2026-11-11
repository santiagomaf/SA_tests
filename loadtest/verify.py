#!/usr/bin/env python3
"""Comprueba los resultados de T1 (fila) y T2 (último asiento). Solo biblioteca estándar.

  verify.py queue --base URL --event ID --summary results/X.k6.json
  verify.py soldout --base URL --event ID --summary results/X.k6.json --buyers N --stock M
  verify.py seat  --base URL --event ID --summary results/X.k6.json --mode safe|naive --buyers N --seats M

Usa lo que midió k6 (latencias, errores) y lo que quedó registrado en el
servidor (orden y hora de cada admisión, ganadores por asiento).
Termina con código 1 si algún criterio falla.
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

WINDOW_US = 60_000_000
results = []


def http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as err:
        return err.code, json.load(err)


def check(ok, name, detail):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")


def metric(summary, name, stat):
    return summary["metrics"].get(name, {}).get("values", {}).get(stat)


def verify_queue(args, summary):
    _, rep = http("GET", f"{args.base}/admin/report?event={args.event}")
    rate = rep["rate"]
    adm = sorted(rep["admissions"], key=lambda a: (a[2], a[1]))  # por hora de admisión, luego llegada
    per_s = {int(s): int(n) for s, n in rep["joins_per_second"].items()}
    first = min(per_s) if per_s else 0
    total = sum(per_s.values())
    in_30s = sum(n for s, n in per_s.items() if s < first + 30)

    print(f"\nT1 pico en la fila — evento {args.event}")
    print(f"  ingresos únicos: {rep['joined']}   pico: {max(per_s.values(), default=0)} ingresos/s   "
          f"en los primeros 30 s: {100 * in_30s / max(total, 1):.0f} %")
    print(f"  admitidos: {len(adm)}   quedan en la fila: {rep['queue_len']}   tasa: {rate}/min")
    wait = metric(summary, "wait_to_admission_s", "med")
    if wait is not None:
        print(f"  espera hasta ser admitido (muestra): mediana {wait:.0f} s, máx {metric(summary, 'wait_to_admission_s', 'max'):.0f} s")
    print()

    # 1. Medida de respuesta de EC-02
    p95_join = metric(summary, "http_req_duration{name:join}", "p(95)")
    p95_status = metric(summary, "http_req_duration{name:status}", "p(95)")
    err = metric(summary, "errors_5xx", "rate")
    check(p95_join < 2000 and p95_status < 2000, "p95 < 2 s",
          f"join {p95_join:.1f} ms, status {p95_status:.1f} ms")
    check(err == 0, "0 % de errores 5xx", f"{100 * err:.3f} % de {metric(summary, 'http_reqs', 'count')} solicitudes")

    admission_checks(rep, adm)

    # 4. Nadie se pierde
    check(rep["joined"] == rep["queue_len"] + len(adm) + rep["dropped"], "nadie se pierde",
          f"{rep['joined']} ingresos = {rep['queue_len']} en fila + {len(adm)} admitidos + {rep['dropped']} descartados por agotarse")

    # 5. Reingresar no cambia la posición (medido por k6 y con una sonda propia)
    reentry_probe(args, summary, rate)


def admission_checks(rep, adm):
    rate = rep["rate"]
    # Nunca más de `rate` admisiones en una ventana de 60 s
    times = [a[2] for a in adm]
    worst, lo = 0, 0
    for hi, t in enumerate(times):
        while times[lo] <= t - WINDOW_US:
            lo += 1
        worst = max(worst, hi - lo + 1)
    check(worst <= rate, "tasa de admisión respetada", f"máximo {worst} admitidos en 60 s (tope {rate})")

    # 3. FIFO: se admite por orden de llegada y nadie de la fila llegó antes que un admitido
    arrivals = [a[1] for a in adm]
    in_order = all(x <= y for x, y in zip(arrivals, arrivals[1:]))
    head = rep["queue_head_arrival"]
    nobody_skipped = head is None or not arrivals or max(arrivals) < head
    check(in_order and nobody_skipped, "orden de llegada (FIFO)",
          f"{len(adm)} admisiones en orden, sin adelantar a nadie de la fila")


def reentry_probe(args, summary, rate):
    kept = metric(summary, "rejoin_kept_position", "rate")
    http("POST", f"{args.base}/admin/rate", {"event": args.event, "rate": 1})  # congela la fila para la sonda
    _, a = http("POST", f"{args.base}/queue/join", {"event": args.event, "buyer": "sonda-verify"})
    http("POST", f"{args.base}/queue/join", {"event": args.event, "buyer": "sonda-verify-2"})
    _, b = http("POST", f"{args.base}/queue/join", {"event": args.event, "buyer": "sonda-verify"})
    http("POST", f"{args.base}/admin/rate", {"event": args.event, "rate": rate})
    probe_ok = a.get("state") == "waiting" and b.get("position", 0) <= a.get("position", -1)
    check(probe_ok and kept in (None, 1), "reingreso conserva la posición",
          f"sonda: {a.get('position')} -> {b.get('position')}; recargas en k6 que la conservaron: "
          + ("n/d" if kept is None else f"{100 * kept:.0f} %"))


def verify_soldout(args, summary):
    _, rep = http("GET", f"{args.base}/admin/report?event={args.event}")
    adm = sorted(rep["admissions"], key=lambda a: (a[2], a[1]))
    n = lambda name: metric(summary, name, "count") or 0
    bought, at_reserve, in_queue, at_join, other = (n(m) for m in (
        "bought_201", "sold_out_at_reserve_410", "sold_out_in_queue", "sold_out_at_join", "other_outcome"))

    print(f"\nT3 entradas agotadas — evento {args.event}, {args.buyers} compradores, {args.stock} entradas")
    print(f"  ingresos a la fila: {rep['joined']}   admitidos: {len(adm)}   tasa: {rep['rate']}/min")
    print(f"  compraron (201): {bought:.0f}   agotado al reservar (410): {at_reserve:.0f}   "
          f"agotado estando en la sala: {in_queue:.0f}   agotado al ingresar: {at_join:.0f}\n")

    check(bought == args.stock and rep["sold"] == args.stock, "se vende exactamente el stock",
          f"{bought:.0f} confirmaciones, {rep['sold']} vendidas en el servidor, stock {args.stock}")
    _, late = http("POST", f"{args.base}/queue/join", {"event": args.event, "buyer": "sonda-tardia"})
    check(rep["sold_out"] and rep["queue_len"] == 0 and rep["dropped"] > 0 and late.get("state") == "sold_out",
          "al agotarse se descarta la fila",
          f"{rep['dropped']} personas descartadas, quedan {rep['queue_len']} en fila; ingreso tardío -> {late.get('state')}")
    check(rep["joined"] == len(adm) + rep["dropped"], "nadie se pierde",
          f"{rep['joined']} ingresos = {len(adm)} admitidos + {rep['dropped']} descartados")
    check(bought + at_reserve + in_queue + at_join == args.buyers and other == 0, "todos reciben respuesta",
          f"{bought + at_reserve + in_queue + at_join:.0f} de {args.buyers} compradores terminaron con compra o aviso de agotado")
    err = metric(summary, "errors_5xx", "rate")
    check(err == 0, "0 % de errores 5xx", f"{100 * err:.3f} % de {metric(summary, 'http_reqs', 'count')} solicitudes")
    admission_checks(rep, adm)


def verify_seat(args, summary):
    _, winners = http("GET", f"{args.base}/seats/{args.event}/winners")
    won = metric(summary, "reserved_201", "count")
    lost = metric(summary, "rejected_409", "count")
    other = metric(summary, "other_status", "count")
    p95 = metric(summary, "http_req_duration{name:reserve}", "p(95)")
    worst = metric(summary, "http_req_duration{name:reserve}", "max")
    oversold = {s: n for s, n in winners.items() if n > 1}

    print(f"\nT2 último asiento — modo {args.mode}, {args.buyers} compradores, {args.seats} asiento(s)")
    print(f"  respuestas: {won:.0f}× 201, {lost:.0f}× 409, {other:.0f} otras   latencia p95 {p95:.1f} ms, máx {worst:.1f} ms\n")

    if args.mode == "naive":
        check(won > args.seats, "la versión ingenua sobrevende (resultado esperado)",
              f"{won:.0f} compradores recibieron confirmación para {args.seats} asiento(s)")
        return

    check(won == args.seats and not oversold and len(winners) == args.seats, "0 ventas dobles",
          f"{won:.0f} reservas para {args.seats} asiento(s); asientos con más de un ganador: {len(oversold)}")
    check(lost == args.buyers - args.seats and other == 0, "el resto recibe 409",
          f"{lost:.0f} rechazos de {args.buyers - args.seats} esperados")
    check(p95 < 1000, "aviso en menos de 1 s", f"p95 {p95:.1f} ms, máx {worst:.1f} ms")
    bad = metric(summary, "bad_token_rejected", "rate")
    check(bad == 1, "sin token válido no se reserva", "sin token, firma adulterada y token de otro evento -> 401")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("test", choices=["queue", "seat", "soldout"])
    ap.add_argument("--base", required=True)
    ap.add_argument("--event", required=True)
    ap.add_argument("--summary", required=True)
    ap.add_argument("--mode", default="safe")
    ap.add_argument("--buyers", type=int, default=50)
    ap.add_argument("--seats", type=int, default=1)
    ap.add_argument("--stock", type=int, default=25000)
    args = ap.parse_args()

    with open(args.summary) as f:
        summary = json.load(f)
    {"queue": verify_queue, "seat": verify_seat, "soldout": verify_soldout}[args.test](args, summary)

    print(f"\n  {'PASS' if all(results) else 'FAIL'}: {sum(results)} de {len(results)} criterios\n")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
