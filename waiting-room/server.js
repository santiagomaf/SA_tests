// Servicio de sala de espera (ADR-02, flujos S1, S2 y S3 del informe).
// Sin estado local: la fila, las admisiones y la tasa viven en Redis.
import Fastify from 'fastify';
import Redis from 'ioredis';
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';

const DEFAULT_RATE = Number(process.env.ADMIT_PER_MIN || 500);
const TOKEN_TTL_S = Number(process.env.TOKEN_TTL_S || 900);
const DEFAULT_STOCK = Number(process.env.STOCK || 25000); // entradas por evento
const TICK_MS = 1000;
const TOKEN_GRACE_S = 3; // margen para que el despachador guarde el token
const ID = /^[\w-]{1,64}$/;

const here = (f) => new URL(f, import.meta.url);
const privateKey = createPrivateKey(readFileSync('/keys/private.pem'));
const dashboard = readFileSync(here('./public/index.html'));

const redis = new Redis(process.env.REDIS_URL);
redis.defineCommand('joinQueue', { numberOfKeys: 6, lua: readFileSync(here('./join.lua'), 'utf8') });
redis.defineCommand('admitBatch', { numberOfKeys: 7, lua: readFileSync(here('./admit.lua'), 'utf8') });

const rates = new Map(); // tasa por evento, refrescada en cada ciclo
const rateOf = (event) => rates.get(event) || DEFAULT_RATE;

// --- Generador de tokens de admisión: JWS con ECDSA P-256 (ES256) ---
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const HEADER = b64({ alg: 'ES256', typ: 'JWT' });

