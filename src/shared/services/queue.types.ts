/**
 * =============================================================================
 * QUEUE TYPES — Shared types, interfaces, constants, and config
 * =============================================================================
 *
 * Extracted from queue.service.ts for file-size compliance.
 * All external consumers still import from queue.service.ts (facade).
 * Sub-modules import from this file DIRECTLY.
 * =============================================================================
 */

import { FLAGS, isEnabled } from '../config/feature-flags';

// =============================================================================
// TYPES
// =============================================================================

export interface QueueJob<T = any> {
  id: string;
  type: string;
  data: T;
  priority: number;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  processAfter?: number;
  processingStartedAt?: number; // DR-18 FIX: Set when worker picks up job for stale detection
  error?: string;
}

export type JobProcessor<T = any> = (job: QueueJob<T>) => Promise<void>;

export interface TrackingEventPayload {
  driverId: string;
  tripId: string;
  bookingId?: string;
  orderId?: string;
  latitude: number;
  longitude: number;
  speed: number;
  bearing: number;
  ts: string;
  source: 'gps' | 'batch_sync' | 'system';
}

// =============================================================================
// QUEUE INTERFACE (Unified type for both implementations)
// =============================================================================

export interface IQueue {
  add<T>(queueName: string, type: string, data: T, options?: { priority?: number; delay?: number; maxAttempts?: number }): Promise<string>;
  addBatch<T>(queueName: string, jobs: { type: string; data: T; priority?: number }[]): Promise<string[]>;
  process(queueName: string, processor: JobProcessor): void;
  start(): void;
  stop(): void;
  getStats(): unknown;
  getQueueDepth(queueName: string): Promise<number>;
}

// =============================================================================
// CONFIGURATION CONSTANTS
// =============================================================================

export const TRACKING_QUEUE_HARD_LIMIT = Math.max(1000, parseInt(process.env.TRACKING_QUEUE_HARD_LIMIT || '200000', 10) || 200000);

// M-6 FIX: Configurable DLQ cap (was hardcoded 1000, now defaults to 5000)
// Higher cap preserves more failed jobs for post-mortem debugging.
export const DLQ_MAX_SIZE = Math.max(100, parseInt(process.env.DLQ_MAX_SIZE || '5000', 10) || 5000);
export const TRACKING_QUEUE_DEPTH_SAMPLE_MS = Math.max(100, parseInt(process.env.TRACKING_QUEUE_DEPTH_SAMPLE_MS || '500', 10) || 500);
export const FF_CANCELLED_ORDER_QUEUE_GUARD = process.env.FF_CANCELLED_ORDER_QUEUE_GUARD !== 'false';
// FAIL-CLOSED by default: if guard lookup is ambiguous, we prefer dropping stale
// broadcast emissions to preserve cancellation correctness under race conditions.
export const FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN = process.env.FF_CANCELLED_ORDER_QUEUE_GUARD_FAIL_OPEN === 'true';
export const CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS = Math.max(
  250,
  parseInt(process.env.CANCELLED_ORDER_QUEUE_GUARD_CACHE_TTL_MS || '1500', 10) || 1500
);

// =============================================================================
// PHASE 4 — GUARANTEED DELIVERY FLAGS & CONFIG
// =============================================================================

// FIX #24: Centralized feature flags — single source of truth from feature-flags.ts
/** Sequence-numbered delivery + unacked queue + replay on reconnect */
export const FF_SEQUENCE_DELIVERY_ENABLED = isEnabled(FLAGS.SEQUENCE_DELIVERY_ENABLED);

/** Parallel Socket.IO + FCM delivery for every broadcast */
export const FF_DUAL_CHANNEL_DELIVERY = isEnabled(FLAGS.DUAL_CHANNEL_DELIVERY);

/** Message TTL enforcement — drop stale messages before emitting */
export const FF_MESSAGE_TTL_ENABLED = isEnabled(FLAGS.MESSAGE_TTL_ENABLED);

/** Priority drain order — CRITICAL(1) → HIGH(2) → NORMAL(3) → LOW(4) */
export const FF_MESSAGE_PRIORITY_ENABLED = isEnabled(FLAGS.MESSAGE_PRIORITY_ENABLED);

/** Unacked queue TTL in seconds (10 minutes — covers reconnect window) */
export const UNACKED_QUEUE_TTL_SECONDS = 600;

/** Message TTL per event type (milliseconds) */
export const MESSAGE_TTL_MS: Record<string, number> = {
  'new_broadcast': 90_000,          // 90s — order expires at 5 min but show only recent
  'new_truck_request': 90_000,      // 90s — same as new_broadcast
  'accept_confirmation': 60_000,    // 60s — must be instant; stale = confusing
  'order_cancelled': 300_000,       // 300s — must always arrive even on slow network
  'order_expired': 300_000,         // 300s — critical lifecycle event
  'trip_assigned': 120_000,         // 120s — driver must see this
  'booking_updated': 120_000,       // 120s — important update
  'trucks_remaining_update': 30_000 // 30s — informational only
};

/** Default TTL for events not in the map above */
export const DEFAULT_MESSAGE_TTL_MS = 120_000;

/** Priority levels for message ordering */
export const MessagePriority = {
  CRITICAL: 1, // order_cancelled, trip_cancelled, driver_timeout
  HIGH: 2,     // accept_confirmation, trip_assigned, booking_updated
  NORMAL: 3,   // new_broadcast, new_truck_request
  LOW: 4       // trucks_remaining_update, telemetry, driver_status_changed
} as const;

/** Map event types to priority levels */
export const EVENT_PRIORITY: Record<string, number> = {
  'order_cancelled': MessagePriority.CRITICAL,
  'order_expired': MessagePriority.CRITICAL,
  'trip_cancelled': MessagePriority.CRITICAL,
  'driver_timeout': MessagePriority.CRITICAL,
  'accept_confirmation': MessagePriority.HIGH,
  'trip_assigned': MessagePriority.HIGH,
  'booking_updated': MessagePriority.HIGH,
  'new_broadcast': MessagePriority.NORMAL,
  'new_truck_request': MessagePriority.NORMAL,
  'trucks_remaining_update': MessagePriority.LOW,
  'driver_status_changed': MessagePriority.LOW
};

/** Phase 5: Queue depth cap for broadcast backpressure */
export const FF_QUEUE_DEPTH_CAP = Math.max(
  100,
  parseInt(process.env.FF_QUEUE_DEPTH_CAP || '10000', 10) || 10000
);
