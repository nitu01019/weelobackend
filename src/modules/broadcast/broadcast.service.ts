/**
 * =============================================================================
 * BROADCAST MODULE - SERVICE
 * =============================================================================
 * 
 * Business logic for broadcast management.
 * Broadcasts are booking requests sent to drivers/transporters.
 * 
 * =============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { db, BookingRecord, AssignmentRecord } from '../../shared/database/db';
import { AppError } from '../../shared/types/error.types';
import { logger } from '../../shared/services/logger.service';
import { emitToUser, emitToUsers, emitToRoom, emitToAllTransporters, emitToAll, SocketEvent } from '../../shared/services/socket.service';
import { sendPushNotification } from '../../shared/services/fcm.service';
import { redisService } from '../../shared/services/redis.service';
import { prismaClient, withDbTimeout } from '../../shared/database/prisma.service';

// =============================================================================
// BROADCAST EXPIRY EVENTS - For real-time timeout handling
// =============================================================================
// When a broadcast expires, we MUST notify ALL transporters immediately
// so they can remove it from their overlay/list. This prevents confusion
// where one transporter sees an expired broadcast while another doesn't.
// =============================================================================

/**
 * Socket events for broadcast lifecycle
 * These MUST match the events in captain app's SocketIOService.kt
 */
export const BroadcastEvents = {
  // Broadcast expired (timeout) - remove from all transporters
  BROADCAST_EXPIRED: 'broadcast_expired',
  // Broadcast fully filled - no more trucks needed
  BROADCAST_FULLY_FILLED: 'booking_fully_filled',
  // Broadcast cancelled by customer
  BROADCAST_CANCELLED: 'order_cancelled',
  // Real-time truck count update
  TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',
  // New broadcast notification
  NEW_BROADCAST: 'new_broadcast',
};

interface GetActiveBroadcastsParams {
  actorId: string;
  vehicleType?: string;
  maxDistance?: number;
}

interface AcceptBroadcastParams {
  driverId: string;
  vehicleId: string;
  estimatedArrival?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  actorUserId: string;
  actorRole: string;
  idempotencyKey?: string;
}

interface DeclineBroadcastParams {
  actorId: string;
  reason: string;
  notes?: string;
}

interface GetHistoryParams {
  actorId: string;
  page: number;
  limit: number;
  status?: string;
}

interface AcceptBroadcastResult {
  assignmentId: string;
  tripId: string;
  status: 'assigned';
  trucksConfirmed: number;
  totalTrucksNeeded: number;
  isFullyFilled: boolean;
  resultCode?: string;
  replayed?: boolean;
}

interface CreateBroadcastParams {
  transporterId: string;
  customerId: string;
  pickupLocation: {
    latitude: number;
    longitude: number;
    address: string;
    city: string;
    state: string;
    pincode: string;
  };
  dropLocation: {
    latitude: number;
    longitude: number;
    address: string;
    city: string;
    state: string;
    pincode: string;
  };
  vehicleType: string;
  vehicleSubtype?: string;
  totalTrucksNeeded: number;
  goodsType: string;
  weight: string;
  farePerTruck: number;
  isUrgent?: boolean;
  expiresAt?: string;
  preferredDriverIds?: string[];
}

class BroadcastService {
  private readonly acceptMetrics = {
    attempts: 0,
    success: 0,
    idempotentReplay: 0,
    lockContention: 0
  };

  private readonly acceptFailureMetrics: Record<string, number> = {};

  private incrementAcceptMetric(metric: keyof BroadcastService['acceptMetrics']): void {
    this.acceptMetrics[metric] += 1;
  }

  private incrementAcceptFailureMetric(code: string): void {
    this.acceptFailureMetrics[code] = (this.acceptFailureMetrics[code] || 0) + 1;
  }

