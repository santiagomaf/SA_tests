#!/usr/bin/env bash
# Levanta o baja el entorno sin Docker Compose (equivale a docker-compose.yml).
#
#   ./stack.sh up      construye las imágenes y levanta todo
#   ./stack.sh down    elimina contenedores, red y claves
#   ./stack.sh ps      muestra el estado
#
# Variables: PORT (8090), ADMIT_PER_MIN (500), TOKEN_TTL_S (900).
set -euo pipefail
cd "$(dirname "$0")"

NET=ticketing-poc
PORT=${PORT:-8090}
CONTAINERS="poc-nginx poc-wr-1 poc-wr-2 poc-sales-1 poc-sales-2 poc-redis"

down() {
  docker rm -f $CONTAINERS >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
  docker volume rm poc-keys-private poc-keys-public >/dev/null 2>&1 || true
}

up() {
  down
  docker build -q -t ticketing-poc-waiting-room waiting-room >/dev/null
  docker build -q -t ticketing-poc-sales-api sales-api >/dev/null
  docker network create $NET >/dev/null

  docker run -d --name poc-redis --network $NET --network-alias redis \
    redis:7-alpine redis-server --save "" --appendonly no >/dev/null

  # Par de claves ECDSA P-256: la sala recibe la privada, la API de ventas la pública.
  docker run --rm -v poc-keys-private:/priv -v poc-keys-public:/pub node:22-alpine node -e "
    const fs = require('fs'), crypto = require('crypto');
    const k = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    fs.writeFileSync('/priv/private.pem', k.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync('/pub/public.pem', k.publicKey.export({ type: 'spki', format: 'pem' }));"

  for i in 1 2; do
    docker run -d --name poc-wr-$i --network $NET --network-alias waiting-room-$i \
      -e REDIS_URL=redis://redis:6379 -e ADMIT_PER_MIN="${ADMIT_PER_MIN:-500}" -e TOKEN_TTL_S="${TOKEN_TTL_S:-900}" \
      -v poc-keys-private:/keys:ro ticketing-poc-waiting-room >/dev/null
    docker run -d --name poc-sales-$i --network $NET --network-alias sales-api-$i \
      -e REDIS_URL=redis://redis:6379 \
      -v poc-keys-public:/keys:ro ticketing-poc-sales-api >/dev/null
  done

  docker run -d --name poc-nginx --network $NET --network-alias nginx \
    --ulimit nofile=65535:65535 -p "$PORT:8080" \
    -v "$PWD/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:alpine >/dev/null

  for _ in $(seq 30); do
    if curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
      echo "Listo. Dashboard: http://localhost:$PORT"
      return
    fi
    sleep 1
  done
  echo "El entorno no respondió en 30 s. Revisa: docker logs poc-nginx" >&2
  exit 1
}

case "${1:-}" in
  up) up ;;
  down) down; echo "Entorno eliminado." ;;
  ps) docker ps -a --filter name=poc- --format 'table {{.Names}}\t{{.Status}}' ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
