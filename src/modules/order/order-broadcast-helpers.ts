/**
 * =============================================================================
 * ORDER BROADCAST HELPERS - Shared pure/key helpers
 * =============================================================================
 *
 * Single source of truth for helper functions previously duplicated across
 * order-broadcast.service.ts and order-broadcast-query.service.ts:
 *   - withEventMeta
 *   - notifiedTransportersKey
 *   - makeVehicleGroupKey
 *   - parseVehicleGroupKey
 *   - buildRequestsByType
 *   - chunkTransporterIds
 *
 * Both files now re-export from here to preserve existing import paths.
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { TruckRequestRecord } from '../../shared/database/db';
import { generateVehicleKey } from '../../shared/services/vehicle-key.service';

// ---------------------------------------------------------------------------
// Shared helpers (used by broadcast + lifecycle-outbox + dispatch-outbox)
// ---------------------------------------------------------------------------

/**
 * Add standard event metadata for correlation across logs, sockets and load tests.
 */
export function withEventMeta<T extends Record<string, unknown>>(payload: T, eventId?: string): T & { eventId: string; emittedAt: string } {
  return {
    ...payload,
    eventId: eventId || uuidv4(),
    emittedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

export function notifiedTransportersKey(orderId: string, vehicleType: string, vehicleSubtype: string): string {
  return `order:notified:transporters:${orderId}:${generateVehicleKey(vehicleType, vehicleSubtype)}`;
}

export function makeVehicleGroupKey(vehicleType: string, vehicleSubtype: string): string {
  return JSON.stringify([vehicleType, vehicleSubtype || '']);
}

export function parseVehicleGroupKey(groupKey: string): { vehicleType: string; vehicleSubtype: string } {
  try {
    const parsed = JSON.parse(groupKey);
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return {
        vehicleType: parsed[0],
        vehicleSubtype: parsed[1]
      };
    }
  } catch {
    // Legacy fallback below
  }

  const splitIndex = groupKey.indexOf('_');
  if (splitIndex === -1) {
    return { vehicleType: groupKey, vehicleSubtype: '' };
  }
  return {
    vehicleType: groupKey.slice(0, splitIndex),
    vehicleSubtype: groupKey.slice(splitIndex + 1)
  };
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

export function buildRequestsByType(requests: TruckRequestRecord[]): Map<string, TruckRequestRecord[]> {
  const requestsByType = new Map<string, TruckRequestRecord[]>();
  for (const request of requests) {
    const key = makeVehicleGroupKey(request.vehicleType, request.vehicleSubtype);
    if (!requestsByType.has(key)) {
      requestsByType.set(key, []);
    }
    requestsByType.get(key)!.push(request);
  }
  return requestsByType;
}

export function chunkTransporterIds(transporterIds: string[], chunkSize: number): string[][] {
  if (transporterIds.length <= chunkSize) {
    return [transporterIds];
  }
  const chunks: string[][] = [];
  for (let index = 0; index < transporterIds.length; index += chunkSize) {
    chunks.push(transporterIds.slice(index, index + chunkSize));
  }
  return chunks;
}
