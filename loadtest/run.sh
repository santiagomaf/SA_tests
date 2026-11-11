#!/usr/bin/env bash
# Corre un test con k6 (en contenedor) y luego verifica el resultado.
#
#   ./run.sh queue low            2.000 ingresos en ráfaga
#   ./run.sh queue high           200.000 ingresos en ráfaga
#   ./run.sh seat safe [low|high] 50 compradores / 1 asiento, o 5.000 / 100
#   ./run.sh seat naive           igual, contra la versión que sobrevende
#   ./run.sh soldout low          2.000 compradores, 100 entradas: se agotan y se cierra la fila
#   ./run.sh soldout high         200.000 compradores, 25.000 entradas
#
# Variables: PORT (8090), ADMIT_PER_MIN (500), K6_IMAGE.
set -euo pipefail
cd "$(dirname "$0")"

PORT=${PORT:-8090}
BASE="http://localhost:$PORT"
K6_IMAGE=${K6_IMAGE:-grafana/k6:latest}
mkdir -p results

usage() { sed -n '2,12p' "$0"; exit 1; }

k6() {
  docker run --rm --network ticketing-poc --user "$(id -u):$(id -g)" \
    --ulimit nofile=65535:65535 \
    -v "$PWD:/scripts:ro" -v "$PWD/results:/results" \
    -e BASE_URL=http://nginx:8080 "$@"
}

if ! curl -fsS -o /dev/null "$BASE/"; then
  echo "El entorno no responde en $BASE. Levántalo primero con: ../stack.sh up" >&2
  exit 1
fi

test=${1:-}; variant=${2:-}; scale=${3:-low}
stamp=$(date +%m%d-%H%M%S)

case "$test" in
  queue)
    case "$variant" in
      low)  joins=2000;   pollers=200 ;;
      high) joins=200000; pollers=2000 ;;
      *) usage ;;
    esac
    run="queue-$variant-$stamp"
    curl -fsS -X POST "$BASE/admin/rate" -H 'Content-Type: application/json' \
      -d "{\"event\":\"$run\",\"rate\":${ADMIT_PER_MIN:-500}}" >/dev/null
    echo "Evento $run — dashboard: $BASE/?event=$run"
    k6 -e EVENT="$run" -e RUN="$run" -e JOINS=$joins -e POLLERS=$pollers \
      "$K6_IMAGE" run /scripts/queue_spike.js || true
    python3 verify.py queue --base "$BASE" --event "$run" --summary "results/$run.k6.json" \
      | tee "results/$run.verify.txt"
    ;;
  seat)
    case "$variant" in safe|naive) ;; *) usage ;; esac
    case "$scale" in
      low)  buyers=50;   seats=1 ;;
      high) buyers=5000; seats=100 ;;
      *) usage ;;
    esac
    run="seat-$variant-$scale-$stamp"
    k6 -e EVENT="$run" -e RUN="$run" -e MODE="$variant" -e BUYERS=$buyers -e SEATS=$seats \
      "$K6_IMAGE" run /scripts/last_seat.js || true
    python3 verify.py seat --base "$BASE" --event "$run" --summary "results/$run.k6.json" \
      --mode "$variant" --buyers $buyers --seats $seats | tee "results/$run.verify.txt"
    ;;
  soldout)
    case "$variant" in
      low)  buyers=2000;   stock=100;   rate=1200;  vus=10 ;;
      high) buyers=200000; stock=25000; rate=60000; vus=50 ;;
      *) usage ;;
    esac
    rate=${ADMIT_PER_MIN:-$rate}
    run="soldout-$variant-$stamp"
    curl -fsS -X POST "$BASE/admin/rate" -H 'Content-Type: application/json' \
      -d "{\"event\":\"$run\",\"rate\":$rate}" >/dev/null
    curl -fsS -X POST "$BASE/seats/$run/stock" -H 'Content-Type: application/json' \
      -d "{\"stock\":$stock}" >/dev/null
    echo "Evento $run — dashboard: $BASE/?event=$run"
    k6 -e EVENT="$run" -e RUN="$run" -e BUYERS=$buyers -e VUS=$vus \
      "$K6_IMAGE" run /scripts/soldout.js || true
    python3 verify.py soldout --base "$BASE" --event "$run" --summary "results/$run.k6.json" \
      --buyers $buyers --stock $stock | tee "results/$run.verify.txt"
    ;;
  *) usage ;;
esac