  /**
   * Get active broadcasts for compatibility / migration path.
   * 
   * Returns BOTH:
   * 1. Legacy Bookings (single vehicle type)
   * 2. New Orders with multiple vehicle types (requestedVehicles array)
   * 
   * NOTE:
   * Canonical transporter feed should prefer /bookings/requests/active.
   * This compatibility service remains for fallback and older clients.
   */
  async getActiveBroadcasts(params: GetActiveBroadcastsParams) {
    const { actorId, vehicleType } = params;
    logger.info('[BroadcastCompat] Resolving active feed via legacy broadcast service', {
      route_alias_used: true,
      actorId
    });

    // Resolve transporter — actorId could be a driver or transporter
    const user = await db.getUserById(actorId);
    const transporterId = user?.transporterId || actorId;

    // ============== FIX 4: REDIS CACHE (5s TTL) ==============
    // Protects DB from polling storms: 50 transporters × refresh/10s = 300 reads/min
    // Cache reduces to ~60 reads/min with 5s TTL
    const cacheKey = `cache:broadcasts:${transporterId}`;
    try {
      const cached = await redisService.get(cacheKey) as string | null;
      if (cached) {
        logger.debug(`[BroadcastCompat] Cache HIT for transporter ${transporterId}`);
        return JSON.parse(cached);
      }
    } catch {
      // Redis down — fall through to DB query (graceful degradation)
    }

    // Get transporter's vehicle types for filtering
    const transporterVehicles = await db.getVehiclesByTransporter(transporterId);
    const transporterVehicleTypes = new Set(
      transporterVehicles.map(v => `${v.vehicleType.toLowerCase()}_${(v.vehicleSubtype || '').toLowerCase()}`)
    );
    const transporterTypesList = [...new Set(transporterVehicles.map(v => v.vehicleType.toLowerCase()))];

    logger.info(`Transporter ${transporterId} has vehicle types: ${transporterTypesList.join(', ')}`);

    const activeBroadcasts: any[] = [];

    // ============== 1. Get Legacy Bookings ==============
    const bookings = await db.getActiveBookingsForTransporter(transporterId);

    for (const booking of bookings) {
      // Filter by vehicle type if specified
      if (vehicleType && booking.vehicleType.toLowerCase() !== vehicleType.toLowerCase()) {
        continue;
      }

      // Check if not expired
      if (new Date(booking.expiresAt) < new Date()) {
        continue;
      }

      // Check if still needs trucks
      if (booking.trucksFilled >= booking.trucksNeeded) {
        continue;
      }

      // Check if transporter has matching vehicle type
      if (!transporterTypesList.includes(booking.vehicleType.toLowerCase())) {
        continue;
      }

      activeBroadcasts.push(this.mapBookingToBroadcast(booking));
    }

    // ============== 2. Get New Orders (Multi-Vehicle) ==============
    const orders = db.getActiveOrders ? await db.getActiveOrders() : [];

    logger.info(`[Broadcasts] Found ${orders.length} active orders`);

    // ============== FIX 3: BATCH QUERY (N+1 → 2 queries) ==============
    // Before: N orders × 1 getTruckRequestsByOrder() each = N+1 DB calls
    // After:  1 getActiveOrders() + 1 batch findMany() = 2 DB calls total
    const validOrders = orders.filter(order => {
      if (new Date(order.expiresAt) < new Date()) return false;
      if (order.trucksFilled >= order.totalTrucks) return false;
      return true;
    });
    const orderIds = validOrders.map(o => o.id);
    const allTruckRequests = orderIds.length > 0
      ? await prismaClient.truckRequest.findMany({ where: { orderId: { in: orderIds } } })
      : [];

    // Index by orderId for O(1) lookup in loop
    const truckRequestsByOrderId = new Map<string, typeof allTruckRequests>();
    for (const tr of allTruckRequests) {
      const list = truckRequestsByOrderId.get(tr.orderId) || [];
      list.push(tr);
      truckRequestsByOrderId.set(tr.orderId, list);
    }

    logger.info(`[Broadcasts] Batch-loaded ${allTruckRequests.length} truck requests for ${validOrders.length} orders (2 queries)`);

    for (const order of validOrders) {
      // Lookup from pre-fetched map (O(1), no DB call)
      const truckRequests = (truckRequestsByOrderId.get(order.id) || []).map(tr => ({
        ...tr,
        vehicleType: tr.vehicleType || '',
        vehicleSubtype: tr.vehicleSubtype || '',
        status: tr.status || 'searching'
      }));

      // Filter to only vehicle types the transporter has
      const relevantRequests = truckRequests.filter(tr => {
        const typeKey = `${tr.vehicleType.toLowerCase()}_${(tr.vehicleSubtype || '').toLowerCase()}`;
        return transporterVehicleTypes.has(typeKey) || transporterTypesList.includes(tr.vehicleType.toLowerCase());
      });

      if (relevantRequests.length === 0) {
        continue; // No matching vehicle types for this transporter
      }

      // Group by vehicle type to create requestedVehicles array
      const requestedVehiclesMap = new Map<string, any>();

      for (const tr of relevantRequests) {
        const key = `${tr.vehicleType}_${tr.vehicleSubtype}`;

        if (!requestedVehiclesMap.has(key)) {
          requestedVehiclesMap.set(key, {
            vehicleType: tr.vehicleType,
            vehicleSubtype: tr.vehicleSubtype || '',
            count: 0,
            filledCount: 0,
            farePerTruck: tr.pricePerTruck,
            capacityTons: 0 // Could be fetched from vehicle catalog
          });
        }

        const entry = requestedVehiclesMap.get(key)!;
        entry.count += 1;
        if (tr.status === 'assigned' || tr.status === 'completed') {
          entry.filledCount += 1;
        }
      }

      const requestedVehicles = Array.from(requestedVehiclesMap.values());

      logger.info(`[Broadcasts] Order ${order.id} grouped into ${requestedVehicles.length} vehicle types:`);
      requestedVehicles.forEach(rv => {
        logger.info(`[Broadcasts]   - ${rv.vehicleType}/${rv.vehicleSubtype}: ${rv.count} needed, ${rv.filledCount} filled`);
      });

      // Calculate totals from relevant requests only
      const totalNeeded = requestedVehicles.reduce((sum, rv) => sum + rv.count, 0);
      const totalFilled = requestedVehicles.reduce((sum, rv) => sum + rv.filledCount, 0);
      const totalFare = requestedVehicles.reduce((sum, rv) => sum + (rv.count * rv.farePerTruck), 0);
      const avgFarePerTruck = totalNeeded > 0 ? totalFare / totalNeeded : 0;

      // Build broadcast object with requestedVehicles
      activeBroadcasts.push({
        broadcastId: order.id,
        customerId: order.customerId,
        customerName: order.customerName || 'Customer',
        customerMobile: order.customerPhone || '',
        pickupLocation: {
          latitude: order.pickup.latitude,
          longitude: order.pickup.longitude,
          address: order.pickup.address,
          city: order.pickup.city,
          state: order.pickup.state
        },
        dropLocation: {
          latitude: order.drop.latitude,
          longitude: order.drop.longitude,
          address: order.drop.address,
          city: order.drop.city,
          state: order.drop.state
        },
        distance: order.distanceKm || 0,
        estimatedDuration: Math.round((order.distanceKm || 100) * 1.5),

        // Multi-truck support
        requestedVehicles: requestedVehicles,
        totalTrucksNeeded: totalNeeded,
        trucksFilledSoFar: totalFilled,

        // Legacy single type (first type for backward compat)
        vehicleType: requestedVehicles[0]?.vehicleType || '',
        vehicleSubtype: requestedVehicles[0]?.vehicleSubtype || '',

        goodsType: order.goodsType || 'General',
        weight: order.cargoWeightKg ? `${order.cargoWeightKg} kg` : 'N/A',
        farePerTruck: avgFarePerTruck,
        totalFare: totalFare,
        status: order.status,
        isUrgent: false,
        createdAt: order.createdAt,
        expiresAt: order.expiresAt
      });
    }

    logger.info(`Found ${activeBroadcasts.length} active broadcasts for transporter ${transporterId}`);

    // ============== FIX 4: Store in Redis cache (5s TTL) ==============
    try {
      await redisService.set(cacheKey, JSON.stringify(activeBroadcasts), 5);
    } catch {
      // Non-critical — next request will just re-query DB
    }

    return activeBroadcasts;
  }

