/**
 * Phase 8 load seed helper.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000 CUSTOMER_TOKEN=... npx ts-node scripts/load/seed.ts
 */

type JsonRecord = Record<string, unknown>;

const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
const customerToken = process.env.CUSTOMER_TOKEN || '';

if (!customerToken) {
  throw new Error('CUSTOMER_TOKEN is required');
}

async function post(path: string, body: JsonRecord): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${customerToken}`,
      'Content-Type': 'application/json',
      'X-Load-Test-Run-Id': `seed-${Date.now()}`,
      'X-Trace-Id': `seed-${Date.now()}`
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // keep raw response for debugging
  }

  if (!response.ok) {
    throw new Error(`Seed call failed ${response.status}: ${text}`);
  }

  return json;
}

async function run(): Promise<void> {
  const orderPayload = {
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
    goodsType: 'Steel Rods',
    cargoWeightKg: 3000,
    vehicleRequirements: [
      {
        vehicleType: 'open',
        vehicleSubtype: '14ft',
        quantity: 1,
        pricePerTruck: 3200
      }
    ]
  };

  const createResult = await post('/api/v1/orders', orderPayload);
  const output = {
    orderId: createResult?.data?.order?.id || createResult?.data?.orderId,
    truckRequests: createResult?.data?.truckRequests || [],
    raw: createResult
  };

  if (!output.orderId) {
    throw new Error('Unable to resolve orderId from seed response');
  }

  const serialized = JSON.stringify(output, null, 2);
  const outputFile = process.env.OUTPUT_JSON;

  if (outputFile) {
    const fs = await import('fs');
    fs.writeFileSync(outputFile, serialized);
  }

  console.log(serialized);
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
