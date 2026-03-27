/**
 * =============================================================================
 * ORDER PROGRESS TRACKING SERVICE - PRD 7777 Implementation
 * =============================================================================
 *
 * ORDER PROGRESS TRACKING:
 * - Tracks each truck assignment with driver details
 * - Real-time progress: "3/5 trucks confirmed"
 * - UI Transparency: Shows "+30s added" per driver
 * - Extension history for customer visibility
 *
 * CUSTOMER VIEW:
 * - Trucks assigned (X/Y trucks confirmed)
 * - Progress percentage
 * - Which drivers extended the timeout and by how much
 * - Time remaining on订单
 *
 * FLOW:
 * 1. Order created → Initialize progress tracking
 * 2. Driver confirms → Record progress event + extension
 * 3. Customer queries → Get current progress state
 * 4. Order completes → Final progress state
 *
 * @author Weelo Team
 * @version 1.0.0 (PRD 7777 Implementation)
 * =============================================================================
 */

import { prismaClient, TimeoutExtensionType } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';
import { redisService } from '../../shared/services/redis.service';
import { socketService } from '../../shared/services/socket.service';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Progress event data
 */
export interface ProgressEventData {
  id: string;
  orderId: string;
  driverId: string;
  driverName: string;
  extensionType: TimeoutExtensionType;
  addedSeconds: number;
  reason: string;
  trigger: string;
  assignmentId?: string;
  truckRequestId?: string;
  timestamp: Date;
}

/**
 * Order summary for customer view
 */
export interface OrderProgressSummary {
  orderId: string;
  trucksAssigned: number;
  trucksRemaining: number;
  trucksNeeded: number;
  progressPercent: number;
  timeExtendedBy: Array<{
    driverId: string;
    driverName: string;
    addedSeconds: number;
    timestamp: string;
    extensionType: TimeoutExtensionType;
  }>;
  orderTimeout: {
    timeoutSeconds: number;
    originalTimeoutSeconds: number;
    extendedBySeconds: number;
    extensionsCount: number;
    canExtend: boolean;
    lastProgressAt?: string;
  };
}

/**
 * Truck assignment detail
 */
export interface TruckAssignmentDetail {
  assignmentId: string;
  truckRequestId: string | null;
  vehicleId: string;
  vehicleNumber: string;
  vehicleType: string;
  driverId: string;
  driverName: string;
  driverPhone: string;
  tripId: string;
  status: string;
  reason: string | null;
  assignedAt: string;
  driverAcceptedAt: string | null;
  startedAt: string | null;
  canReassign: boolean;
}

// =============================================================================
// PROGRESS TRACKING SERVICE
// =============================================================================

class ProgressTrackingService {
  /**
   * Record a progress event (driver accepted, assigned, etc.)
   */
  async recordProgressEvent(event: {
    orderId: string;
    driverId: string;
    driverName: string;
    extensionType: TimeoutExtensionType;
    addedSeconds: number;
    reason: string;
    trigger: string;
    assignmentId?: string;
    truckRequestId?: string;
  }): Promise<void> {
    logger.info('[PROGRESS] Recording progress event', {
      orderId: event.orderId,
      driverId: event.driverId,
      extensionType: event.extensionType,
      addedSeconds: event.addedSeconds,
    });

    try {
      await prismaClient.progressEvent.create({
        data: {
          orderId: event.orderId,
          driverId: event.driverId,
          driverName: event.driverName,
          extensionType: event.extensionType,
          addedSeconds: event.addedSeconds,
          reason: event.reason,
          trigger: event.trigger,
          assignmentId: event.assignmentId,
          truckRequestId: event.truckRequestId,
          timestamp: new Date(),
        },
      });

      // Emit real-time progress update
      await socketService.emitToUser(event.orderId, 'order_progress_update', {
        orderId: event.orderId,
        progress: {
          driverId: event.driverId,
          driverName: event.driverName,
          addedSeconds: event.addedSeconds,
          timestamp: new Date().toISOString(),
        },
        message: `${event.driverName} accepted. +${event.addedSeconds}s added to timer.`,
      });

      logger.info('[PROGRESS] Progress event recorded', {
        orderId: event.orderId,
        driverId: event.driverId,
      });
    } catch (error: any) {
      logger.error('[PROGRESS] Failed to record progress event', {
        error: error.message,
        orderId: event.orderId,
      });
    }
  }