function signToken(buyer, event, admittedAt) {
  const data = `${HEADER}.${b64({ sub: buyer, event, iat: admittedAt, exp: admittedAt + TOKEN_TTL_S })}`;
  const sig = sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

// --- Controlador de admisión: despachador periódico ---
async function tick() {
  const events = await redis.smembers('events');
  for (const event of events) {
    const rate = Number(await redis.get(`rate:${event}`)) || DEFAULT_RATE;
    rates.set(event, rate);
    const [at, ...buyers] = await redis.admitBatch(
      `queue:${event}`, `admitlog:${event}`, `admitlast:${event}`, `arrivals:${event}`, 'events',
      `soldout:${event}`, `dropped:${event}`,
      rate, TOKEN_TTL_S, `admitted:${event}:`, event,
    );
    if (buyers.length === 0) continue;
    const pipe = redis.pipeline();
    for (const buyer of buyers) {
      pipe.hset(`admitted:${event}:${buyer}`, 'token', signToken(buyer, event, Number(at)));
    }
    await pipe.exec();
  }
}

async function dispatcher() {
  try {
    await tick();
  } catch (err) {
    console.error('despachador:', err.message);
  }
  setTimeout(dispatcher, TICK_MS);
}

// --- API ---
const app = Fastify({ logger: false });

const SOLD_OUT = { state: 'sold_out', error: 'entradas agotadas: la fila se cerró' };

const waiting = (event, rank) => ({
  state: 'waiting',
  position: rank + 1,
  eta_s: Math.ceil(((rank + 1) / rateOf(event)) * 60),
});

function ids(source, reply) {
  const { event, buyer } = source || {};
  if (!ID.test(event || '') || !ID.test(buyer || '')) {
    reply.code(400).send({ error: 'event y buyer son obligatorios' });
    return null;
  }
  return { event, buyer };
}

// S1: ingreso a la fila
app.post('/queue/join', async (req, reply) => {
  const q = ids(req.body, reply);
  if (!q) return reply;
  const [rank] = await redis.joinQueue(
    `queue:${q.event}`, `admitted:${q.event}:${q.buyer}`, `joined:${q.event}`, 'events', `joinsps:${q.event}`, `soldout:${q.event}`,
    q.buyer, q.event,
  );
  if (rank === -2) return SOLD_OUT;
  return rank < 0 ? { state: 'admitted' } : waiting(q.event, rank);
});

// S3: consulta de posición, o entrega del token si ya fue admitido
app.get('/queue/status', async (req, reply) => {
  const q = ids(req.query, reply);
  if (!q) return reply;
  const key = `admitted:${q.event}:${q.buyer}`;
  const [[, rank], [, adm], [, soldOut]] = await redis.pipeline()
    .zrank(`queue:${q.event}`, q.buyer).hgetall(key).exists(`soldout:${q.event}`).exec();

  // Agotado: se avisa a todos, incluso a quien ya tenía token (ya no podría comprar).
  if (soldOut) return SOLD_OUT;

  if (adm && adm.at) {
    const at = Number(adm.at);
    let token = adm.token;
    if (!token) {
      // Admitido pero el token aún no se guarda: se pide reconsultar. Si pasa el
      // margen (la réplica que lo admitió cayó), cualquier réplica lo emite.
      if (Date.now() / 1000 - at < TOKEN_GRACE_S) return { state: 'admitted', token: null, retry: true };
      token = signToken(q.buyer, q.event, at);
      await redis.hsetnx(key, 'token', token);
    }
    return { state: 'admitted', token, expires_at: at + TOKEN_TTL_S };
  }
  if (rank !== null) return waiting(q.event, rank);
  return reply.code(404).send({ state: 'not_in_queue', error: 'debe ingresar a la fila' });
});

// Tasa de admisión configurable por evento
app.post('/admin/rate', async (req, reply) => {
  const { event, rate } = req.body || {};
  if (!ID.test(event || '') || !(rate >= 1)) return reply.code(400).send({ error: 'event y rate son obligatorios' });
  await redis.mset(`rate:${event}`, Math.floor(rate), 'current_event', event);
  rates.set(event, Math.floor(rate));
  return { event, rate: Math.floor(rate) };
});

app.get('/metrics', async (req, reply) => {
  const event = req.query.event || (await redis.get('current_event'));
  if (!ID.test(event || '')) return reply.code(404).send({ error: 'sin evento' });
  const nowUs = Date.now() * 1000;
  const sec = Math.floor(Date.now() / 1000) - 1;
  const res = await redis.pipeline()
    .zcard(`queue:${event}`)
    .get(`joined:${event}`)
    .zcard(`admitlog:${event}`)
    .zcount(`admitlog:${event}`, nowUs - 60e6, '+inf')
    .hget(`joinsps:${event}`, sec)
    .get(`rate:${event}`)
    .get(`sold:${event}`)
    .get(`stock:${event}`)
    .exists(`soldout:${event}`)
    .get(`dropped:${event}`)
    .exec();
  const [queueLen, joined, admitted, admitted60, joinsLastS, rate, sold, stock, soldOut, dropped] =
    res.map(([, v]) => Number(v) || 0);
  return {
    event, rate: rate || DEFAULT_RATE, queue_len: queueLen, joined,
    admitted_total: admitted, admitted_last_60s: admitted60, joins_last_s: joinsLastS,
    sold, stock: stock || DEFAULT_STOCK, sold_out: soldOut === 1, dropped,
  };
});

// Datos crudos para loadtest/verify.py
app.get('/admin/report', async (req, reply) => {
  const { event } = req.query;
  if (!ID.test(event || '')) return reply.code(400).send({ error: 'event es obligatorio' });
  const res = await redis.pipeline()
    .zrange(`admitlog:${event}`, 0, -1, 'WITHSCORES')
    .hgetall(`arrivals:${event}`)
    .zrange(`queue:${event}`, 0, 0, 'WITHSCORES')
    .zcard(`queue:${event}`)
    .get(`joined:${event}`)
    .hgetall(`joinsps:${event}`)
    .get(`rate:${event}`)
    .get(`sold:${event}`)
    .get(`stock:${event}`)
    .exists(`soldout:${event}`)
    .get(`dropped:${event}`)
    .exec();
  const [log, arrivals, head, queueLen, joined, joinsps, rate, sold, stock, soldOut, dropped] = res.map(([, v]) => v);
  const admissions = [];
  for (let i = 0; i < log.length; i += 2) {
    admissions.push([log[i], Number(arrivals[log[i]]), Number(log[i + 1])]); // comprador, llegada, admisión (µs)
  }
  return {
    event, rate: Number(rate) || DEFAULT_RATE, joined: Number(joined) || 0, queue_len: queueLen,
    queue_head_arrival: head.length ? Number(head[1]) : null,
    admissions, joins_per_second: joinsps,
    sold: Number(sold) || 0, stock: Number(stock) || DEFAULT_STOCK, sold_out: soldOut === 1, dropped: Number(dropped) || 0,
  };
});

app.get('/', (req, reply) => reply.type('text/html').send(dashboard));

await app.listen({ host: '0.0.0.0', port: 3000, backlog: 4096 });
dispatcher();
