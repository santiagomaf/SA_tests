// T2: último asiento disputado (EC-01). Muchos compradores ya admitidos
// intentan reservar el mismo asiento al mismo tiempo.
import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL;
const EVENT = __ENV.EVENT;
const BUYERS = Number(__ENV.BUYERS);
const SEATS = Number(__ENV.SEATS);
const PATH = __ENV.MODE === 'naive' ? '/reserve-naive' : '/reserve';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CHUNK = 200;

const reserved = new Counter('reserved_201');
const rejected = new Counter('rejected_409');
const other = new Counter('other_status');
const badToken = new Rate('bad_token_rejected');

export const options = {
  setupTimeout: '300s',
  batch: 50,
  batchPerHost: 50,
  scenarios: {
    carrera: {
      executor: 'shared-iterations',
      vus: Math.min(BUYERS, 500),
      iterations: BUYERS,
      maxDuration: '120s',
    },
  },
  thresholds: { 'http_req_duration{name:reserve}': ['p(95)<1000'] },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

const buyerId = (i) => `c${i}`;

// Los compradores pasan por la sala de espera real para obtener su token.
export function setup() {
  http.post(`${BASE}/admin/rate`, JSON.stringify({ event: EVENT, rate: 600000 }), { headers: JSON_HEADERS });

  const all = Array.from({ length: BUYERS }, (_, i) => i);
  for (let i = 0; i < BUYERS; i += CHUNK) {
    http.batch(all.slice(i, i + CHUNK).map((b) => ['POST', `${BASE}/queue/join`,
      JSON.stringify({ event: EVENT, buyer: buyerId(b) }), { headers: JSON_HEADERS }]));
  }

  const tokens = new Array(BUYERS);
  let pending = all;
  while (pending.length > 0) {
    sleep(1);
    const still = [];
    for (let i = 0; i < pending.length; i += CHUNK) {
      const chunk = pending.slice(i, i + CHUNK);
      const responses = http.batch(chunk.map((b) =>
        ['GET', `${BASE}/queue/status?event=${EVENT}&buyer=${buyerId(b)}`]));
      responses.forEach((res, j) => {
        const token = res.status === 200 ? res.json('token') : null;
        if (token) tokens[chunk[j]] = token;
        else still.push(chunk[j]);
      });
    }
    pending = still;
  }
  return { tokens };
}

export default function (data) {
  const i = exec.scenario.iterationInTest;
  const res = http.post(`${BASE}${PATH}`, JSON.stringify({ event: EVENT, seat: `A${i % SEATS}` }), {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${data.tokens[i]}` },
    tags: { name: 'reserve' },
  });
  reserved.add(res.status === 201 ? 1 : 0);
  rejected.add(res.status === 409 ? 1 : 0);
  other.add(res.status !== 201 && res.status !== 409 ? 1 : 0);
}

// Sin un token válido para este evento no se puede reservar.
export function teardown(data) {
  const body = JSON.stringify({ event: EVENT, seat: 'Z99' });
  const attempt = (headers, payload) =>
    http.post(`${BASE}/reserve`, payload || body, { headers: { ...JSON_HEADERS, ...headers }, tags: { name: 'bad_token' } });
  const token = data.tokens[0];
  const tampered = `${token.slice(0, -6)}${token.slice(-6) === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA'}`;

  badToken.add(attempt({}).status === 401); // sin token
  badToken.add(attempt({ Authorization: `Bearer ${tampered}` }).status === 401); // firma adulterada
  badToken.add(attempt({ Authorization: `Bearer ${token}` },
    JSON.stringify({ event: 'otro-evento', seat: 'Z99' })).status === 401); // token de otro evento
}

export function handleSummary(data) {
  const m = data.metrics;
  const v = (name, stat) => (m[name] ? m[name].values[stat] : undefined);
  const d = 'http_req_duration{name:reserve}';
  const lines = [
    '',
    `T2 último asiento — ${BUYERS} compradores, ${SEATS} asiento(s), ${PATH}`,
    `  201 reserva confirmada  ${v('reserved_201', 'count')}`,
    `  409 asiento no disponible ${v('rejected_409', 'count')}`,
    `  otras respuestas        ${v('other_status', 'count')}`,
    `  latencia p95 / max      ${v(d, 'p(95)').toFixed(1)} ms / ${v(d, 'max').toFixed(1)} ms`,
    '',
  ];
  return {
    stdout: lines.join('\n'),
    [`/results/${__ENV.RUN}.k6.json`]: JSON.stringify(data, null, 1),
  };
}
