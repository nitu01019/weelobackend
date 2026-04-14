/**
 * =============================================================================
 * ORDER CREATE CONTEXT - Shared state object for createOrder pipeline
 * =============================================================================
 *
 * Holds all mutable state that flows between the extracted sub-methods of
 * createOrder(). Passed by reference so each phase can read/write without
 * returning multiple values.
 *
 * Pattern: Pipeline + Context Object (Martin Fowler "Introduce Parameter Object")
 */

import { TruckRequestRecord } from '../../shared/database/db';
import type { CreateOrderRequest, CreateOrderResponse } from './order-core-types';

export interface OrderCreateContext {
  // --- Input (set once at the start) ---
  readonly request: CreateOrderRequest;

  // --- Backpressure ---
  backpressureKey: string;
  maxConcurrentOrders: number;
  /** Fix #34/#73: Track whether Redis backpressure counter was incremented to prevent double-decrement.
   *  Optional for backward compat — defaults to false when not set. */
  redisBackpressureIncremented?: boolean;
  /** Fix #34/#73: Track whether in-memory backpressure counter was incremented to prevent double-decrement.
   *  Optional for backward compat — defaults to false when not set. */
  inMemoryBackpressureIncremented?: boolean;

  // --- Idempotency ---
  requestPayloadHash: string;

  // --- Lock state ---
  lockKey: string;
  lockAcquired: boolean;

  // --- Dedup ---
  dedupeKey: string;
  idempotencyHash: string;

  // --- Route & pricing ---
  distanceSource: 'google' | 'client_fallback';
  clientDistanceKm: number;
  totalAmount: number;
  totalTrucks: number;

  // --- Route points ---
  routePoints: Array<{
    type: 'PICKUP' | 'STOP' | 'DROP';
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
    stopIndex: number;
  }>;
  pickup: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };
  drop: {
    latitude: number;
    longitude: number;
    address: string;
    city?: string;
    state?: string;
  };

  // --- Order and truck requests ---
  orderId: string;
  expiresAt: string;
  truckRequests: TruckRequestRecord[];
  responseRequests: CreateOrderResponse['truckRequests'];

  // --- Dispatch state ---
  dispatchState: CreateOrderResponse['dispatchState'];
  dispatchReasonCode: string | undefined;
  dispatchAttempts: number;
  onlineCandidates: number;
  notifiedTransporters: number;

  // --- Result ---
  orderResponse: CreateOrderResponse | null;
  earlyReturn: CreateOrderResponse | null;
}
