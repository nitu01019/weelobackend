/**
 * =============================================================================
 * BROADCAST QUERY SERVICE — getBroadcasts, feeds, status queries
 * =============================================================================
 * Extracted from broadcast.service.ts for modularity.
 * =============================================================================
 */

import { db, BookingRecord, VehicleRecord, OrderRecord } from '../../shared/database/db';
import { logger } from '../../shared/services/logger.service';
import { SocketEvent } from '../../shared/services/socket.service';
import { redisService } from '../../shared/services/redis.service';
import { prismaClient } from '../../shared/database/prisma.service';
import { safeJsonParse } from '../../shared/utils/safe-json.utils';

export const BroadcastEvents = {
  BROADCAST_EXPIRED: SocketEvent.BROADCAST_EXPIRED,
  BROADCAST_FULLY_FILLED: SocketEvent.BOOKING_FULLY_FILLED,
  BROADCAST_CANCELLED: SocketEvent.BROADCAST_CANCELLED,
  TRUCKS_REMAINING_UPDATE: SocketEvent.TRUCKS_REMAINING_UPDATE,
  NEW_BROADCAST: SocketEvent.NEW_BROADCAST,
};

interface GetActiveBroadcastsParams {
  actorId: string;
  vehicleType?: string;
  maxDistance?: number;
}

interface GetHistoryParams {
  actorId: string;
  page: number;
  limit: number;
  status?: string;
}

export async function getActiveBroadcasts(params: GetActiveBroadcastsParams) {
  const { actorId, vehicleType } = params;
  logger.info('[BroadcastCompat] Resolving active feed via legacy broadcast service', { route_alias_used: true, actorId });

  const user = await db.getUserById(actorId);
  const transporterId = user?.transporterId || actorId;

  const cacheKey = `cache:broadcasts:${transporterId}`;
  try {
    const cached = await redisService.get(cacheKey) as string | null;
    if (cached) {
      const parsed = safeJsonParse<unknown[]>(cached, []);
      if (parsed.length > 0) {
        logger.debug(`[BroadcastCompat] Cache HIT for transporter ${transporterId}`);
        return parsed;
      }
    }
  } catch { /* graceful degradation */ }

  const transporterVehicles: VehicleRecord[] = await db.getVehiclesByTransporter(transporterId);
  const transporterVehicleTypes = new Set(
    transporterVehicles.map((v) => `${v.vehicleType.toLowerCase()}_${(v.vehicleSubtype || '').toLowerCase()}`)
  );
  const transporterTypesList = [...new Set(transporterVehicles.map((v) => v.vehicleType.toLowerCase()))];

  logger.info(`Transporter ${transporterId} has vehicle types: ${transporterTypesList.join(', ')}`);

  const activeBroadcasts: unknown[] = [];

  // Legacy Bookings
  const bookings = await db.getActiveBookingsForTransporter(transporterId);
  for (const booking of bookings) {
    if (vehicleType && booking.vehicleType.toLowerCase() !== vehicleType.toLowerCase()) continue;
    if (new Date(booking.expiresAt) < new Date()) continue;
    if (booking.trucksFilled >= booking.trucksNeeded) continue;
    if (!transporterTypesList.includes(booking.vehicleType.toLowerCase())) continue;
    activeBroadcasts.push(mapBookingToBroadcast(booking));
  }

  // New Orders (Multi-Vehicle)
  const orders: OrderRecord[] = db.getActiveOrders ? await db.getActiveOrders() : [];
  logger.info(`[Broadcasts] Found ${orders.length} active orders`);

  const validOrders = orders.filter((order) => {
    if (new Date(order.expiresAt) < new Date()) return false;
    if (order.trucksFilled >= order.totalTrucks) return false;
    return true;
  });
  const orderIds: string[] = validOrders.map((o) => o.id);
  const allTruckRequests = orderIds.length > 0
    ? await prismaClient.truckRequest.findMany({ where: { orderId: { in: orderIds } } })
    : [];

  const truckRequestsByOrderId = new Map<string, typeof allTruckRequests>();
  for (const tr of allTruckRequests) {
    const list = truckRequestsByOrderId.get(tr.orderId) || [];
    list.push(tr);
    truckRequestsByOrderId.set(tr.orderId, list);
  }

  logger.info(`[Broadcasts] Batch-loaded ${allTruckRequests.length} truck requests for ${validOrders.length} orders (2 queries)`);

  for (const order of validOrders) {
    const truckRequests = (truckRequestsByOrderId.get(order.id) || []).map(tr => ({
      ...tr, vehicleType: tr.vehicleType || '', vehicleSubtype: tr.vehicleSubtype || '', status: tr.status || 'searching'
    }));

    const relevantRequests = truckRequests.filter(tr => {
      const typeKey = `${tr.vehicleType.toLowerCase()}_${(tr.vehicleSubtype || '').toLowerCase()}`;
      return transporterVehicleTypes.has(typeKey) || transporterTypesList.includes(tr.vehicleType.toLowerCase());
    });

    if (relevantRequests.length === 0) continue;

    const requestedVehiclesMap = new Map<string, any>();
    for (const tr of relevantRequests) {
      const key = `${tr.vehicleType}_${tr.vehicleSubtype}`;
      if (!requestedVehiclesMap.has(key)) {
        requestedVehiclesMap.set(key, {
          vehicleType: tr.vehicleType, vehicleSubtype: tr.vehicleSubtype || '',
          count: 0, filledCount: 0, farePerTruck: tr.pricePerTruck, capacityTons: 0
        });
      }
      const entry = requestedVehiclesMap.get(key)!;
      entry.count += 1;
      if (tr.status === 'assigned' || tr.status === 'completed') entry.filledCount += 1;
    }

    const requestedVehicles = Array.from(requestedVehiclesMap.values());
    const totalNeeded = requestedVehicles.reduce((sum, rv) => sum + rv.count, 0);
    const totalFilled = requestedVehicles.reduce((sum, rv) => sum + rv.filledCount, 0);
    const totalFare = requestedVehicles.reduce((sum, rv) => sum + (rv.count * rv.farePerTruck), 0);
    const avgFarePerTruck = totalNeeded > 0 ? totalFare / totalNeeded : 0;

    activeBroadcasts.push({
      broadcastId: order.id,
      customerId: order.customerId,
      customerName: order.customerName || 'Customer',
      customerMobile: '',
      pickupLocation: { latitude: order.pickup.latitude, longitude: order.pickup.longitude, address: order.pickup.address, city: order.pickup.city, state: order.pickup.state },
      dropLocation: { latitude: order.drop.latitude, longitude: order.drop.longitude, address: order.drop.address, city: order.drop.city, state: order.drop.state },
      distance: order.distanceKm || 0,
      estimatedDuration: Math.round((order.distanceKm || 100) * 1.5),
      requestedVehicles,
      totalTrucksNeeded: totalNeeded,
      trucksFilledSoFar: totalFilled,
      vehicleType: requestedVehicles[0]?.vehicleType || '',
      vehicleSubtype: requestedVehicles[0]?.vehicleSubtype || '',
      goodsType: order.goodsType || 'General',
      weight: order.cargoWeightKg ? `${order.cargoWeightKg} kg` : 'N/A',
      farePerTruck: avgFarePerTruck,
      totalFare,
      status: order.status,
      isUrgent: false,
      createdAt: order.createdAt,
      expiresAt: order.expiresAt
    });
  }

  logger.info(`Found ${activeBroadcasts.length} active broadcasts for transporter ${transporterId}`);

  try { await redisService.set(cacheKey, JSON.stringify(activeBroadcasts), 5); } catch { /* non-critical */ }

  return activeBroadcasts;
}

