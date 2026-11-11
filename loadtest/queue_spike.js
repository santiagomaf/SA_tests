// T1: pico al abrir la venta (EC-02). La llegada es una ráfaga, no uniforme:
// ~70 % de los ingresos ocurre en los primeros 30 s y el resto llega goteando.
import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL;
const EVENT = __ENV.EVENT;
const JOINS = Number(__ENV.JOINS); // ingresos totales aproximados
const POLLERS = Number(__ENV.POLLERS); // compradores que además consultan su posición
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// La forma de la ráfaga suma ~40 × PEAK ingresos en 300 s.
const PEAK = Math.ceil((JOINS - POLLERS) / 40);

const errors5xx = new Rate('errors_5xx');
const keptPosition = new Rate('rejoin_kept_position');
const admitted = new Counter('pollers_admitted');
const waitToAdmission = new Trend('wait_to_admission_s');

export const options = {
  scenarios: {
    rafaga: {
      executor: 'ramping-arrival-rate',
      exec: 'join',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(50, Math.ceil(PEAK / 8)),
      maxVUs: Math.max(200, Math.ceil(PEAK / 2)),
      stages: [
        { target: PEAK, duration: '2s' }, // se abre la venta
        { target: PEAK, duration: '25s' }, // todos entran a la vez
        { target: Math.ceil(PEAK * 0.06), duration: '10s' },
        { target: Math.ceil(PEAK * 0.005), duration: '263s' }, // rezagados
      ],
    },
    espera: {
      executor: 'per-vu-iterations',
      exec: 'waitInLine',
      vus: POLLERS,
      iterations: 1,
      maxDuration: '300s',
    },
  },
  thresholds: {
    'http_req_duration{name:join}': ['p(95)<2000'],
    'http_req_duration{name:status}': ['p(95)<2000'],
    errors_5xx: ['rate==0'],
    rejoin_kept_position: ['rate==1'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

function joinQueue(buyer) {
  const res = http.post(`${BASE}/queue/join`, JSON.stringify({ event: EVENT, buyer }),
    { headers: JSON_HEADERS, tags: { name: 'join' } });
  errors5xx.add(res.status === 0 || res.status >= 500);
  return res;
}

// Un comprador que llega y entra a la fila.
export function join() {
  joinQueue(`b${exec.scenario.iterationInTest}`);
}

// Un comprador que entra en la ráfaga y consulta su posición hasta ser admitido.
export function waitInLine() {
  const buyer = `p${exec.vu.idInTest}`;
  sleep(Math.random() * 20);
  joinQueue(buyer);
  const start = Date.now();
  let rejoined = false;

  while (Date.now() - start < 270000) {
    sleep(3 + Math.random() * 2);
    const res = http.get(`${BASE}/queue/status?event=${EVENT}&buyer=${buyer}`, { tags: { name: 'status' } });
    errors5xx.add(res.status === 0 || res.status >= 500);
    if (res.status !== 200) continue;
    const body = res.json();

    if (body.state === 'admitted' && body.token) {
      admitted.add(1);
      waitToAdmission.add((Date.now() - start) / 1000);
      return;
    }
    // Simula una recarga de página: debe conservar su lugar (ZADD NX).
    if (body.state === 'waiting' && !rejoined) {
      rejoined = true;
      const again = joinQueue(buyer);
      keptPosition.add(again.status === 200 && again.json('position') <= body.position);
    }
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const v = (name, stat) => (m[name] ? m[name].values[stat] : undefined);
  const ms = (x) => (x === undefined ? 'n/d' : `${x.toFixed(1)} ms`);
  const lines = [
    '',
    `T1 pico en la fila — evento ${EVENT}`,
    `  solicitudes HTTP        ${v('http_reqs', 'count')}`,
    `  ingresos descartados    ${v('dropped_iterations', 'count') || 0} (k6 no alcanzó a generarlos)`,
    `  join    p95 / max       ${ms(v('http_req_duration{name:join}', 'p(95)'))} / ${ms(v('http_req_duration{name:join}', 'max'))}`,
    `  status  p95 / max       ${ms(v('http_req_duration{name:status}', 'p(95)'))} / ${ms(v('http_req_duration{name:status}', 'max'))}`,
    `  errores 5xx             ${((v('errors_5xx', 'rate') || 0) * 100).toFixed(3)} %`,
    `  muestra admitida        ${v('pollers_admitted', 'count') || 0} de ${POLLERS}`,
    '',
  ];
  return {
    stdout: lines.join('\n'),
    [`/results/${__ENV.RUN}.k6.json`]: JSON.stringify(data, null, 1),
  };
}
