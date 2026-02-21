import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3000';
const CUSTOMER_TOKEN = __ENV.CUSTOMER_TOKEN || '';
const TRANSPORTER_TOKEN = __ENV.TRANSPORTER_TOKEN || '';
const ORDER_ID = __ENV.ORDER_ID || '';
const TRUCK_REQUEST_ID = __ENV.TRUCK_REQUEST_ID || '';
const VEHICLE_ID = __ENV.VEHICLE_ID || '';
const DRIVER_ID = __ENV.DRIVER_ID || '';
const RUN_ID = __ENV.LOAD_TEST_RUN_ID || `phase8-cancel-assign-${Date.now()}`;

export const options = {
  scenarios: {
    cancels: {
      executor: 'constant-vus',
      exec: 'cancelFlow',
      vus: Number(__ENV.CANCEL_VUS || 20),
      duration: __ENV.DURATION || '90s'
    },
    accepts: {
      executor: 'constant-vus',
      exec: 'acceptFlow',
      vus: Number(__ENV.ACCEPT_VUS || 20),
      duration: __ENV.DURATION || '90s'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<700', 'p(99)<1500']
  }
};

function commonHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Load-Test-Run-Id': RUN_ID,
      'X-Trace-Id': `${RUN_ID}-${__VU}-${__ITER}`
    }
  };
}

export function cancelFlow() {
  if (!CUSTOMER_TOKEN || !ORDER_ID) {
    throw new Error('CUSTOMER_TOKEN and ORDER_ID are required for cancelFlow');
  }

  const res = http.post(
    `${BASE_URL}/api/v1/orders/${ORDER_ID}/cancel`,
    JSON.stringify({ reason: 'phase8_load_cancel' }),
    commonHeaders(CUSTOMER_TOKEN)
  );

  check(res, {
    'cancel status is success or already terminal': (r) => [200, 400, 404].includes(r.status)
  });

  sleep(0.05);
}

export function acceptFlow() {
  if (!TRANSPORTER_TOKEN || !TRUCK_REQUEST_ID || !VEHICLE_ID || !DRIVER_ID) {
    throw new Error('TRANSPORTER_TOKEN, TRUCK_REQUEST_ID, VEHICLE_ID, DRIVER_ID are required for acceptFlow');
  }

  const res = http.post(
    `${BASE_URL}/api/v1/orders/accept`,
    JSON.stringify({ truckRequestId: TRUCK_REQUEST_ID, vehicleId: VEHICLE_ID, driverId: DRIVER_ID }),
    commonHeaders(TRANSPORTER_TOKEN)
  );

  check(res, {
    'accept status handles race/cancel': (r) => [200, 400, 404, 409].includes(r.status)
  });

  sleep(0.05);
}