  /**
   * Get broadcast by ID
   */
  async getBroadcastById(broadcastId: string) {
    const booking = await db.getBookingById(broadcastId);

    if (!booking) {
      throw new Error('Broadcast not found');
    }

    return this.mapBookingToBroadcast(booking);
  }

  /**
   * Accept a broadcast (assign driver/vehicle to booking)
   * 
   * FLOW:
   * 1. Validate booking is still available
   * 2. Create assignment record
   * 3. Update booking status
   * 4. Notify DRIVER via WebSocket + Push (trip assignment)
   * 5. Notify CUSTOMER via WebSocket (real-time confirmation)
   * 
   * SCALABILITY:
   * - Uses async notifications (non-blocking)
   * - Idempotent - safe to retry
   * - Transaction-safe with database
  */
  async acceptBroadcast(broadcastId: string, params: AcceptBroadcastParams): Promise<AcceptBroadcastResult> {
    const { driverId, vehicleId, idempotencyKey, actorUserId, actorRole, metadata } = params;
    const lockKey = `broadcast-accept:${broadcastId}`;
    const lockHolder = `${driverId}:${vehicleId}:${Date.now()}`;
    const idempotencyCacheKey = idempotencyKey
      ? `idem:broadcast:accept:${broadcastId}:${driverId}:${vehicleId}:${idempotencyKey}`
      : null;
    let lockAcquired = false;

    this.incrementAcceptMetric('attempts');
    logger.info('[BroadcastAccept] Attempt', {
      broadcastId,
      vehicleId,
      driverId,
      actorUserId,
      actorRole,
      metadataKeys: metadata ? Object.keys(metadata) : [],
      idempotencyKey: idempotencyKey || null
    });

    if (idempotencyCacheKey) {
      try {
        const cached = await redisService.getJSON<AcceptBroadcastResult>(idempotencyCacheKey);
        if (cached) {
          this.incrementAcceptMetric('idempotentReplay');
          logger.info('[BroadcastAccept] Idempotent replay from cache', {
            broadcastId,
            vehicleId,
            driverId,
            resultCode: 'IDEMPOTENT_REPLAY'
          });
          return {
            ...cached,
            resultCode: 'IDEMPOTENT_REPLAY',
            replayed: true
          };
        }
      } catch (error: any) {
        logger.warn('[BroadcastAccept] Idempotency cache read failed', {
          broadcastId,
          vehicleId,
          driverId,
          error: error.message
        });
      }
    }

    try {
      // FIX 1: Lock TTL 8s → 20s — serializable tx + 3 retries can take >8s under load
      const lock = await redisService.acquireLock(lockKey, lockHolder, 20);
      lockAcquired = lock.acquired;
      if (!lockAcquired) {
        this.incrementAcceptMetric('lockContention');
        logger.warn('[BroadcastAccept] Lock contention — returning 429', {
          broadcastId,
          vehicleId,
          driverId
        });
        // FIX #8: Return retryable 429 instead of falling through to DB transaction.
        // Client already has idempotency key — safe to retry after 2s.
        // DB Serializable isolation is the safety net for Redis failures (catch block below).
        throw new AppError(429, 'LOCK_CONTENTION',
          'Another accept is being processed for this broadcast. Please retry in 2 seconds.');
      }
    } catch (error: any) {
      if (error instanceof AppError) throw error;  // Re-throw intentional 429
      logger.warn('[BroadcastAccept] Lock acquisition failed, proceeding with transactional safety', {
        broadcastId,
        vehicleId,
        driverId,
        error: error.message
      });
    }

    try {
      const activeStatuses = ['pending', 'driver_accepted', 'en_route_pickup', 'at_pickup', 'in_transit'] as const;
      const maxTransactionAttempts = 3;
      let txResult: any = null;

      for (let attempt = 1; attempt <= maxTransactionAttempts; attempt += 1) {
        try {
          txResult = await withDbTimeout(async (tx) => {
            const booking = await tx.booking.findUnique({ where: { id: broadcastId } });
            if (!booking) {
              throw new AppError(404, 'INVALID_ASSIGNMENT_STATE', 'Broadcast not found');
            }

            const actor = await tx.user.findUnique({ where: { id: actorUserId } });
            if (!actor || !actor.isActive) {
              throw new AppError(403, 'INVALID_ASSIGNMENT_STATE', 'Assignment actor is not active');
            }
            if (actorRole !== 'driver' && actorRole !== 'transporter') {
              throw new AppError(403, 'INVALID_ASSIGNMENT_STATE', 'Unsupported actor role for assignment');
            }
            if (actorRole === 'driver' && actor.id !== driverId) {
              throw new AppError(403, 'DRIVER_NOT_IN_FLEET', 'Drivers can only assign themselves');
            }
            if (actorRole === 'transporter' && actor.role === 'transporter' && actor.id === driverId) {
              throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Transporter must provide a fleet driver for assignment');
            }

            const driver = await tx.user.findUnique({ where: { id: driverId } });
            if (!driver || driver.role !== 'driver' || !driver.transporterId) {
              throw new AppError(403, 'DRIVER_NOT_IN_FLEET', 'Driver is not eligible for this assignment');
            }

            if (actorRole === 'transporter' && actor.id !== driver.transporterId) {
              throw new AppError(403, 'DRIVER_NOT_IN_FLEET', 'Driver does not belong to this transporter');
            }

            const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
            if (!vehicle) {
              throw new AppError(403, 'VEHICLE_NOT_IN_FLEET', 'Vehicle is not eligible for this assignment');
            }

            if (vehicle.transporterId !== driver.transporterId) {
              throw new AppError(403, 'VEHICLE_NOT_IN_FLEET', 'Vehicle does not belong to the same fleet as driver');
            }

            if (actorRole === 'transporter' && actor.id !== vehicle.transporterId) {
              throw new AppError(403, 'VEHICLE_NOT_IN_FLEET', 'Vehicle does not belong to this transporter');
            }

            const transporter = await tx.user.findUnique({ where: { id: driver.transporterId } });
            if (!transporter) {
              throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Transporter context missing for assignment');
            }

            const existingAssignment = await tx.assignment.findFirst({
              where: {
                bookingId: broadcastId,
                driverId,
                vehicleId,
                status: { in: activeStatuses as any }
              },
              orderBy: { assignedAt: 'desc' }
            });

            if (existingAssignment) {
              return {
                replayed: true,
                assignmentId: existingAssignment.id,
                tripId: existingAssignment.tripId,
                trucksConfirmed: booking.trucksFilled,
                totalTrucksNeeded: booking.trucksNeeded,
                isFullyFilled: booking.trucksFilled >= booking.trucksNeeded,
                booking,
                driver,
                vehicle,
                transporter
              };
            }

            if (new Date(booking.expiresAt).getTime() < Date.now()) {
              throw new AppError(409, 'BROADCAST_EXPIRED', 'Broadcast has expired');
            }
            if (booking.trucksFilled >= booking.trucksNeeded) {
              throw new AppError(409, 'BROADCAST_FILLED', 'Broadcast already filled');
            }
            if (booking.status !== 'active' && booking.status !== 'partially_filled') {
              throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Broadcast is not accepting assignments');
            }

            const activeAssignment = await tx.assignment.findFirst({
              where: {
                driverId,
                status: { in: activeStatuses as any }
              },
              orderBy: { assignedAt: 'desc' }
            });
            if (activeAssignment) {
              throw new AppError(
                409,
                'DRIVER_BUSY',
                'Driver already has an active trip. Assign a different driver.'
              );
            }

            const bookingUpdate = await tx.booking.updateMany({
              where: {
                id: broadcastId,
                trucksFilled: booking.trucksFilled
              },
              data: {
                trucksFilled: { increment: 1 }
              }
            });
            if (bookingUpdate.count !== 1) {
              const latestBooking = await tx.booking.findUnique({
                where: { id: broadcastId },
                select: {
                  expiresAt: true,
                  status: true,
                  trucksFilled: true,
                  trucksNeeded: true
                }
              });
              if (!latestBooking) {
                throw new AppError(404, 'INVALID_ASSIGNMENT_STATE', 'Broadcast not found');
              }
              if (new Date(latestBooking.expiresAt).getTime() < Date.now()) {
                throw new AppError(409, 'BROADCAST_EXPIRED', 'Broadcast has expired');
              }
              if (latestBooking.trucksFilled >= latestBooking.trucksNeeded || latestBooking.status === 'fully_filled') {
                throw new AppError(409, 'BROADCAST_FILLED', 'Broadcast already filled');
              }
              throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Broadcast state changed. Retry assignment.');
            }

            const newTrucksFilled = booking.trucksFilled + 1;
            const newStatus: BookingRecord['status'] = newTrucksFilled >= booking.trucksNeeded ? 'fully_filled' : 'partially_filled';
            await tx.booking.update({
              where: { id: broadcastId },
              data: { status: newStatus as any }
            });

            const now = new Date().toISOString();
            const assignmentId = uuidv4();
            const tripId = uuidv4();
            const assignment: AssignmentRecord = {
              id: assignmentId,
              bookingId: broadcastId,
              tripId,
              transporterId: driver.transporterId,
              transporterName: transporter.name || transporter.businessName || 'Transporter',
              driverId,
              driverName: driver.name || 'Driver',
              driverPhone: driver.phone || '',
              vehicleId,
              vehicleNumber: vehicle.vehicleNumber || '',
              vehicleType: vehicle.vehicleType || booking.vehicleType,
              vehicleSubtype: vehicle.vehicleSubtype || booking.vehicleSubtype || '',
              status: 'pending',
              assignedAt: now
            };
            await tx.assignment.create({
              data: {
                ...assignment,
                status: assignment.status as any
              }
            });

            return {
              replayed: false,
              assignmentId,
              tripId,
              trucksConfirmed: newTrucksFilled,
              totalTrucksNeeded: booking.trucksNeeded,
              isFullyFilled: newTrucksFilled >= booking.trucksNeeded,
              booking: {
                ...booking,
                trucksFilled: newTrucksFilled,
                status: newStatus
              },
              driver,
              vehicle,
              transporter
            };
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeoutMs: 8000 });
          break;
        } catch (transactionError: any) {
          const isRetryableContention = transactionError?.code === 'P2034' || transactionError?.code === '40001';
          if (!isRetryableContention || attempt >= maxTransactionAttempts) {
            throw transactionError;
          }
          this.incrementAcceptMetric('lockContention');
          logger.warn('[BroadcastAccept] Contention retry', {
            broadcastId,
            vehicleId,
            driverId,
            attempt,
            maxAttempts: maxTransactionAttempts,
            code: transactionError.code
          });
        }
      }

      if (!txResult) {
        throw new AppError(409, 'INVALID_ASSIGNMENT_STATE', 'Unable to finalize assignment after retries');
      }

      const result: AcceptBroadcastResult = {
        assignmentId: txResult.assignmentId,
        tripId: txResult.tripId,
        status: 'assigned',
        trucksConfirmed: txResult.trucksConfirmed,
        totalTrucksNeeded: txResult.totalTrucksNeeded,
        isFullyFilled: txResult.isFullyFilled,
        resultCode: txResult.replayed ? 'IDEMPOTENT_REPLAY' : 'ASSIGNED',
        replayed: txResult.replayed
      };

      if (txResult.replayed) {
        this.incrementAcceptMetric('idempotentReplay');
        logger.info('[BroadcastAccept] Replay detected in transaction', {
          broadcastId,
          vehicleId,
          driverId,
          resultCode: 'IDEMPOTENT_REPLAY'
        });
      } else {
        this.incrementAcceptMetric('success');
        const booking = txResult.booking as any;
        const driver = txResult.driver as any;
        const vehicle = txResult.vehicle as any;
        const transporter = txResult.transporter as any;
        const now = new Date().toISOString();
        const pickup = (booking.pickup || {}) as any;
        const drop = (booking.drop || {}) as any;

        logger.info('[BroadcastAccept] Success', {
          broadcastId,
          vehicleId,
          driverId,
          assignmentId: result.assignmentId,
          tripId: result.tripId,
          trucksConfirmed: result.trucksConfirmed,
          totalTrucksNeeded: result.totalTrucksNeeded,
          resultCode: result.resultCode
        });

        const driverNotification = {
          type: 'trip_assignment',
          assignmentId: result.assignmentId,
          tripId: result.tripId,
          bookingId: broadcastId,
          pickup,
          drop,
          vehicleNumber: vehicle?.vehicleNumber || '',
          farePerTruck: booking.pricePerTruck,
          distanceKm: booking.distanceKm,
          customerName: booking.customerName,
          customerPhone: booking.customerPhone,
          assignedAt: now,
          message: `New trip assigned! ${pickup.address || 'Pickup'} → ${drop.address || 'Drop'}`
        };

        emitToUser(driverId, SocketEvent.TRIP_ASSIGNED, driverNotification);

        sendPushNotification(driverId, {
          title: '🚛 New Trip Assigned!',
          body: `${pickup.city || pickup.address || 'Pickup'} → ${drop.city || drop.address || 'Drop'}`,
          data: {
            type: 'trip_assignment',
            tripId: result.tripId,
            assignmentId: result.assignmentId,
            bookingId: broadcastId
          }
        }).catch(err => {
          logger.warn(`FCM to driver ${driverId} failed: ${err.message}`);
        });

        const customerNotification = {
          type: 'truck_confirmed',
          bookingId: broadcastId,
          assignmentId: result.assignmentId,
          truckNumber: result.trucksConfirmed,
          totalTrucksNeeded: booking.trucksNeeded,
          trucksConfirmed: result.trucksConfirmed,
          remainingTrucks: booking.trucksNeeded - result.trucksConfirmed,
          isFullyFilled: result.isFullyFilled,
          driver: {
            name: driver?.name || 'Driver',
            phone: driver?.phone || ''
          },
          vehicle: {
            number: vehicle?.vehicleNumber || '',
            type: vehicle?.vehicleType || booking.vehicleType,
            subtype: vehicle?.vehicleSubtype || booking.vehicleSubtype
          },
          transporter: {
            name: transporter?.name || transporter?.businessName || '',
            phone: transporter?.phone || ''
          },
          message: `Truck ${result.trucksConfirmed}/${booking.trucksNeeded} confirmed! ${vehicle?.vehicleNumber || 'Vehicle'} assigned.`
        };

        emitToUser(booking.customerId, SocketEvent.TRUCK_CONFIRMED, customerNotification);
        emitToRoom(`booking:${broadcastId}`, SocketEvent.BOOKING_UPDATED, {
          bookingId: broadcastId,
          status: booking.status,
          trucksFilled: result.trucksConfirmed,
          trucksNeeded: booking.trucksNeeded
        });

        sendPushNotification(booking.customerId, {
          title: `🚛 Truck ${result.trucksConfirmed}/${booking.trucksNeeded} Confirmed!`,
          body: `${vehicle?.vehicleNumber || 'Vehicle'} (${driver?.name || 'Driver'}) assigned to your booking`,
          data: {
            type: 'truck_confirmed',
            bookingId: broadcastId,
            trucksConfirmed: result.trucksConfirmed,
            totalTrucks: booking.trucksNeeded
          }
        }).catch(err => {
          logger.warn(`FCM to customer ${booking.customerId} failed: ${err.message}`);
        });
      }

      if (idempotencyCacheKey) {
        try {
          const cachePayload: AcceptBroadcastResult = {
            assignmentId: result.assignmentId,
            tripId: result.tripId,
            status: result.status,
            trucksConfirmed: result.trucksConfirmed,
            totalTrucksNeeded: result.totalTrucksNeeded,
            isFullyFilled: result.isFullyFilled
          };
          await redisService.setJSON(idempotencyCacheKey, cachePayload, 24 * 60 * 60);
        } catch (error: any) {
          logger.warn('[BroadcastAccept] Idempotency cache write failed', {
            broadcastId,
            vehicleId,
            driverId,
            error: error.message
          });
        }
      }

      return result;
    } catch (error: any) {
      const code = error instanceof AppError ? error.code : 'INVALID_ASSIGNMENT_STATE';
      this.incrementAcceptFailureMetric(code);
      logger.warn('[BroadcastAccept] Failed', {
        broadcastId,
        vehicleId,
        driverId,
        resultCode: code,
        message: error?.message || 'Unknown error'
      });
      throw error;
    } finally {
      if (lockAcquired) {
        try {
          await redisService.releaseLock(lockKey, lockHolder);
        } catch (error: any) {
          logger.warn('[BroadcastAccept] Lock release failed', {
            broadcastId,
            vehicleId,
            driverId,
            error: error.message
          });
        }
      }
    }
  }

