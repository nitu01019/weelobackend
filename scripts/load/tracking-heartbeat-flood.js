import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3000';
const DRIVER_TOKEN = __ENV.DRIVER_TOKEN || '';
const TRIP_ID = __ENV.TRIP_ID || '';
const RUN_ID = __ENV.LOAD_TEST_RUN_ID || `phase8-tracking-${Date.now()}`;
const TRACKING_RATE = Number(__ENV.TRACKING_RATE || 250);
const TRACKING_DURATION = __ENV.DURATION || '2m';
const TRACKING_PREALLOC = Number(__ENV.TRACKING_PREALLOCATED_VUS || 100);
const TRACKING_MAX_VUS = Number(__ENV.TRACKING_MAX_VUS || 1000);
const LAT_BASE = Number(__ENV.TRACKING_LAT_BASE || 12.9716);
const LNG_BASE = Number(__ENV.TRACKING_LNG_BASE || 77.5946);

if (!DRIVER_TOKEN || !TRIP_ID) {
  throw new Error('tracking-heartbeat-flood requires DRIVER_TOKEN and TRIP_ID');
}

export const options = {
  scenarios: {
    trackingFlood: {
      executor: 'constant-arrival-rate',
      rate: TRACKING_RATE,
      timeUnit: '1s',
      duration: TRACKING_DURATION,
      preAllocatedVUs: TRACKING_PREALLOC,
      maxVUs: TRACKING_MAX_VUS,
      exec: 'sendTrackingUpdate'
    }
  }
};

function jitter(scale) {
  return (Math.random() - 0.5) * scale;
}

function headers() {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DRIVER_TOKEN}`,
      'X-Load-Test-Run-Id': RUN_ID
    }
  };
}

export function sendTrackingUpdate() {
  const payload = {
    tripId: TRIP_ID,
    latitude: LAT_BASE + jitter(0.02),
    longitude: LNG_BASE + jitter(0.02),
    speed: Math.max(0, 8 + jitter(4)),
    bearing: Math.floor((Math.random() * 360)),
    accuracy: 12 + Math.floor(Math.random() * 10),
    timestamp: new Date().toISOString()
  };

  const res = http.post(`${BASE_URL}/api/v1/tracking/update`, JSON.stringify(payload), headers());
  check(res, {
    'tracking update accepted': (r) => r.status === 200
  });
  sleep(0.05);
}

