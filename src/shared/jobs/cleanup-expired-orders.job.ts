/**
 * SCALABILITY: Automated cleanup job for expired orders (runs every 2 minutes)
 * EASY UNDERSTANDING: Simple cron job that expires old orders
 * MODULARITY: Independent scheduled job
 * SAME STANDARDS: Follows existing job patterns
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../services/logger.service';

const prisma = new PrismaClient();

/**
 * Cleanup expired orders - runs every 2 minutes
 * SCALABILITY: Prevents database bloat with millions of orders
 * MODULARITY: Can be called manually or via cron
 */
export async function cleanupExpiredOrders(): Promise<void> {
  try {
    const now = new Date();
    logger.info(`🧹 [CleanupJob] Starting expired orders cleanup at ${now.toISOString()}`);
    
    // Find all orders that have expired but status is not 'expired'
    const expiredOrders = await prisma.order.findMany({
      where: {
        status: { notIn: ['cancelled', 'completed', 'fully_filled', 'expired'] },
        expiresAt: { lte: now.toISOString() }
      },
      select: {
        id: true,
        customerId: true,
        expiresAt: true,
        status: true
      }
    });
    
    if (expiredOrders.length === 0) {
      logger.info(`✅ [CleanupJob] No expired orders found`);
      return;
    }
    
    logger.info(`🔄 [CleanupJob] Found ${expiredOrders.length} expired orders to clean up`);
    
    // Update orders to expired status
    const orderIds = expiredOrders.map(o => o.id);
    
    await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: { status: 'expired' }
    });
    
    // Update associated truck requests
    await prisma.truckRequest.updateMany({
      where: {
        orderId: { in: orderIds },
        status: { in: ['searching', 'held'] }
      },
      data: { status: 'expired' }
    });
    
    logger.info(`✅ [CleanupJob] Successfully expired ${expiredOrders.length} orders and their truck requests`);
    
    // Log details for debugging
    expiredOrders.forEach(order => {
      logger.info(`   - Order ${order.id}: customer ${order.customerId}, expired at ${order.expiresAt}`);
    });
    
  } catch (error) {
    logger.error(`❌ [CleanupJob] Error cleaning up expired orders: ${error}`);
  }
}

/**
 * Start the cleanup job with cron schedule
 * SCALABILITY: Runs every 2 minutes to keep database clean
 */
export function startCleanupJob(): void {
  logger.info('🚀 [CleanupJob] Starting automated cleanup job (every 2 minutes)');
  
  // Run immediately on startup
  cleanupExpiredOrders();
  
  // Then run every 2 minutes
  setInterval(() => {
    cleanupExpiredOrders();
  }, 2 * 60 * 1000); // 2 minutes in milliseconds
}