  /**
   * Decline a broadcast
   */
  async declineBroadcast(broadcastId: string, params: DeclineBroadcastParams) {
    const { actorId, reason, notes } = params;

    // FIX #7: Track decline in Redis SET for analytics + re-broadcast prevention
    // TTL = 1 hour (matches booking max lifetime)
    const declineKey = `broadcast:declined:${broadcastId}`;
    await redisService.sAdd(declineKey, actorId).catch((err: any) => {
      logger.warn('[declineBroadcast] Redis sAdd failed', { broadcastId, actorId, error: err.message });
    });
    await redisService.expire(declineKey, 3600).catch(() => {});

    logger.info(`Broadcast ${broadcastId} declined by ${actorId}. Reason: ${reason}`, {
      notes,
      declineTracked: true
    });

    return { success: true };
  }

  /**
   * Get broadcast history for a transporter/driver
   */
  async getBroadcastHistory(params: GetHistoryParams) {
    const { actorId, page, limit, status } = params;

    // Get bookings for this actor (transporter or driver)
    let bookings = await db.getBookingsByDriver(actorId);

    // Filter by status if provided
    if (status) {
      bookings = bookings.filter((b: BookingRecord) => b.status === status);
    }

    const total = bookings.length;
    const pages = Math.ceil(total / limit);

    // Paginate
    const start = (page - 1) * limit;
    const paginatedBookings = bookings.slice(start, start + limit);

    return {
      broadcasts: paginatedBookings.map((b: BookingRecord) => this.mapBookingToBroadcast(b)),
      pagination: {
        page,
        limit,
        total,
        pages
      }
    };
  }

