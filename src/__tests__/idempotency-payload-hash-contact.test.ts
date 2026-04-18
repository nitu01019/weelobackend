/**
 * =============================================================================
 * F-A-04 — buildRequestPayloadHash includes contact/payment/notes fields
 * =============================================================================
 *
 * Today the hash only fingerprints route + vehicle requirements + scheduling.
 * Two retries that share a key but differ ONLY in (contactPhone | contactName |
 * paymentMode | notes) collapse onto the cached response, which is wrong: a
 * customer that retried with a corrected typo would never see the correction
 * propagate. Stripe / IETF idempotency-key §2 says a hash mismatch MUST 409.
 *
 * This test calls the same hash function used in the prod replay path and
 * asserts that two requests differing in ONE such field produce DIFFERENT
 * hashes. The behaviour is gated by FF_DB_STRICT_IDEMPOTENCY (already wired in
 * production); the hash function itself is unconditional.
 * =============================================================================
 */

// The hash helper lives on the OrderService class — re-exported through the
// module instance for unit testing. We import the singleton and reach the
// private method via index access (TypeScript erases types at runtime).
import { orderService } from '../modules/order/order.service';

type CreateOrderRequest = Parameters<typeof orderService.createOrder>[0];

function makeRequest(overrides: Partial<CreateOrderRequest> = {}): CreateOrderRequest {
  return {
    customerId: 'cust-1',
    customerName: 'Alice',
    customerPhone: '9876543210',
    routePoints: [
      { type: 'PICKUP', latitude: 12.97, longitude: 77.59, address: 'BLR' },
      { type: 'DROP', latitude: 13.07, longitude: 77.71, address: 'WHF' }
    ],
    distanceKm: 12.4,
    vehicleRequirements: [
      { vehicleType: 'tipper', vehicleSubtype: '20-24 Ton', quantity: 1, pricePerTruck: 5000 }
    ],
    goodsType: 'sand',
    cargoWeightKg: 18000,
    ...overrides
  } as CreateOrderRequest;
}

function hashOf(req: CreateOrderRequest): string {
  // buildRequestPayloadHash is private; reach it via index access.
  return (orderService as any).buildRequestPayloadHash(req);
}

describe('F-A-04 — buildRequestPayloadHash distinguishes contact/payment/notes', () => {
  it('different contactPhone => different hash', () => {
    const a = hashOf(makeRequest({ contactPhone: '9876543210' } as any));
    const b = hashOf(makeRequest({ contactPhone: '9999999999' } as any));
    expect(a).not.toBe(b);
  });

  it('different contactName => different hash', () => {
    const a = hashOf(makeRequest({ contactName: 'Alice' } as any));
    const b = hashOf(makeRequest({ contactName: 'Bob' } as any));
    expect(a).not.toBe(b);
  });

  it('different paymentMode => different hash', () => {
    const a = hashOf(makeRequest({ paymentMode: 'CASH' } as any));
    const b = hashOf(makeRequest({ paymentMode: 'UPI' } as any));
    expect(a).not.toBe(b);
  });

  it('different notes => different hash', () => {
    const a = hashOf(makeRequest({ notes: 'fragile' } as any));
    const b = hashOf(makeRequest({ notes: 'urgent' } as any));
    expect(a).not.toBe(b);
  });

  it('whitespace and case normalisation: same hash', () => {
    const a = hashOf(makeRequest({ contactName: 'Alice', contactPhone: '9876543210', paymentMode: 'cash', notes: 'fragile' } as any));
    const b = hashOf(makeRequest({ contactName: '  alice  ', contactPhone: '987-654-3210', paymentMode: 'CASH', notes: '  Fragile  ' } as any));
    expect(a).toBe(b);
  });

  it('omitting all four fields matches request with empty/undefined values', () => {
    const a = hashOf(makeRequest());
    const b = hashOf(makeRequest({ contactName: undefined, contactPhone: undefined, paymentMode: undefined, notes: undefined } as any));
    expect(a).toBe(b);
  });
});
