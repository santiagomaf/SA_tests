// API de ventas, solo la reserva de asientos (ADR-01, flujo F1 del informe).
import Fastify from 'fastify';
import Redis from 'ioredis';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const RESERVATION_MS = 600000; // R-04: 10 minutos
const DEFAULT_STOCK = Number(process.env.STOCK || 25000); // entradas por evento
const NAIVE_GAP_MS = 5; // tiempo entre leer y escribir en la versión ingenua
const ID = /^[\w-]{1,64}$/;

const publicKey = createPublicKey(readFileSync('/keys/public.pem'));
const redis = new Redis(process.env.REDIS_URL);
const app = Fastify({ logger: false });

// Reserva + control de stock en un solo paso atómico.
// KEYS: 1 seat:{e}:{asiento}  2 sold:{e}  3 stock:{e}  4 soldout:{e}
// ARGV: 1 comprador  2 vigencia (ms)  3 stock por defecto
// Devuelve 1 = reservado, 0 = asiento ocupado, -1 = entradas agotadas.
redis.defineCommand('reserveSeat', {
  numberOfKeys: 4,
  lua: `
    local stock = tonumber(redis.call('GET', KEYS[3])) or tonumber(ARGV[3])
    if (tonumber(redis.call('GET', KEYS[2])) or 0) >= stock then return -1 end
    if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 0 end
    -- Al venderse la última entrada se marca el evento como agotado:
    -- la sala de espera ve la marca y descarta la fila.
    if redis.call('INCR', KEYS[2]) >= stock then redis.call('SET', KEYS[4], 1) end
    return 1`,
});

// Valida el token de admisión solo con la clave pública: no llama a la sala.
function admittedBuyer(req, event) {
  const [header, payload, sig] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  if (!header || !payload || !sig) return null;
  try {
    const ok = verify('sha256', Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    if (!ok) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    if (claims.exp < Date.now() / 1000 || claims.event !== event) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

function reserveRoute(path, tryLock) {
  app.post(path, async (req, reply) => {
    const { event, seat } = req.body || {};
    if (!ID.test(event || '') || !ID.test(seat || '')) {
      return reply.code(400).send({ error: 'event y seat son obligatorios' });
    }
    const buyer = admittedBuyer(req, event);
    if (!buyer) return reply.code(401).send({ error: 'token de admisión inválido o vencido: vuelva a la sala de espera' });

    const key = `seat:${event}:${seat}`;
    const result = await tryLock(key, buyer, event);
    if (result === 1) {
      await redis.hincrby(`winners:${event}`, seat, 1); // evidencia para el test
      return reply.code(201).send({ seat, expires_in_s: RESERVATION_MS / 1000 });
    }
    // Reintento del mismo comprador (flujo F4): la operación es idempotente.
    if ((await redis.get(key)) === buyer) return { seat, idempotent: true };
    if (result === -1) return reply.code(410).send({ error: 'entradas agotadas' });
    return reply.code(409).send({ error: 'el asiento ya no está disponible' });
  });
}

// Correcto: una sola operación atómica (SET NX PX + stock). Redis resuelve la carrera.
reserveRoute('/reserve', (key, buyer, event) => redis.reserveSeat(
  key, `sold:${event}`, `stock:${event}`, `soldout:${event}`, buyer, RESERVATION_MS, DEFAULT_STOCK));

// Ingenuo (solo para comparar): leer y después escribir. Entre ambos pasos
// otros compradores ven el asiento libre y también lo "reservan".
reserveRoute('/reserve-naive', async (key, buyer) => {
  if (await redis.get(key)) return 0;
  await sleep(NAIVE_GAP_MS);
  await redis.set(key, buyer, 'PX', RESERVATION_MS);
  return 1;
});

// Cuántos compradores recibieron 201 por cada asiento del evento.
app.get('/seats/:event/winners', async (req, reply) => {
  if (!ID.test(req.params.event)) return reply.code(400).send({ error: 'evento inválido' });
  const winners = await redis.hgetall(`winners:${req.params.event}`);
  return Object.fromEntries(Object.entries(winners).map(([seat, n]) => [seat, Number(n)]));
});

// Stock de entradas del evento (por defecto 25.000).
app.post('/seats/:event/stock', async (req, reply) => {
  const stock = Math.floor(req.body?.stock);
  if (!ID.test(req.params.event) || !(stock >= 1)) return reply.code(400).send({ error: 'stock inválido' });
  await redis.set(`stock:${req.params.event}`, stock);
  return { event: req.params.event, stock };
});

await app.listen({ host: '0.0.0.0', port: 3000, backlog: 4096 });