  /**
   * Create a new broadcast (from transporter)
   */
  async createBroadcast(params: CreateBroadcastParams) {
    // FIX #3: DEPRECATED — This method uses hardcoded mock values and does NOT
    // actually find/notify drivers. The real broadcast path is:
    //   booking.service.ts → createBooking() → progressive radius → emitToUser()
    // This endpoint remains for backward compatibility but logs a deprecation warning.
    logger.warn('[DEPRECATED] createBroadcast() called — use booking.service.ts createBooking() instead', {
      transporterId: params.transporterId
    });

    const broadcastId = uuidv4();

    // Get customer info
    const customer = await db.getUserById(params.customerId);

    const booking: Omit<BookingRecord, 'createdAt' | 'updatedAt'> = {
      id: broadcastId,
      customerId: params.customerId,
      customerName: customer?.name || 'Customer',
      customerPhone: customer?.phone || '',
      pickup: {
        latitude: params.pickupLocation.latitude,
        longitude: params.pickupLocation.longitude,
        address: params.pickupLocation.address,
        city: params.pickupLocation.city,
        state: params.pickupLocation.state
      },
      drop: {
        latitude: params.dropLocation.latitude,
        longitude: params.dropLocation.longitude,
        address: params.dropLocation.address,
        city: params.dropLocation.city,
        state: params.dropLocation.state
      },
      vehicleType: params.vehicleType,
      vehicleSubtype: params.vehicleSubtype || '',
      trucksNeeded: params.totalTrucksNeeded,
      trucksFilled: 0,
      distanceKm: 0,
      pricePerTruck: params.farePerTruck,
      totalAmount: params.farePerTruck * params.totalTrucksNeeded,
      goodsType: params.goodsType,
      weight: params.weight,
      status: 'active',
      notifiedTransporters: [params.transporterId],
      expiresAt: params.expiresAt || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    };

    const createdBooking = await db.createBooking(booking);

    // DEPRECATED: No drivers actually notified via this path
    const notifiedDrivers = 0;

    logger.info(`[DEPRECATED] Broadcast ${broadcastId} created via legacy endpoint, 0 drivers notified`);

    return {
      broadcast: this.mapBookingToBroadcast(createdBooking),
      notifiedDrivers
    };
  }

