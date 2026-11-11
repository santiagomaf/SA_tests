// T3: entradas agotadas. Los compradores entran a la fila, compran al ser
// admitidos y, cuando se vende la última entrada, la fila se descarta.
// Cada VU maneja un grupo de compradores con solicitudes en lote.
import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL;
const EVENT = __ENV.EVENT;
const BUYERS = Number(__ENV.BUYERS);
const VUS = Number(__ENV.VUS);
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CHUNK = 200;
const MAX_MS = 540000;

const bought = new Counter('bought_201');
const soldOutAtReserve = new Counter('sold_out_at_reserve_410');
const soldOutInQueue = new Counter('sold_out_in_queue');
const soldOutAtJoin = new Counter('sold_out_at_join');
const other = new Counter('other_outcome');
const errors5xx = new Rate('errors_5xx');

export const options = {
  batch: 50,
  batchPerHost: 50,
  scenarios: {
    venta: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '600s' },
  },
  thresholds: { errors_5xx: ['rate==0'] },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

const buyerId = (i) => `c${i}`;

function batch(requests) {
  const responses = http.batch(requests);
  responses.forEach((res) => errors5xx.add(res.status === 0 || res.status >= 500));
  return responses;
}

export default function () {
  const todo = []; // aún no ingresan
  for (let i = exec.vu.idInTest - 1; i < BUYERS; i += VUS) todo.push(i);
  let pending = []; // en la fila, en orden de llegada
  const deadline = Date.now() + MAX_MS;

  while ((todo.length || pending.length) && Date.now() < deadline) {
    let progress = false;

    // Llega el siguiente grupo de compradores.
    if (todo.length) {
      progress = true;
      const chunk = todo.splice(0, CHUNK);
      batch(chunk.map((b) => ['POST', `${BASE}/queue/join`,
        JSON.stringify({ event: EVENT, buyer: buyerId(b) }), { headers: JSON_HEADERS, tags: { name: 'join' } }]))
        .forEach((res, j) => {
          if (res.status === 200 && res.json('state') === 'sold_out') soldOutAtJoin.add(1);
          else pending.push(chunk[j]);
        });
    }

    // Consultan los que llegaron primero: la fila admite en ese orden.
    const head = pending.slice(0, CHUNK);
    const admitted = [];
    const waiting = [];
    batch(head.map((b) => ['GET', `${BASE}/queue/status?event=${EVENT}&buyer=${buyerId(b)}`, null,
      { tags: { name: 'status' } }]))
      .forEach((res, j) => {
        const body = res.status === 200 ? res.json() : {};
        if (body.state === 'sold_out') soldOutInQueue.add(1);
        else if (body.token) admitted.push({ buyer: head[j], token: body.token });
        else waiting.push(head[j]);
      });
    pending = waiting.concat(pending.slice(head.length));
    if (waiting.length < head.length) progress = true;

    // Los admitidos compran, cada uno un asiento distinto: el límite es el stock.
    batch(admitted.map((a) => ['POST', `${BASE}/reserve`, JSON.stringify({ event: EVENT, seat: `S${a.buyer}` }),
      { headers: { ...JSON_HEADERS, Authorization: `Bearer ${a.token}` }, tags: { name: 'reserve' } }]))
      .forEach((res) => {
        if (res.status === 201) bought.add(1);
        else if (res.status === 410) soldOutAtReserve.add(1);
        else other.add(1);
      });

    if (!progress) sleep(1);
  }
  other.add(todo.length + pending.length); // quedaron sin respuesta
}

export function handleSummary(data) {
  const m = data.metrics;
  const v = (name, stat) => (m[name] ? m[name].values[stat] : 0);
  const lines = [
    '',
    `T3 entradas agotadas — evento ${EVENT}, ${BUYERS} compradores`,
    `  solicitudes HTTP            ${v('http_reqs', 'count')}`,
    `  compraron (201)             ${v('bought_201', 'count')}`,
    `  agotado al reservar (410)   ${v('sold_out_at_reserve_410', 'count')}`,
    `  agotado estando en la sala  ${v('sold_out_in_queue', 'count')}`,
    `  agotado al ingresar         ${v('sold_out_at_join', 'count')}`,
    `  sin respuesta / otras       ${v('other_outcome', 'count')}`,
    `  errores 5xx                 ${(v('errors_5xx', 'rate') * 100).toFixed(3)} %`,
    '',
  ];
  return {
    stdout: lines.join('\n'),
    [`/results/${__ENV.RUN}.k6.json`]: JSON.stringify(data, null, 1),
  };
}
