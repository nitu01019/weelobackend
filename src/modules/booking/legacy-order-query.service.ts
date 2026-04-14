/**
 * @deprecated Legacy booking order queries. See order.service.ts deprecation notice.
 *
 * Read-only query methods: get order with requests, get active truck requests
 * for a transporter, get customer orders with pagination.
 */

import { db, OrderRecord, TruckRequestRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';

// =============================================================================
// GET OPERATIONS
// =============================================================================

/**
 * Get order by ID with all truck requests
 */
export async function getOrderWithRequests(orderId: string, userId: string, userRole: string) {
  const order = await db.getOrderById(orderId);
  if (!order) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }

  // Access control
  if (userRole === 'customer' && order.customerId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Access denied');
  }

  const requests = await db.getTruckRequestsByOrder(orderId);

  return {
    order,
    requests,
    summary: {
      totalTrucks: order.totalTrucks,
      trucksFilled: order.trucksFilled,
      trucksSearching: requests.filter((r: TruckRequestRecord) => r.status === 'searching').length,
      trucksExpired: requests.filter((r: TruckRequestRecord) => r.status === 'expired').length
    }
  };
}

/**
 * Get active truck requests for transporter (only matching their vehicle types)
 */
export async function getActiveTruckRequestsForTransporter(transporterId: string) {
  const requests = await db.getActiveTruckRequestsForTransporter(transporterId);

  // Group by order for better UI
  const orderMap = new Map<string, { order: OrderRecord | undefined; requests: TruckRequestRecord[] }>();

  for (const request of requests) {
    if (!orderMap.has(request.orderId)) {
      orderMap.set(request.orderId, {
        order: await db.getOrderById(request.orderId),
        requests: []
      });
    }
    orderMap.get(request.orderId)!.requests.push(request);
  }

  return Array.from(orderMap.values()).filter(item => item.order);
}

/**
 * Get customer's orders
 */
export async function getCustomerOrders(customerId: string, page: number = 1, limit: number = 20) {
  const orders = await db.getOrdersByCustomer(customerId);

  // Sort by newest first
  orders.sort((a: OrderRecord, b: OrderRecord) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const total = orders.length;
  const start = (page - 1) * limit;
  const paginatedOrders = orders.slice(start, start + limit);

  // Include truck requests summary for each order
  const ordersWithSummary = await Promise.all(paginatedOrders.map(async (order: OrderRecord) => {
    const requests = await db.getTruckRequestsByOrder(order.id);
    return {
      ...order,
      requestsSummary: {
        total: requests.length,
        searching: requests.filter((r: TruckRequestRecord) => r.status === 'searching').length,
        assigned: requests.filter((r: TruckRequestRecord) => r.status === 'assigned').length,
        completed: requests.filter((r: TruckRequestRecord) => r.status === 'completed').length,
        expired: requests.filter((r: TruckRequestRecord) => r.status === 'expired').length
      }
    };
  }));

  return {
    orders: ordersWithSummary,
    total,
    hasMore: start + paginatedOrders.length < total
  };
}