  // ===========================================================================
  // BROADCAST EXPIRY & REAL-TIME UPDATES
  // ===========================================================================
  // These methods handle the instant removal of expired broadcasts from
  // ALL transporters' screens. Critical for Rapido-style UX.
  // ===========================================================================

  /**
   * Check and expire old orders (multi-vehicle system)
   * Called periodically (every 5 seconds) by the expiry job
   * 
   * NOTE: Booking expiry is handled by booking.service.ts → processExpiredBookings()
   * using Redis timers (O(m) where m = expired only). This method only handles
   * ORDER expiry which is not covered by booking.service.ts.
   * 
   * DISTRIBUTED LOCK: Each expired order is locked individually
   * to prevent duplicate processing across multiple ECS instances.
   */
  async checkAndExpireBroadcasts(): Promise<number> {
    const now = new Date();
    let expiredCount = 0;

    // FIX #9: BOOKING EXPIRY is already handled by booking.service.ts → processExpiredBookings()
    // which uses Redis timers (O(m) where m = expired only, not ALL bookings).
    // The previous O(n) scan of ALL bookings every 5s was duplicate work and a DB bottleneck.
    // Only ORDER expiry is handled here (not covered by booking.service.ts).

    // Also check orders (multi-vehicle system)
    let allOrders: any[] = [];
    try {
      if (db.getActiveOrders) {
        const result = await db.getActiveOrders();
        allOrders = Array.isArray(result) ? result : [];
      }
    } catch (error) {
      logger.debug('Could not get active orders for expiry check');
    }

    for (const order of allOrders) {
      if (order.status === 'searching' || order.status === 'partially_filled') {
        const expiresAt = new Date(order.expiresAt);
        if (expiresAt < now) {
          // Distributed lock: prevent duplicate processing across ECS instances
          const lockKey = `lock:broadcast-order-expiry:${order.id}`;
          const lock = await redisService.acquireLock(lockKey, 'broadcast-expiry-checker', 15);

          if (!lock.acquired) {
            // Another instance is already processing this order expiry
            continue;
          }

          try {
            // Mark as expired
            if (db.updateOrder) {
              await db.updateOrder(order.id, { status: 'expired' });
            }

            // Notify notified transporters
            await this.emitBroadcastExpired(order.id, 'timeout');

            expiredCount++;
            logger.info(`⏰ Order ${order.id} expired - notified all transporters`);
          } catch (error: any) {
            logger.error('Failed to process expired order broadcast', {
              orderId: order.id,
              error: error.message
            });
          } finally {
            await redisService.releaseLock(lockKey, 'broadcast-expiry-checker').catch(() => { });
          }
        }
      }
    }

    if (expiredCount > 0) {
      logger.info(`🧹 Expired ${expiredCount} broadcast(s)`);
    }

    return expiredCount;
  }