  /**
   * Get order progress for customer view
   */
  async getOrderProgress(orderId: string): Promise<OrderProgressSummary | null> {
    try {
      // Get order
      const order = await prismaClient.order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        return null;
      }

      // Get order timeout
      const orderTimeout = await prismaClient.orderTimeout.findUnique({
        where: { orderId },
      });

      // Get all progress events
      const progressEvents = await prismaClient.progressEvent.findMany({
        where: { orderId },
        orderBy: { timestamp: 'asc' },
      });

      // Calculate totals
      const trucksAssigned = order.trucksFilled || 0;
      const trucksNeeded = order.totalTrucks;
      const trucksRemaining = trucksNeeded - trucksAssigned;
      const progressPercent = Math.floor((trucksAssigned / trucksNeeded) * 100);

      // Format time extended by
      const timeExtendedBy = progressEvents.map((event) => ({
        driverId: event.driverId,
        driverName: event.driverName,
        addedSeconds: event.addedSeconds,
        timestamp: event.timestamp.toISOString(),
        extensionType: event.extensionType as TimeoutExtensionType,
      }));

      // Format order timeout info
      const orderTimeoutInfo = {
        timeoutSeconds: orderTimeout
          ? Math.floor((orderTimeout.baseTimeoutMs + orderTimeout.extendedMs) / 1000)
          : 120,
        originalTimeoutSeconds: orderTimeout
          ? Math.floor(orderTimeout.baseTimeoutMs / 1000)
          : 120,
        extendedBySeconds: orderTimeout
          ? Math.floor(orderTimeout.extendedMs / 1000)
          : 0,
        extensionsCount: progressEvents.length,
        canExtend: !orderTimeout || !orderTimeout.isExpired,
        lastProgressAt: orderTimeout?.lastProgressAt?.toISOString(),
      };

      return {
        orderId,
        trucksAssigned,
        trucksRemaining,
        trucksNeeded,
        progressPercent,
        timeExtendedBy,
        orderTimeout: orderTimeoutInfo,
      };
    } catch (error: any) {
      logger.error('[PROGRESS] Failed to get order progress', {
        error: error.message,
        orderId,
      });
      return null;
    }
  }

  /**
   * Get truck assignment details for an order
   */
  async getOrderAssignments(orderId: string): Promise<{
    orderId: string;
    assignments: TruckAssignmentDetail[];
  } | null> {
    try {
      // Get assignments for this order
      const assignments = await prismaClient.assignment.findMany({
        where: {
          OR: [
            { orderId },
            { bookingId: orderId },
          ],
          status: {
            in: ['pending', 'driver_accepted', 'driver_declined', 'en_route_pickup', 'at_pickup', 'in_transit']
          },
        },
        include: {
          driver: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
          vehicle: {
            select: {
              id: true,
              vehicleNumber: true,
              vehicleType: true,
            },
          },
        },
      });

      const reasonEntries = await Promise.all(
        assignments.map(async (assignment) => [
          assignment.id,
          await redisService.get(`assignment:reason:${assignment.id}`).catch(() => null)
        ] as const)
      );
      const reasonMap = new Map(reasonEntries);

      const assignmentDetails: TruckAssignmentDetail[] = assignments.map((a) => ({
        assignmentId: a.id,
        truckRequestId: a.truckRequestId,
        vehicleId: a.vehicle.id,
        vehicleNumber: a.vehicle.vehicleNumber,
        vehicleType: a.vehicle.vehicleType,
        driverId: a.driver.id,
        driverName: a.driver.name,
        driverPhone: a.driver.phone,
        tripId: a.tripId,
        assignedAt: a.assignedAt,
        status: a.status,
        reason: reasonMap.get(a.id) ?? (a.status === 'driver_declined' ? 'declined' : null),
        driverAcceptedAt: a.driverAcceptedAt,
        startedAt: a.startedAt,
        canReassign: a.status === 'driver_declined',
      }));

      return {
        orderId,
        assignments: assignmentDetails,
      };
    } catch (error: any) {
      logger.error('[PROGRESS] Failed to get order assignments', {
        error: error.message,
        orderId,
      });
      return null;
    }
  }

  /**
   * Get transporter broadcast view (partial assignment visibility)
   */
  async getTransporterBroadcastView(
    broadcastId: string,
    transporterId: string
  ): Promise<{
    broadcastId: string;
    vehicleType: string;
    vehicleSubtype: string;
    trucksNeeded: number;
    trucksAssigned: number;
    trucksRemaining: number;
  } | null> {
    try {
      const view = await prismaClient.transporterBroadcastView.findUnique({
        where: {
          broadcastId_transporterId: {
            broadcastId,
            transporterId,
          },
        },
      });

      if (!view) {
        return null;
      }

      return {
        broadcastId: view.broadcastId,
        vehicleType: view.vehicleType,
        vehicleSubtype: view.vehicleSubtype,
        trucksNeeded: view.trucksNeeded,
        trucksAssigned: view.trucksAssigned,
        trucksRemaining: view.trucksRemaining,
      };
    } catch (error: any) {
      logger.error('[PROGRESS] Failed to get transporter broadcast view', {
        error: error.message,
        broadcastId,
        transporterId,
      });
      return null;
    }
  }

  /**
   * Update transporter broadcast view (called when trucks are confirmed)
   */
  async updateTransporterBroadcastView(params: {
    broadcastId: string;
    vehicleType: string;
    vehicleSubtype: string;
    trucksNeeded: number;
    trucksAssigned: number;
    trucksRemaining: number;
    assignedByOthers?: any;
  }): Promise<void> {
    try {
      // Update all views for this broadcast
      const existingViews = await prismaClient.transporterBroadcastView.findMany({
        where: { broadcastId: params.broadcastId },
      });

      for (const view of existingViews) {
        await prismaClient.transporterBroadcastView.update({
          where: { id: view.id },
          data: {
            trucksAssigned: params.trucksAssigned,
            trucksRemaining: params.trucksRemaining,
            assignedByOthers: params.assignedByOthers,
            lastUpdateAt: new Date(),
          },
        });
      }

      logger.info('[PROGRESS] Updated transporter broadcast views', {
        broadcastId: params.broadcastId,
        trucksRemaining: params.trucksRemaining,
        viewsUpdated: existingViews.length,
      });
    } catch (error: any) {
      logger.error('[PROGRESS] Failed to update transporter broadcast view', {
        error: error.message,
        broadcastId: params.broadcastId,
      });
    }
  }
}

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const progressTrackingService = new ProgressTrackingService();
