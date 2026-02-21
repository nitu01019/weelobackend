/**
 * Phase 8 load reset helper.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000 CUSTOMER_TOKEN=... ORDER_IDS=id1,id2 npx ts-node scripts/load/reset.ts
 */

const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
const customerToken = process.env.CUSTOMER_TOKEN || '';
const orderIds = (process.env.ORDER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!customerToken) {
  throw new Error('CUSTOMER_TOKEN is required');
}

if (orderIds.length === 0) {
  console.log('No ORDER_IDS provided. Nothing to reset.');
  process.exit(0);
}

async function cancelOrder(orderId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/orders/${orderId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${customerToken}`,
      'Content-Type': 'application/json',
      'X-Load-Test-Run-Id': `reset-${Date.now()}`,
      'X-Trace-Id': `reset-${Date.now()}`
    },
    body: JSON.stringify({ reason: 'phase8_reset' })
  });

  const body = await response.text();
  if (!response.ok) {
    console.warn(`[reset] cancel failed (${response.status}) for ${orderId}: ${body}`);
    return;
  }

  console.log(`[reset] cancelled ${orderId}`);
}

async function run(): Promise<void> {
  for (const orderId of orderIds) {
    await cancelOrder(orderId);
  }
}

run().catch((err) => {
  console.error('[reset] failed:', err);
  process.exit(1);
});
