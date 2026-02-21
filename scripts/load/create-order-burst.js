import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3000';
const CUSTOMER_TOKEN = __ENV.CUSTOMER_TOKEN || '';
const RUN_ID = __ENV.LOAD_TEST_RUN_ID || `phase8-create-${Date.now()}`;

export const options = {
  scenarios: {
    create_order_burst: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 80),
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: Number(__ENV.PRE_ALLOCATED_VUS || 120),
      maxVUs: Number(__ENV.MAX_VUS || 300)
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.005'],
    http_req_duration: ['p(95)<500', 'p(99)<1200']
  }
};

function headers() {
  return {
    headers: {
      Authorization: `Bearer ${CUSTOMER_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Load-Test-Run-Id': RUN_ID,
      'X-Trace-Id': `${RUN_ID}-${__VU}-${__ITER}`
    }
  };
}

export default function () {
  if (!CUSTOMER_TOKEN) {
    throw new Error('CUSTOMER_TOKEN is required');
  }

  const payload = {
    pickup: {
      latitude: 28.6139,
      longitude: 77.209,
      address: 'Connaught Place, New Delhi'
    },
    drop: {
      latitude: 28.4595,
      longitude: 77.0266,
      address: 'Sector 29, Gurugram'
    },
    distanceKm: 38,
    goodsType: 'Cement Bags',
    cargoWeightKg: 4500,
    vehicleRequirements: [
      {
        vehicleType: 'open',
        vehicleSubtype: '14ft',
        quantity: 1,
        pricePerTruck: 3500
      }
    ]
  };

  const res = http.post(`${BASE_URL}/api/v1/orders`, JSON.stringify(payload), headers());

  check(res, {
    'create-order status is 201 or 400-active-order': (r) => r.status === 201 || r.status === 400,
    'response has json body': (r) => !!r.body
  });

  sleep(0.1);
}