  /**
   * Emit broadcast expired event to NOTIFIED transporters only
   * This instantly removes the broadcast from their overlay/list
   * 
   * FIX 2: Changed from emitToAllTransporters → targeted emitToUsers.
   * Only transporters who were originally notified receive the expiry event.
   * Prevents 980 wasted socket messages when 1000 are online but only 20 were notified.
   * 
   * @param broadcastId - The broadcast/order ID that expired
   * @param reason - Why it expired ('timeout', 'cancelled', 'fully_filled')
   */
  async emitBroadcastExpired(broadcastId: string, reason: string = 'timeout'): Promise<void> {
    const payload = {
      broadcastId,
      orderId: broadcastId, // Alias for compatibility
      reason,
      timestamp: new Date().toISOString(),
      message: reason === 'timeout'
        ? 'This booking request has expired'
        : reason === 'cancelled'
          ? 'Customer cancelled this booking'
          : 'All trucks have been assigned'
    };

    // Lookup notified transporters from booking record
    let targets: string[] = [];
    try {
      const booking = await db.getBookingById(broadcastId);
      targets = booking?.notifiedTransporters ?? [];
    } catch {
      // DB lookup failed — fallback to all transporters (safety net)
    }

    if (targets.length > 0) {
      logger.info(`📢 Targeted expiry event: ${broadcastId} (${reason}) → ${targets.length} transporters`);
      emitToUsers(targets, BroadcastEvents.BROADCAST_EXPIRED, payload);
    } else {
      // Fallback: no targets found (order record missing) → broadcast to all
      logger.warn(`📢 Fallback expiry event: ${broadcastId} (${reason}) → ALL transporters (no notified list found)`);
      emitToAllTransporters(BroadcastEvents.BROADCAST_EXPIRED, payload);
    }

    // Also emit to the specific booking/order room (for any listeners)
    emitToRoom(`booking:${broadcastId}`, BroadcastEvents.BROADCAST_EXPIRED, payload);
    emitToRoom(`order:${broadcastId}`, BroadcastEvents.BROADCAST_EXPIRED, payload);
  }

