/**
 * =============================================================================
 * ORDER QUERY SERVICE - Read-only order query methods
 * =============================================================================
 *
 * Extracted from OrderService (Phase 1 of decomposition).
 * All methods are read-only database queries with zero side effects.
 * =============================================================================
 */

import { db, OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { prismaClient } from '../../shared/database/prisma.service';
import { AppError } from '../../shared/types/error.types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveTruckRequestOrderGroup {
  order: OrderRecord;
  requests: TruckRequestRecord[];
}

// ---------------------------------------------------------------------------
// Query Functions
// ---------------------------------------------------------------------------

/**
 * Get order details with all truck requests
 */
export async function getOrderDetailsQuery(orderId: string): Promise<(OrderRecord & { truckRequests: TruckRequestRecord[] }) | null> {
  const order = await db.getOrderById(orderId);
  if (!order) return null;

  const truckRequests = await db.getTruckRequestsByOrder(orderId);

  return {
    ...order,
    truckRequests
  };
}

/**
 * Get active truck requests for a transporter
 * Returns ONLY requests matching their vehicle types
 */
export async function getActiveRequestsForTransporterQuery(transporterId: string): Promise<TruckRequestRecord[]> {
  return await db.getActiveTruckRequestsForTransporter(transporterId);
}

/**
 * Get orders by customer
 */
export async function getOrdersByCustomerQuery(customerId: string): Promise<OrderRecord[]> {
  return await db.getOrdersByCustomer(customerId);
}

/**
 * Get order details and truck requests with role-aware access checks.
 */
export async function getOrderWithRequestsQuery(orderId: string, userId: string, userRole: string) {
  const order = await db.getOrderById(orderId);
  if (!order) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }

  const requests = await db.getTruckRequestsByOrder(orderId);

  if (userRole === 'customer' && order.customerId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Access denied');
  }

  if (userRole === 'transporter') {
    const canAccess = requests.some((request) => {
      const notified = request.notifiedTransporters || [];
      return notified.includes(userId) || request.assignedTransporterId === userId;
    });
    if (!canAccess) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }
  }

  if (userRole === 'driver') {
    const assignments = await prismaClient.assignment.findMany({
      where: { orderId },
      select: { driverId: true }
    });
    const canAccess = assignments.some((assignment) => assignment.driverId === userId);
    if (!canAccess) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }
  }

  return {
    order,
    requests,
    summary: {
      totalTrucks: order.totalTrucks,
      trucksFilled: order.trucksFilled,
      trucksSearching: requests.filter((request) => request.status === 'searching').length,
      trucksExpired: requests.filter((request) => request.status === 'expired').length
    }
  };
}

/**
 * Get active truck requests grouped by order for transporter control surfaces.
 */
export async function getActiveTruckRequestsForTransporterQuery(transporterId: string): Promise<ActiveTruckRequestOrderGroup[]> {
  const requests = await db.getActiveTruckRequestsForTransporter(transporterId);
  const byOrder = new Map<string, TruckRequestRecord[]>();

  for (const request of requests) {
    if (!byOrder.has(request.orderId)) {
      byOrder.set(request.orderId, []);
    }
    byOrder.get(request.orderId)!.push(request);
  }

  const orderIds = Array.from(byOrder.keys());
  const orders = await db.getOrdersByIds(orderIds);
  const orderById = new Map(orders.map(order => [order.id, order]));

  const grouped = Array.from(byOrder.entries()).map(([orderId, orderRequests]) => {
    const order = orderById.get(orderId);
    if (!order) return null;
    return {
      order,
      requests: orderRequests.sort((left, right) => left.requestNumber - right.requestNumber)
    };
  });

  return grouped
    .filter((entry): entry is ActiveTruckRequestOrderGroup => entry !== null)
    .sort((left, right) => {
      return new Date(right.order.createdAt).getTime() - new Date(left.order.createdAt).getTime();
    });
}

/**
 * Get customer orders with pagination and per-order request summary.
 *
 * H-4 FIX: Replaced N+1 query pattern (1 query for orders + N queries for
 * truck requests) with a single Prisma query using `include`. For a page of
 * 20 orders this reduces DB round-trips from 21 to 2 (count + findMany).
 * At 100k+ orders this prevents per-page query explosion.
 */
export async function getCustomerOrdersQuery(customerId: string, page: number = 1, limit: number = 20) {
  const boundedPage = Math.max(1, page);
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const offset = (boundedPage - 1) * boundedLimit;

  // Single query: count total orders for this customer
  const total = await prismaClient.order.count({ where: { customerId } });

  // Single query: fetch paginated orders WITH truck requests (eliminates N+1)
  const ordersWithRequests = await prismaClient.order.findMany({
    where: { customerId },
    include: {
      truckRequests: {
        select: {
          id: true,
          status: true,
        },
      },
    },
    take: boundedLimit,
    skip: offset,
    orderBy: { createdAt: 'desc' },
  });

  // Map Prisma models to OrderRecord shape + requestsSummary
  const ordersWithSummary = ordersWithRequests.map((order) => {
    const { truckRequests, ...orderData } = order;

    // Parse JSON fields the same way PrismaDatabaseService.toOrderRecord does
    const parseJsonField = <T>(value: unknown): T => {
      if (value === null || value === undefined) return value as T;
      if (typeof value === 'string') {
        try { return JSON.parse(value) as T; } catch { return value as T; }
      }
      return value as T;
    };

    const orderRecord: OrderRecord = {
      ...orderData,
      routePoints: parseJsonField(orderData.routePoints) || [],
      stopWaitTimers: parseJsonField(orderData.stopWaitTimers) || [],
      pickup: parseJsonField(orderData.pickup),
      drop: parseJsonField(orderData.drop),
      status: orderData.status as OrderRecord['status'],
      dispatchState: (orderData.dispatchState || 'queued') as OrderRecord['dispatchState'],
      dispatchAttempts: typeof orderData.dispatchAttempts === 'number' ? orderData.dispatchAttempts : 0,
      dispatchReasonCode: orderData.dispatchReasonCode || null,
      onlineCandidatesCount: typeof orderData.onlineCandidatesCount === 'number' ? orderData.onlineCandidatesCount : 0,
      notifiedCount: typeof orderData.notifiedCount === 'number' ? orderData.notifiedCount : 0,
      lastDispatchAt: orderData.lastDispatchAt ? new Date(orderData.lastDispatchAt).toISOString() : null,
      createdAt: orderData.createdAt.toISOString(),
      updatedAt: orderData.updatedAt.toISOString(),
    };

    return {
      ...orderRecord,
      requestsSummary: {
        total: truckRequests.length,
        searching: truckRequests.filter((r) => r.status === 'searching').length,
        assigned: truckRequests.filter((r) => r.status === 'assigned').length,
        completed: truckRequests.filter((r) => r.status === 'completed').length,
        expired: truckRequests.filter((r) => r.status === 'expired').length,
      },
    };
  });

  return {
    orders: ordersWithSummary,
    total,
    hasMore: offset + ordersWithSummary.length < total,
  };
}
