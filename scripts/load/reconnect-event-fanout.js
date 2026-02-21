import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3000';
const RUN_ID = __ENV.LOAD_TEST_RUN_ID || `phase8-reconnect-fanout-${Date.now()}`;

export const options = {
  scenarios: {
    fanout_health_loop: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 40),
      duration: __ENV.DURATION || '2m'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500', 'p(99)<1200']
  }
};

/**
 * This scenario validates reconnect/fanout health indirectly by checking
 * websocket health visibility endpoints under concurrent probing.
 *
 * For full Socket.IO protocol validation, pair this with scripts/synthetic/websocket_probe.sh.
 */
export default function () {
  const res = http.get(`${BASE_URL}/health/websocket`, {
    headers: {
      'X-Load-Test-Run-Id': RUN_ID,
      'X-Trace-Id': `${RUN_ID}-${__VU}-${__ITER}`
    }
  });

  check(res, {
    'websocket health endpoint returns 200': (r) => r.status === 200,
    'websocket status field exists': (r) => !!r.json('status')
  });

  sleep(0.2);
}