export async function getBroadcastById(broadcastId: string) {
  const booking = await db.getBookingById(broadcastId);
  if (!booking) throw new Error('Broadcast not found');
  return mapBookingToBroadcast(booking);
}

export async function getBroadcastHistory(params: GetHistoryParams) {
  const { actorId, page, limit, status } = params;
  let bookings = await db.getBookingsByDriver(actorId);
  if (status) bookings = bookings.filter((b: BookingRecord) => b.status === status);
  const total = bookings.length;
  const pages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const paginatedBookings = bookings.slice(start, start + limit);

  return {
    broadcasts: paginatedBookings.map((b: BookingRecord) => mapBookingToBroadcast(b)),
    pagination: { page, limit, total, pages }
  };
}

export function mapBookingToBroadcast(booking: BookingRecord) {
  const { getSubtypeConfig } = require('../pricing/vehicle-catalog');
  const subtypeConfig = getSubtypeConfig(booking.vehicleType, booking.vehicleSubtype);
  const capacityTons = subtypeConfig ? subtypeConfig.capacityKg / 1000 : 0;

  const requestedVehicles = [{
    vehicleType: booking.vehicleType,
    vehicleSubtype: booking.vehicleSubtype || '',
    count: booking.trucksNeeded,
    filledCount: booking.trucksFilled || 0,
    farePerTruck: booking.pricePerTruck,
    capacityTons
  }];

  return {
    broadcastId: booking.id,
    customerId: booking.customerId,
    customerName: booking.customerName || 'Customer',
    customerMobile: '',
    pickupLocation: booking.pickup,
    dropLocation: booking.drop,
    distance: booking.distanceKm || 0,
    estimatedDuration: Math.round((booking.distanceKm || 100) * 1.5),
    requestedVehicles,
    totalTrucksNeeded: booking.trucksNeeded,
    trucksFilledSoFar: booking.trucksFilled || 0,
    vehicleType: booking.vehicleType,
    vehicleSubtype: booking.vehicleSubtype,
    goodsType: booking.goodsType || 'General',
    weight: booking.weight || 'N/A',
    farePerTruck: booking.pricePerTruck,
    totalFare: booking.totalAmount,
    status: booking.status,
    isUrgent: false,
    createdAt: booking.createdAt,
    expiresAt: booking.expiresAt,
    capacityInfo: subtypeConfig ? {
      capacityKg: subtypeConfig.capacityKg,
      capacityTons,
      minTonnage: subtypeConfig.minTonnage,
      maxTonnage: subtypeConfig.maxTonnage
    } : null
  };
}
