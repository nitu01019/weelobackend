/**
 * =============================================================================
 * BOOKING CONTEXT - Shared state object for createBooking pipeline
 * =============================================================================
 *
 * Holds all mutable state that flows between the extracted sub-methods of
 * createBooking(). Passed by reference so each phase can read/write without
 * returning multiple values.
 *
 * Pattern: Orchestrator + Context Object (Martin Fowler "Introduce Parameter Object")
 */

import { BookingRecord } from '../../shared/database/db';
import { CreateBookingInput } from './booking.schema';
import { CandidateTransporter } from '../order/progressive-radius-matcher';

/**
 * FIX #50: Properties that are set once at construction are readonly.
 * Pipeline-phase properties remain mutable because sub-methods need to
 * update them as the booking progresses through the create pipeline.
 * This is a deliberate trade-off: full immutability would require a
 * builder/copy pattern that adds complexity without proportional benefit
 * for a pipeline context object.
 */
export interface BookingContext {
  // --- Inputs (set once at the start, never mutated) ---
  readonly customerId: string;
  readonly customerPhone: string;
  readonly data: CreateBookingInput;
  readonly idempotencyKey?: string;

  // --- Backpressure (set once, toggled by acquire/release) ---
  readonly concurrencyKey: string;
  /** Whether Redis availability counter was decremented. Used for rollback on failure. */
  incremented: boolean;

  // --- Lock state (set once, toggled by acquire/release) ---
  /** Redis lock key for this booking creation. */
  readonly lockKey: string;
  /** Whether the distributed lock was successfully acquired. */
  lockAcquired: boolean;
  /** Unique lock owner ID (uuid). Set at context creation. Used as token for Redis lock acquire/release. */
  lockHolder: string;

  // --- Idempotency / dedup (computed once during pipeline) ---
  /** Redis idempotency key. Set during fingerprint generation. */
  dedupeKey: string;
  /** SHA256 hash of booking fingerprint for dedup. Set during fingerprint generation. */
  idempotencyHash: string;

  // --- Resolved values (computed once during pipeline) ---
  customerName: string;
  distanceSource: 'google' | 'client_fallback';
  clientDistanceKm: number;

  // --- Matching (populated by findMatchingTransporters) ---
  vehicleKey: string;
  /** Transporters matched by geo/vehicle criteria. Set by matching phase. */
  matchingTransporters: string[];
  skipProgressiveExpansion: boolean;
  step1Candidates: CandidateTransporter[];
  candidateMap: Map<string, { distanceKm: number; etaSeconds: number }>;
  cappedTransporters: string[];

  // --- Booking record (set once after persist) ---
  readonly bookingId: string;
  /** The created Booking record. Set after DB insert. */
  booking: BookingRecord | null;
  /** Booking expiration timestamp. Set after timeout setup. */
  expiresAt: string;

  // --- Result (set once at end of pipeline) ---
  /** If set, pipeline exits early with this pre-built response. */
  earlyReturn: (BookingRecord & { matchingTransportersCount: number; timeoutSeconds: number }) | null;
}
