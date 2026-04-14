/**
 * =============================================================================
 * TRUCK HOLD QUERY — Availability, Active Hold, and Broadcast
 * =============================================================================
 *
 * Handles:
 * - getOrderAvailability(): Real-time truck availability for an order
 * - getMyActiveHold(): Recovery endpoint for uncertain network responses
 * - getAvailableTruckRequests(): Internal helper for searching trucks
 * - broadcastAvailabilityUpdate(): Personalized real-time updates via WebSocket
 */

import { db } from '../../shared/database/db';
import type { TruckRequestRecord } from '../../shared/database/record-types';
import { logger } from '../../shared/services/logger.service';
import { socketService } from '../../shared/services/socket.service';
import { queueService } from '../../shared/services/queue.service';
import {
  TruckAvailability,
  OrderAvailability,
} from './truck-hold.types';
import { normalizeVehiclePart, findActiveLedgerHold } from './truck-hold-create.service';
import { maskPhoneForExternal } from '../../shared/utils/pii.utils';

// =============================================================================
// GET ORDER AVAILABILITY
// =============================================================================

/**
 * GET ORDER AVAILABILITY
 * ----------------------
 * Returns current availability of all truck types for an order.
 * Used by app to show real-time counts.
 *
 * @param orderId - The order ID
 * @returns OrderAvailability with truck counts
 */