  /**
   * Emit trucks remaining update to NOTIFIED transporters only
   * Called when a transporter accepts trucks - others see reduced availability
   * 
   * FIX 2: Changed from emitToAllTransporters → targeted emitToUsers.
   * Only transporters who received this broadcast see the truck count update.
   * 
   * @param broadcastId - The broadcast/order ID
   * @param vehicleType - Which vehicle type was accepted
   * @param vehicleSubtype - Which subtype
   * @param remaining - How many trucks still needed
   * @param total - Total trucks needed
   */
  async emitTrucksRemainingUpdate(
    broadcastId: string,
    vehicleType: string,
    vehicleSubtype: string,
    remaining: number,
    total: number
  ): Promise<void> {
    const payload = {
      broadcastId,
      orderId: broadcastId,
      vehicleType,
      vehicleSubtype,
      trucksRemaining: remaining,
      trucksNeeded: total,
      trucksFilled: total - remaining,
      isFullyFilled: remaining === 0,
      timestamp: new Date().toISOString()
    };

    // Lookup notified transporters from booking record
    let targets: string[] = [];
    try {
      const booking = await db.getBookingById(broadcastId);
      targets = booking?.notifiedTransporters ?? [];
    } catch {
      // DB lookup failed — fallback to all transporters
    }

    if (targets.length > 0) {
      logger.info(`📢 Targeted trucks update: ${broadcastId} - ${remaining}/${total} (${vehicleType}) → ${targets.length} transporters`);
      emitToUsers(targets, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);
    } else {
      logger.warn(`📢 Fallback trucks update: ${broadcastId} - ${remaining}/${total} → ALL transporters`);
      emitToAllTransporters(BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);
    }

    // Also emit to booking/order room
    emitToRoom(`booking:${broadcastId}`, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);
    emitToRoom(`order:${broadcastId}`, BroadcastEvents.TRUCKS_REMAINING_UPDATE, payload);

    // If fully filled, emit that event too
    if (remaining === 0) {
      await this.emitBroadcastExpired(broadcastId, 'fully_filled');
    }
  }

  /**
   * Notify customer that their broadcast expired without being filled
   */
  private notifyCustomerBroadcastExpired(booking: BookingRecord): void {
    const payload = {
      type: 'booking_expired',
      bookingId: booking.id,
      trucksNeeded: booking.trucksNeeded,
      trucksFilled: booking.trucksFilled,
      message: booking.trucksFilled > 0
        ? `Your booking expired with ${booking.trucksFilled}/${booking.trucksNeeded} trucks assigned`
        : 'Your booking expired. No transporters accepted in time.'
    };

    // WebSocket to customer
    emitToUser(booking.customerId, 'booking_expired', payload);

    // Push notification
    sendPushNotification(booking.customerId, {
      title: '⏰ Booking Expired',
      body: payload.message,
      data: {
        type: 'booking_expired',
        bookingId: booking.id
      }
    }).catch(err => {
      logger.warn(`FCM to customer ${booking.customerId} failed: ${err.message}`);
    });
  }

  /**
   * Start the broadcast expiry checker job
   * Runs every 5 seconds to check for expired broadcasts
   * 
   * IMPORTANT: Call this from server.ts after initializing the service
   */
  private expiryCheckerInterval: NodeJS.Timeout | null = null;

  startExpiryChecker(): void {
    if (this.expiryCheckerInterval) return;
    // Check every 5 seconds
    this.expiryCheckerInterval = setInterval(async () => {
      try {
        await this.checkAndExpireBroadcasts();
      } catch (error: any) {
        logger.error(`Expiry checker error: ${error.message}`);
      }
    }, 5000);

    logger.info('Broadcast expiry checker started (5 second interval)');
  }

  stopExpiryChecker(): void {
    if (this.expiryCheckerInterval) {
      clearInterval(this.expiryCheckerInterval);
      this.expiryCheckerInterval = null;
      logger.info('Broadcast expiry checker stopped');
    }
  }

  /**
   * Map internal booking to broadcast format for API response
   * Enhanced with capacity/tonnage information and requestedVehicles array
   */
  private mapBookingToBroadcast(booking: BookingRecord) {
    // Import vehicle catalog to get capacity info
    const { getSubtypeConfig } = require('../pricing/vehicle-catalog');

    // Get capacity information for the vehicle subtype
    const subtypeConfig = getSubtypeConfig(booking.vehicleType, booking.vehicleSubtype);
    const capacityTons = subtypeConfig ? subtypeConfig.capacityKg / 1000 : 0;

    // Build requestedVehicles array for multi-truck UI compatibility
    const requestedVehicles = [{
      vehicleType: booking.vehicleType,
      vehicleSubtype: booking.vehicleSubtype || '',
      count: booking.trucksNeeded,
      filledCount: booking.trucksFilled || 0,
      farePerTruck: booking.pricePerTruck,
      capacityTons: capacityTons
    }];

    return {
      broadcastId: booking.id,
      customerId: booking.customerId,
      customerName: booking.customerName || 'Customer',
      customerMobile: booking.customerPhone || '',
      pickupLocation: booking.pickup,
      dropLocation: booking.drop,
      distance: booking.distanceKm || 0,
      estimatedDuration: Math.round((booking.distanceKm || 100) * 1.5), // Rough estimate: 1.5 min per km

      // Multi-truck support (NEW)
      requestedVehicles: requestedVehicles,

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

      // Enhanced: Capacity information for transporters
      capacityInfo: subtypeConfig ? {
        capacityKg: subtypeConfig.capacityKg,
        capacityTons: capacityTons,
        minTonnage: subtypeConfig.minTonnage,
        maxTonnage: subtypeConfig.maxTonnage
      } : null
    };
  }
}

export const broadcastService = new BroadcastService();
