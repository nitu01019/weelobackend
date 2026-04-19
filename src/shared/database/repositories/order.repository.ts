/**
 * =============================================================================
 * ORDER REPOSITORY — Order CRUD + cursor pagination
 * =============================================================================
 */

import { OrderStatus, Prisma } from '@prisma/client';
import { getPrismaClient, sanitizeDbError, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../prisma-client';
import { toOrderRecord } from '../record-helpers';
import type { OrderRecord } from '../record-types';
import { logger } from '../../services/logger.service';

export async function createOrder(order: Omit<OrderRecord, 'createdAt' | 'updatedAt'>): Promise<OrderRecord> {
  const prisma = getPrismaClient();
  const created = await prisma.order.create({
    data: {
      ...order,
      routePoints: order.routePoints as unknown as Prisma.InputJsonValue,
      stopWaitTimers: order.stopWaitTimers as unknown as Prisma.InputJsonValue,
      pickup: order.pickup as unknown as Prisma.InputJsonValue,
      drop: order.drop as unknown as Prisma.InputJsonValue,
      status: order.status as OrderStatus,
    }
  });
  logger.info(`Order created: ${order.id} (${order.totalTrucks} trucks)`);
  return toOrderRecord(created);
}

export async function getOrderById(id: string): Promise<OrderRecord | undefined> {
  const prisma = getPrismaClient();
  const order = await prisma.order.findUnique({ where: { id } });
  return order ? toOrderRecord(order) : undefined;
}

export async function getOrdersByIds(ids: string[]): Promise<OrderRecord[]> {
  const prisma = getPrismaClient();
  const uniqueIds = Array.from(new Set(ids.map(id => id.trim()).filter(id => id.length > 0)));
  if (uniqueIds.length === 0) return [];
  const orders = await prisma.order.findMany({
    where: { id: { in: uniqueIds } }
  });
  return orders.map(o => toOrderRecord(o));
}

export async function getOrdersByCustomer(customerId: string, limit: number = DEFAULT_PAGE_SIZE): Promise<OrderRecord[]> {
  const prisma = getPrismaClient();
  const orders = await prisma.order.findMany({
    where: { customerId },
    take: Math.min(limit, MAX_PAGE_SIZE),
    orderBy: { createdAt: 'desc' }
  });
  return orders.map(o => toOrderRecord(o));
}

export async function getActiveOrderByCustomer(customerId: string): Promise<OrderRecord | undefined> {
  const prisma = getPrismaClient();
  const now = new Date();

  logger.info(`[getActiveOrderByCustomer] Checking for active order for customer: ${customerId}`);
  logger.info(`[getActiveOrderByCustomer] Current time: ${now.toISOString()}`);

  const expiredOrders = await prisma.order.findMany({
    where: {
      customerId,
      status: { notIn: ['cancelled', 'completed', 'fully_filled', 'expired'] },
      expiresAt: { lte: now.toISOString() }
    }
  });

  if (expiredOrders.length > 0) {
    const expiredIds = expiredOrders.map(o => o.id);
    logger.info(`[getActiveOrderByCustomer] Batch-expiring ${expiredOrders.length} orders: ${expiredIds.join(', ')}`);

    await prisma.order.updateMany({
      where: { id: { in: expiredIds } },
      data: { status: 'expired' }
    });

    await prisma.truckRequest.updateMany({
      where: {
        orderId: { in: expiredIds },
        status: { in: ['searching', 'held'] }
      },
      data: { status: 'expired' }
    });

    logger.info(`[getActiveOrderByCustomer] Expired ${expiredOrders.length} orders (batched)`);
  }

  const activeOrder = await prisma.order.findFirst({
    where: {
      customerId,
      status: { notIn: ['cancelled', 'completed', 'fully_filled', 'expired'] },
      expiresAt: { gt: now.toISOString() }
    },
    orderBy: {
      createdAt: 'desc'
    }
  });

  if (!activeOrder) {
    logger.info(`[getActiveOrderByCustomer] No active order found for customer: ${customerId}`);
    return undefined;
  }

  logger.warn(`[getActiveOrderByCustomer] Active order found: ${activeOrder.id}, expires at: ${activeOrder.expiresAt}`);
  return toOrderRecord(activeOrder);
}

export async function updateOrder(id: string, updates: Partial<OrderRecord>): Promise<OrderRecord> {
  const prisma = getPrismaClient();
  try {
    const { createdAt: _ca, updatedAt: _ua, ...data } = updates as Partial<OrderRecord> & { createdAt?: unknown; updatedAt?: unknown };
    const updated = await prisma.order.update({
      where: { id },
      data: {
        ...data,
        routePoints: data.routePoints ? data.routePoints as unknown as Prisma.InputJsonValue : undefined,
        stopWaitTimers: data.stopWaitTimers ? data.stopWaitTimers as unknown as Prisma.InputJsonValue : undefined,
        pickup: data.pickup ? data.pickup as unknown as Prisma.InputJsonValue : undefined,
        drop: data.drop ? data.drop as unknown as Prisma.InputJsonValue : undefined,
        status: data.status ? data.status as OrderStatus : undefined,
      }
    });
    return toOrderRecord(updated);
  } catch (error) {
    logger.error('DB operation failed', { operation: 'updateOrder', id, error: error instanceof Error ? sanitizeDbError(error.message) : String(error) });
    throw error;
  }
}

export async function getActiveOrders(options?: { cursor?: string; limit?: number }): Promise<OrderRecord[]> {
  const prisma = getPrismaClient();
  const now = new Date();
  const limit = Math.min(Math.max(1, options?.limit || 1000), 2000);

  const orders = await prisma.order.findMany({
    where: {
      status: { notIn: ['fully_filled', 'completed', 'cancelled'] },
      expiresAt: { gt: now.toISOString() }
    },
    take: limit,
    ...(options?.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    orderBy: { createdAt: 'desc' }
  });

  return orders
    .map(o => toOrderRecord(o))
    .filter(o => o.trucksFilled < o.totalTrucks);
}
