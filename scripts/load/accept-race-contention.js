import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3000';
const TRANSPORTER_TOKEN = __ENV.TRANSPORTER_TOKEN || '';
const TRUCK_REQUEST_ID = __ENV.TRUCK_REQUEST_ID || '';
const VEHICLE_ID = __ENV.VEHICLE_ID || '';
const DRIVER_ID = __ENV.DRIVER_ID || '';
const RUN_ID = __ENV.LOAD_TEST_RUN_ID || `phase8-accept-race-${Date.now()}`;

export const options = {
  scenarios: {
    accept_race: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 60),
      duration: __ENV.DURATION || '90s'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500', 'p(99)<1200']
  }
};

function headers() {
  return {
    headers: {
      Authorization: `Bearer ${TRANSPORTER_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Load-Test-Run-Id': RUN_ID,
      'X-Trace-Id': `${RUN_ID}-${__VU}-${__ITER}`
    }
  };
}

export default function () {
  if (!TRANSPORTER_TOKEN || !TRUCK_REQUEST_ID || !VEHICLE_ID || !DRIVER_ID) {
    throw new Error('TRANSPORTER_TOKEN, TRUCK_REQUEST_ID, VEHICLE_ID, DRIVER_ID are required');
  }

  const payload = {
    truckRequestId: TRUCK_REQUEST_ID,
    vehicleId: VEHICLE_ID,
    driverId: DRIVER_ID
  };

  const res = http.post(`${BASE_URL}/api/v1/orders/accept`, JSON.stringify(payload), headers());

  check(res, {
    'accept status is success or race rejection': (r) => [200, 400, 409].includes(r.status)
  });

  sleep(0.05);
}