export async function getOrderAvailability(orderId: string): Promise<OrderAvailability | null> {
  try {
    const order = await db.getOrderById(orderId);
    if (!order) {
      logger.warn(`[TruckHold] Order not found: ${orderId}`);
      return null;
    }

    const truckRequests = db.getTruckRequestsByOrder ? await db.getTruckRequestsByOrder(orderId) : [];

    // Group by vehicle type
    const truckGroups = new Map<string, {
      requests: TruckRequestRecord[];
      farePerTruck: number;
    }>();

    for (const tr of truckRequests) {
      const key = `${tr.vehicleType}_${tr.vehicleSubtype || ''}`;
      if (!truckGroups.has(key)) {
        truckGroups.set(key, {
          requests: [],
          farePerTruck: tr.pricePerTruck
        });
      }
      truckGroups.get(key)!.requests.push(tr);
    }

    // Calculate availability for each type
    const trucks: TruckAvailability[] = [];
    let totalValue = 0;

    for (const [key, group] of truckGroups) {
      const [vehicleType, vehicleSubtype] = key.split('_');

      const available = group.requests.filter(r => r.status === 'searching').length;
      const held = group.requests.filter(r => r.status === 'held').length;
      const assigned = group.requests.filter(r => r.status === 'assigned' || r.status === 'completed').length;

      trucks.push({
        vehicleType,
        vehicleSubtype: vehicleSubtype || '',
        totalNeeded: group.requests.length,
        available,
        held,
        assigned,
        farePerTruck: group.farePerTruck
      });

      totalValue += group.requests.length * group.farePerTruck;
    }

    const isFullyAssigned = trucks.every(t => t.available === 0 && t.held === 0);

    return {
      orderId,
      customerName: order.customerName || 'Customer',
      customerPhone: maskPhoneForExternal(order.customerPhone),
      pickup: order.pickup,
      drop: order.drop,
      distanceKm: order.distanceKm || 0,
      goodsType: order.goodsType || 'General',
      trucks,
      totalValue,
      isFullyAssigned
    };

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[TruckHold] Error getting availability: ${message}`, error);
    return null;
  }
}

// =============================================================================
// GET MY ACTIVE HOLD
// =============================================================================

export async function getMyActiveHold(
  transporterId: string,
  orderId: string,
  vehicleType: string,
  vehicleSubtype: string
): Promise<{
  holdId: string;
  orderId: string;
  vehicleType: string;
  vehicleSubtype: string;
  quantity: number;
  expiresAt: string;
  status: string;
} | null> {
  const hold = await findActiveLedgerHold(
    transporterId,
    orderId,
    normalizeVehiclePart(vehicleType),
    normalizeVehiclePart(vehicleSubtype)
  );
  if (!hold) return null;
  return {
    holdId: hold.holdId,
    orderId: hold.orderId,
    vehicleType: hold.vehicleType,
    vehicleSubtype: hold.vehicleSubtype,
    quantity: hold.quantity,
    expiresAt: hold.expiresAt.toISOString(),
    status: hold.status
  };
}

// =============================================================================
// GET AVAILABLE TRUCK REQUESTS (internal helper)
// =============================================================================

/**
 * Get available (not held, not assigned) truck requests for a vehicle type
 */
export async function getAvailableTruckRequests(orderId: string, vehicleType: string, vehicleSubtype: string): Promise<TruckRequestRecord[]> {
  const allRequests: TruckRequestRecord[] = db.getTruckRequestsByOrder ? await db.getTruckRequestsByOrder(orderId) : [];

  return allRequests.filter((tr) =>
    tr.vehicleType.toLowerCase() === vehicleType.toLowerCase() &&
    (tr.vehicleSubtype || '').toLowerCase() === vehicleSubtype.toLowerCase() &&
    tr.status === 'searching'
  );
}

// =============================================================================
// BROADCAST AVAILABILITY UPDATE
// =============================================================================

/**
 * Broadcast availability update via WebSocket
 *
 * =========================================================================
 * PERSONALIZED REAL-TIME UPDATES
 * =========================================================================
 *
 * When trucks are accepted/held/released, we need to:
 * 1. Update ALL transporters viewing this order
 * 2. Each gets their PERSONALIZED trucksYouCanProvide
 * 3. If order is fully filled, close broadcast for everyone
 *
 * Example:
 *   Order needs 5 trucks, Transporter A accepts 2
 *   → Now needs 3 trucks
 *   → Transporter B (has 4 available) now sees "3 trucks" (was 4)
 *   → Transporter C (has 2 available) still sees "2 trucks" (unchanged)
 * =========================================================================
 */
export function broadcastAvailabilityUpdate(orderId: string): void {
  getOrderAvailability(orderId).then(async availability => {
    if (!availability) return;

    const order = await db.getOrderById(orderId);
    if (!order) return;

    logger.info(`╔══════════════════════════════════════════════════════════════╗`);
    logger.info(`║  📡 BROADCASTING AVAILABILITY UPDATE                         ║`);
    logger.info(`╠══════════════════════════════════════════════════════════════╣`);
    logger.info(`║  Order: ${orderId.length > 8 ? orderId.substring(0, 8) + '...' : orderId}`);
    logger.info(`║  Filled: ${order.trucksFilled}/${order.totalTrucks}`);
    logger.info(`║  Fully Assigned: ${availability.isFullyAssigned}`);
    logger.info(`╚══════════════════════════════════════════════════════════════╝`);

    // If fully assigned, broadcast closure to everyone
    if (availability.isFullyAssigned) {
      socketService.broadcastToAll('broadcast_closed', {
        orderId,
        reason: 'fully_assigned',
        message: 'All trucks have been assigned',
        timestamp: new Date().toISOString()
      });
      logger.info(`   📢 Broadcast closed - all trucks assigned`);
      return;
    }

    // Send personalized updates to each transporter
    // Get all transporters who were notified about this order
    const truckRequests = db.getTruckRequestsByOrder ? await db.getTruckRequestsByOrder(orderId) : [];
    const notifiedTransporterIds = new Set<string>();
    const queuedBroadcasts: Array<Promise<unknown>> = [];

    for (const tr of truckRequests) {
      if (tr.notifiedTransporters) {
        tr.notifiedTransporters.forEach((id: string) => notifiedTransporterIds.add(id));
      }
    }

    // H-19 FIX: Cap notified transporters to prevent latency spikes on availability updates
    const MAX_BROADCAST_TRANSPORTERS_HOLD = parseInt(process.env.MAX_BROADCAST_TRANSPORTERS || '100', 10);
    if (notifiedTransporterIds.size > MAX_BROADCAST_TRANSPORTERS_HOLD) {
      const allIds = Array.from(notifiedTransporterIds);
      logger.info(`[TruckHold] Capping availability update ${notifiedTransporterIds.size} -> ${MAX_BROADCAST_TRANSPORTERS_HOLD} transporters`);
      notifiedTransporterIds.clear();
      for (let i = 0; i < MAX_BROADCAST_TRANSPORTERS_HOLD; i++) {
        notifiedTransporterIds.add(allIds[i]);
      }
    }

    // For each vehicle type in the order, calculate personalized updates
    for (const truckType of availability.trucks) {
      const { vehicleType, vehicleSubtype, available: trucksStillSearching } = truckType;

      // Skip if no trucks searching for this type
      if (trucksStillSearching <= 0) continue;

      // Get availability snapshot for all transporters with this vehicle type
      // CRITICAL FIX: Must await — db is Prisma instance, this is async!
      const transporterSnapshot = await db.getTransportersAvailabilitySnapshot(vehicleType, vehicleSubtype) as Array<{
        transporterId: string;
        transporterName: string;
        totalOwned: number;
        available: number;
        inTransit: number;
      }>;

      // Create map for quick lookup
      const availabilityMap = new Map(
        transporterSnapshot.map(t => [t.transporterId, t])
      );

      // Send personalized update to each notified transporter
      for (const transporterId of notifiedTransporterIds) {
        const transporterAvailability = availabilityMap.get(transporterId);

        // Skip if this transporter doesn't have this vehicle type
        if (!transporterAvailability) continue;

        // Calculate personalized capacity
        const trucksYouCanProvide = Math.min(
          transporterAvailability.available,
          trucksStillSearching
        );

        // Skip if transporter has no available trucks
        if (trucksYouCanProvide <= 0) {
          // Notify them that they can't participate anymore
          queuedBroadcasts.push(queueService.queueBroadcast(transporterId, 'broadcast_update', {
            type: 'no_available_trucks',
            orderId,
            vehicleType,
            vehicleSubtype,
            trucksStillNeeded: trucksStillSearching,
            trucksYouCanProvide: 0,
            yourAvailableTrucks: transporterAvailability.available,
            message: 'You have no available trucks for this order',
            timestamp: new Date().toISOString()
          }).catch((error) => {
            logger.warn(`[TruckHold] Failed to queue no_available_trucks update for transporter ${transporterId}: ${String((error as Error)?.message || error)}`);
          }));
          continue;
        }

        // Send personalized update
        queuedBroadcasts.push(queueService.queueBroadcast(transporterId, 'broadcast_update', {
          type: 'availability_changed',
          orderId,
          vehicleType,
          vehicleSubtype,

          // Order progress
          totalTrucksNeeded: order.totalTrucks,
          trucksFilled: order.trucksFilled,
          trucksStillNeeded: trucksStillSearching,

          // Personalized for this transporter
          trucksYouCanProvide,
          maxTrucksYouCanProvide: trucksYouCanProvide,
          yourAvailableTrucks: transporterAvailability.available,
          yourTotalTrucks: transporterAvailability.totalOwned,

          // Full availability info
          trucks: availability.trucks,
          isFullyAssigned: availability.isFullyAssigned,

          timestamp: new Date().toISOString()
        }).catch((error) => {
          logger.warn(`[TruckHold] Failed to queue availability update for transporter ${transporterId}: ${String((error as Error)?.message || error)}`);
        }));

        logger.debug(`   📱 → ${transporterId.length > 8 ? transporterId.substring(0, 8) + '...' : transporterId}: can provide ${trucksYouCanProvide}/${trucksStillSearching}`);
      }
    }

    if (queuedBroadcasts.length > 0) {
      await Promise.allSettled(queuedBroadcasts);
    }

    // Also broadcast general update for any listeners (e.g., admin dashboard)
    socketService.broadcastToAll('trucks_availability_updated', {
      orderId,
      trucks: availability.trucks,
      isFullyAssigned: availability.isFullyAssigned,
      totalTrucksFilled: order.trucksFilled,
      totalTrucksNeeded: order.totalTrucks,
      timestamp: new Date().toISOString()
    });

    logger.info(`   ✅ Personalized updates sent to ${notifiedTransporterIds.size} transporters`);
  });
}
