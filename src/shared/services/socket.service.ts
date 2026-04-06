/**
 * =============================================================================
 * SOCKET SERVICE - Real-time Communication (Multi-Server Ready)
 * =============================================================================
 * 
 * Handles WebSocket connections for real-time updates:
 * - New booking notifications to matching transporters
 * - Booking status updates to customers
 * - Location tracking updates
 * - Assignment status changes
 * 
 * MULTI-SERVER SCALING (Socket.IO Redis Adapter):
 * - io.to(room).emit() is synchronized across all server instances
 * - No manual pub/sub fanout code required
 * - Redis adapter acts as the transport between ECS tasks
 * - Seamless horizontal scaling - just add more servers
 * 
 * SECURITY:
 * - JWT authentication required
 * - Room-based isolation
 * - Users only receive their own data
 * =============================================================================
 */

import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import jwt from 'jsonwebtoken';
import { config } from '../../config/environment';
import { HOLD_CONFIG } from '../../core/config/hold-config';
import { logger } from './logger.service';
import { redisService } from './redis.service';
import {
  TRANSPORTER_PRESENCE_KEY,
  PRESENCE_TTL_SECONDS as TRANSPORTER_PRESENCE_TTL,
  ONLINE_TRANSPORTERS_SET
} from './transporter-online.service';

// Lazy import to avoid circular dependency (socket.service ↔ driver.service)
// H18 FIX: Add type annotation to preserve type safety across lazy require()
let _driverService: typeof import('../../modules/driver/driver.service')['driverService'] | null = null;
function getDriverService() {
  if (!_driverService) {
    const mod: typeof import('../../modules/driver/driver.service') = require('../../modules/driver/driver.service');
    _driverService = mod.driverService;
  }
  return _driverService;
}

let io: Server | null = null;
let adapterReconnectTimer: NodeJS.Timeout | null = null;

// Track user connections
const userSockets = new Map<string, Set<string>>();  // userId -> Set of socketIds
const socketUsers = new Map<string, string>();        // socketId -> userId

// Per-connection rate limiter (Problem 17 fix)
const eventCounts = new Map<string, { count: number; resetAt: number }>();

// H-S4 FIX: Per-event debounce for socket join events (prevents DB query spam on rapid reconnect)
const recentJoinAttempts = new Map<string, number>();
const MAX_EVENTS_PER_SECOND = 30;

// Fix E8: Rate limit keyed by userId (falls back to socketId pre-auth)
function checkRateLimit(socketId: string, userId?: string): boolean {
  const key = userId || socketId;
  const now = Date.now();
  const entry = eventCounts.get(key);
  if (!entry || now > entry.resetAt) {
    eventCounts.set(key, { count: 1, resetAt: now + 1000 });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_EVENTS_PER_SECOND;
}

// Industry Standard: DoorDash O(1) role counters
// Updated atomically on connect/disconnect - eliminates O(n) forEach traversal
const roleCounters = {
  customers: 0,
  transporters: 0,
  drivers: 0
};

// Max WebSocket connections per user — prevents memory exhaustion from malicious clients.
// Normal usage: 1-2 connections (app foreground + background reconnect).
// 5 allows multi-device + reconnect overlap without abuse.
const MAX_CONNECTIONS_PER_USER = 5;

// TTL for per-user Redis connection counters (auto-cleanup if instance dies)
const CONNECTION_COUNTER_TTL_SECONDS = 300;

// Server instance ID (for debugging multi-server issues)
const SERVER_INSTANCE_ID = `server_${process.pid}_${Date.now().toString(36)}`;

// Flag to track if Redis adapter is initialized
let redisPubSubInitialized = false;
let redisAdapterMode: 'enabled' | 'disabled' | 'disabled_by_config' | 'disabled_by_capability' | 'failed' = 'disabled';
let redisAdapterLastError: string | null = null;
const SOCKET_EVENT_VERSION = 1;
const SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE = Math.min(500, Math.max(25, parseInt(process.env.SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE || '300', 10) || 300));

/**
 * Socket Events
 * 
 * ENHANCED: Added booking lifecycle events for timeout handling
 * ENHANCED: Added real-time truck count updates for multi-truck requests
 */
export const SocketEvent = {
  // Server -> Client
  CONNECTED: 'connected',
  BOOKING_UPDATED: 'booking_updated',
  TRUCK_ASSIGNED: 'truck_assigned',
  TRIP_ASSIGNED: 'trip_assigned',
  LOCATION_UPDATED: 'location_updated',
  ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
  NEW_BROADCAST: 'new_broadcast',
  TRUCK_CONFIRMED: 'truck_confirmed',

  // Booking lifecycle events
  BOOKING_EXPIRED: 'booking_expired',           // No transporters accepted in time
  BOOKING_FULLY_FILLED: 'booking_fully_filled', // All trucks assigned
  BOOKING_PARTIALLY_FILLED: 'booking_partially_filled', // Some trucks assigned
  NO_VEHICLES_AVAILABLE: 'no_vehicles_available', // No matching transporters found
  BROADCAST_COUNTDOWN: 'broadcast_countdown',   // Timer tick for UI

  // NEW: Real-time truck request updates (for multi-truck system)
  TRUCK_REQUEST_ACCEPTED: 'truck_request_accepted',     // A transporter accepted 1 truck
  TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update',   // Update remaining truck count
  REQUEST_NO_LONGER_AVAILABLE: 'request_no_longer_available', // Request taken by someone else
  ORDER_STATUS_UPDATE: 'order_status_update',           // Overall order status changed

  // Fleet/Vehicle events (for real-time fleet updates)
  VEHICLE_REGISTERED: 'vehicle_registered',
  VEHICLE_UPDATED: 'vehicle_updated',
  VEHICLE_DELETED: 'vehicle_deleted',
  VEHICLE_STATUS_CHANGED: 'vehicle_status_changed',
  FLEET_UPDATED: 'fleet_updated',

  // Driver events (for real-time driver updates)
  DRIVER_ADDED: 'driver_added',
  DRIVER_UPDATED: 'driver_updated',
  DRIVER_DELETED: 'driver_deleted',
  DRIVER_STATUS_CHANGED: 'driver_status_changed',
  DRIVERS_UPDATED: 'drivers_updated',

  // Lightning-fast notification events
  NEW_ORDER_ALERT: 'new_order_alert',           // Urgent notification with sound
  ACCEPT_CONFIRMATION: 'accept_confirmation',   // Confirm acceptance to transporter

  ERROR: 'error',

  // Driver presence events
  HEARTBEAT: 'heartbeat',                       // Driver sends every 12s
  DRIVER_ONLINE: 'driver_online',               // Driver came online
  DRIVER_OFFLINE: 'driver_offline',             // Driver went offline
  DRIVER_TIMEOUT: 'driver_timeout',             // Driver didn't accept in time
  TRIP_CANCELLED: 'trip_cancelled',             // Trip cancelled by customer

  // Broadcast lifecycle events (Fix E1: consolidated from BroadcastEvents)
  BROADCAST_EXPIRED: 'broadcast_expired',
  BROADCAST_CANCELLED: 'order_cancelled',
  BROADCAST_STATE_CHANGED: 'broadcast_state_changed',

  // Client -> Server
  JOIN_BOOKING: 'join_booking',
  LEAVE_BOOKING: 'leave_booking',
  JOIN_ORDER: 'join_order',                     // Join order room for updates
  LEAVE_ORDER: 'leave_order',
  UPDATE_LOCATION: 'update_location',
  JOIN_TRANSPORTER: 'join_transporter', // Driver joins transporter room for broadcasts
  BROADCAST_ACK: 'broadcast_ack'            // Phase 4: client ACKs sequence-numbered message
};

/**
 * =============================================================================
 * OPTIMIZED Socket.IO Configuration
 * =============================================================================
 * 
 * OPTIMIZATIONS:
 * 1. PING/PONG: 25s interval, 20s timeout - Keeps connections alive
 * 2. PER-MESSAGE DEFLATE: Compresses messages for faster transfer
 * 3. HTTP LONG-POLLING DISABLED: WebSocket only for better performance
 * 4. MAX HTTP BUFFER SIZE: 10MB for large payloads
 * 5. CONNECTION STATE RECOVERY: Reconnection support
 * =============================================================================
 */
export function initializeSocket(server: HttpServer): Server {
  io = new Server(server, {
    cors: {
      origin: config.isDevelopment ? '*' : [
        'https://weelo.app',
        'https://captain.weelo.app',
        /\.weelo\.app$/
      ],
      methods: ['GET', 'POST'],
      credentials: true
    },

    // Performance optimizations
    pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT_MS || '20000', 10),    // 20s default — safe for slow 2G/3G Indian networks
    pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL_MS || '15000', 10),  // 15s default
    upgradeTimeout: 10000,        // 10s - Timeout for upgrade

    // Transports - WebSocket ONLY (no polling handshake)
    // Polling→upgrade fails across ALB instances even with stickiness.
    // Direct WS connection is a single HTTP upgrade request.
    transports: ['websocket'],
    allowUpgrades: false,

    // Buffer and payload limits
    maxHttpBufferSize: 10 * 1024 * 1024,  // 10MB max message size

    // Connection state recovery (for reconnection)
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,  // 2 minutes
      skipMiddlewares: false
    },

    // Per-message deflate compression
    perMessageDeflate: {
      threshold: 1024,  // Only compress messages > 1KB
      zlibDeflateOptions: {
        chunkSize: 16 * 1024  // 16KB chunks
      },
      zlibInflateOptions: {
        chunkSize: 16 * 1024
      },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true
    }
  });

  // H-9 FIX: Default to ON for guaranteed delivery (opt-OUT instead of opt-IN)
  // Changed from !== 'true' (opt-in) to === 'false' (opt-out) so sequence delivery is enabled by default
  if (process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'false') {
    logger.warn('FF_SEQUENCE_DELIVERY_ENABLED is explicitly OFF — sequence delivery disabled.');
  }

  // Authentication middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, config.jwt.secret) as {
        userId: string;
        role: string;
        phone: string;
      };

      socket.data.userId = decoded.userId;
      socket.data.role = decoded.role;
      socket.data.phone = decoded.phone;

      // Problem 13 fix: Set transporterId for drivers during auth
      if (decoded.role === 'driver') {
        try {
          const { prismaClient: pc } = require('../database/prisma.service');
          const driverRecord = await pc.driver.findFirst({
            where: { id: decoded.userId },
            select: { transporterId: true }
          });
          socket.data.transporterId = driverRecord?.transporterId || null;
        } catch (dbErr: any) {
          logger.warn(`[Socket] transporterId lookup failed for driver ${decoded.userId}: ${dbErr?.message}`);
          socket.data.transporterId = null;
        }
      }

      next();
    } catch (error) {
      next(new Error('Invalid token'));
    }
  });

  // Connection handler
  io.on('connection', async (socket: Socket) => {
    const userId = socket.data.userId;
    const role = socket.data.role;
    const phone = socket.data.phone;

    logger.info(`🔌 Socket connected: ${socket.id}`);
    logger.info(`   👤 User: ${userId}`);
    logger.info(`   📱 Phone: ${phone}`);
    logger.info(`   🏷️ Role: ${role}`);

    // Track user connection (with limit to prevent abuse)
    if (!userSockets.has(userId)) {
      userSockets.set(userId, new Set());
    }
    const userSocketSet = userSockets.get(userId)!;

    // Enforce connection limit cross-instance via Redis counter
    const connKey = `socket:conncount:${userId}`;
    let globalCount = 0;
    try {
      globalCount = await redisService.incr(connKey);
      await redisService.expire(connKey, CONNECTION_COUNTER_TTL_SECONDS); // auto-cleanup, reconciled every 60s
    } catch {
      // Redis unavailable — fall back to local count
      globalCount = userSocketSet.size + 1;
    }

    if (globalCount > MAX_CONNECTIONS_PER_USER) {
      // Decrement since we won't be keeping this connection
      try { await redisService.incrBy(connKey, -1); } catch { }
      const oldestSocketId = userSocketSet.values().next().value;
      if (oldestSocketId) {
        logger.warn(`[Socket] Global connection limit (${MAX_CONNECTIONS_PER_USER}) exceeded for ${userId}, disconnecting oldest: ${oldestSocketId}`);
        const oldSocket = io?.sockets.sockets.get(oldestSocketId);
        if (oldSocket) {
          oldSocket.emit(SocketEvent.ERROR, { message: 'Connection limit exceeded. Disconnecting oldest session.' });
          oldSocket.disconnect(true);
        }
        userSocketSet.delete(oldestSocketId);
        socketUsers.delete(oldestSocketId);
        // Re-add this new connection
        try { await redisService.incr(connKey); } catch { }
      }
    }

    userSocketSet.add(socket.id);
    socketUsers.set(socket.id, userId);

    // Join user's personal room
    socket.join(`user:${userId}`);
    socket.join(`role:${role}`);

    // Industry Standard: DoorDash O(1) role counter increment
    // Updated atomically on connect - eliminates O(n) forEach traversal later
    const roleCounterKey = role + 's' as keyof typeof roleCounters;
    if (roleCounterKey in roleCounters) {
      (roleCounters[roleCounterKey] as number)++;
    }

    // Send confirmation
    socket.emit(SocketEvent.CONNECTED, {
      message: 'Connected successfully',
      userId,
      role
    });

    // Handle joining booking room
    // H-S4 FIX: Verify ownership before allowing room join
    socket.on(SocketEvent.JOIN_BOOKING, async (bookingId: string) => {
      const joinKey = `${userId}:booking:${bookingId}`;
      const now = Date.now();
      if (recentJoinAttempts.get(joinKey) && now - recentJoinAttempts.get(joinKey)! < 5000) {
        return; // Debounce: ignore duplicate join within 5s
      }
      recentJoinAttempts.set(joinKey, now);

      try {
        const { prismaClient } = await import('../database/prisma.service');
        const booking = await prismaClient.booking.findUnique({
          where: { id: bookingId },
          select: { customerId: true }
        });
        if (!booking) {
          socket.emit(SocketEvent.ERROR, { message: 'Booking not found' });
          return;
        }
        if (socket.data.role === 'customer' && booking.customerId !== socket.data.userId) {
          socket.emit(SocketEvent.ERROR, { message: 'Unauthorized: not your booking' });
          return;
        }
        if (socket.data.role === 'driver' || socket.data.role === 'transporter') {
          const assignment = await prismaClient.assignment.findFirst({
            where: { bookingId, OR: [{ driverId: socket.data.userId }, { transporterId: socket.data.userId }] },
            select: { id: true }
          });
          if (!assignment) {
            socket.emit(SocketEvent.ERROR, { message: 'Unauthorized: not assigned to this booking' });
            return;
          }
        }
        socket.join(`booking:${bookingId}`);
        logger.debug(`User ${userId} joined booking room: ${bookingId}`);
      } catch (err: any) {
        logger.warn(`[Socket] join_booking ownership check failed, denying: ${err?.message}`);
        socket.emit(SocketEvent.ERROR, { message: 'Failed to verify booking access' });
      }
    });

    // Handle joining transporter room - for driver notifications
    // Problem 13 fix: enforce ownership check (transporterId now set during auth)
    // H-S7 FIX: Block competitor transporters and non-driver/transporter roles
    socket.on('join_transporter', async ({ transporterId }: { transporterId: string }) => {
      if (!transporterId) {
        return socket.emit('error', { message: 'Transporter ID required' });
      }

      // H-S7 FIX: Block all roles except driver and transporter
      if (socket.data.role !== 'driver' && socket.data.role !== 'transporter') {
        socket.emit('error', { message: 'Unauthorized: only drivers and transporters can join transporter rooms' });
        return;
      }

      // Drivers can only join their own transporter's room
      if (socket.data.role === 'driver' && socket.data.transporterId !== transporterId) {
        logger.warn('[Socket] Driver tried to join unauthorized transporter room', {
          driverId: socket.data.userId,
          requestedTransporter: transporterId,
          actualTransporter: socket.data.transporterId || 'none'
        });
        socket.emit('error', { message: 'Unauthorized: you do not belong to this transporter' });
        return;
      }

      // H-S7 FIX: Transporters can only join their OWN room — prevent competitor eavesdropping
      if (socket.data.role === 'transporter' && socket.data.userId !== transporterId) {
        logger.warn('[Socket] Transporter tried to join another transporter\'s room', {
          transporterId: socket.data.userId,
          requestedTransporter: transporterId
        });
        socket.emit('error', { message: 'Unauthorized: you can only join your own transporter room' });
        return;
      }

      await socket.join(`transporter:${transporterId}`);
      logger.debug(`Socket ${socket.id} joined transporter:${transporterId}`);
    });

    // Handle leaving booking room
    socket.on(SocketEvent.LEAVE_BOOKING, (bookingId: string) => {
      socket.leave(`booking:${bookingId}`);
      logger.debug(`User ${userId} left booking room: ${bookingId}`);
    });

    // Handle location updates (from drivers) - rate limited (Problem 17)
    socket.on(SocketEvent.UPDATE_LOCATION, (data: {
      tripId: string;
      latitude: number;
      longitude: number;
      speed?: number;
      bearing?: number;
    }) => {
      if (!checkRateLimit(socket.id, socket.data?.userId)) {
        logger.warn(`[Socket] Rate limited update_location from ${socket.id}`);
        return;
      }
      if (role !== 'driver') {
        socket.emit(SocketEvent.ERROR, { message: 'Only drivers can update location' });
        return;
      }

      // Broadcast to trip room
      emitToTrip(data.tripId, SocketEvent.LOCATION_UPDATED, {
        tripId: data.tripId,
        driverId: userId,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed || 0,
        bearing: data.bearing || 0,
        timestamp: new Date().toISOString()
      });
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id} (Reason: ${reason})`);
      // H-P5 FIX: checkRateLimit keys by userId, not socket.id — delete the correct key
      const disconnectingUserId = socketUsers.get(socket.id);
      eventCounts.delete(disconnectingUserId || socket.id);

      // Remove from tracking
      const userId = socketUsers.get(socket.id);
      if (userId) {
        userSockets.get(userId)?.delete(socket.id);
        if (userSockets.get(userId)?.size === 0) {
          userSockets.delete(userId);
        }

        // Industry Standard: DoorDash O(1) role counter decrement
        // F-4-20 FIX: Guard against undefined role to prevent NaN drift
        const disconnectRole = socket.data?.role;
        if (disconnectRole) {
          const roleCounterKey = disconnectRole + 's' as keyof typeof roleCounters;
          if (roleCounterKey in roleCounters) {
            (roleCounters[roleCounterKey] as number) = Math.max(0, (roleCounters[roleCounterKey] as number) - 1);
          }
        }

        // Decrement Redis connection counter (cross-instance tracking)
        try { redisService.incrBy(`socket:conncount:${userId}`, -1).catch(() => { }); } catch { }

        // H-S4 FIX: Clean up join debounce entries for disconnected user
        for (const [key] of recentJoinAttempts) {
          if (key.startsWith(`${userId}:`)) recentJoinAttempts.delete(key);
        }
      }
      socketUsers.delete(socket.id);
    });

    // ================================================================
    // HEARTBEAT — Extends Redis presence TTL (no DB write)
    // ================================================================
    // Captain app sends every 12 seconds:
    //   { type: "heartbeat", lat, lng, battery, speed }
    //
    // DRIVERS: Extends driver:presence:{id} TTL to 35s
    // TRANSPORTERS: Extends transporter:presence:{id} TTL to 60s
    //
    // If heartbeat stops → key expires → auto-offline.
    //
    // GUARD: Only extends if presence key exists. This prevents
    // ghost-online: toggle OFF → DELs key → stale heartbeat arrives
    // → key doesn't exist → heartbeat ignored → stays offline ✅
    // ================================================================
    socket.on(SocketEvent.HEARTBEAT, (data: any) => {
      if (!checkRateLimit(socket.id, socket.data?.userId)) {
        logger.warn(`[Socket] Rate limited heartbeat from ${socket.id}`);
        return;
      }
      if (role === 'driver') {
        // Driver heartbeat → extends driver:presence:{id}
        try {
          getDriverService().handleHeartbeat(userId, {
            lat: data?.lat,
            lng: data?.lng,
            battery: data?.battery,
            speed: data?.speed
          });
        } catch (e: any) {
          logger.warn(`[Socket] Heartbeat error for driver ${userId}: ${e.message}`);
        }
      } else if (role === 'transporter') {
        // Transporter heartbeat → extends transporter:presence:{id}
        // Same guard pattern as driver.service.ts handleHeartbeat():
        // Only extend TTL if presence key exists (prevents ghost-online)
        (async () => {
          try {
            const presenceKey = TRANSPORTER_PRESENCE_KEY(userId);
            const presenceExists = await redisService.exists(presenceKey);
            if (!presenceExists) {
              // No presence key — transporter toggled OFFLINE, ignore stale heartbeat
              // This guard prevents ghost-online: OFF → DEL key → heartbeat arrives → must NOT recreate
              return;
            }

            // Extend TTL — zero DB writes, only Redis SET
            const presenceData = JSON.stringify({
              transporterId: userId,
              lastHeartbeat: new Date().toISOString()
            });
            await redisService.set(presenceKey, presenceData, TRANSPORTER_PRESENCE_TTL);
          } catch (e: any) {
            // Non-critical — heartbeat failure shouldn't crash anything
            logger.warn(`[Socket] Heartbeat error for transporter ${userId}: ${e.message}`);
          }
        })();
      }
    });

    // ================================================================
    // PRESENCE RESTORATION ON RECONNECT
    // ================================================================
    // If user was ONLINE before disconnect (DB isAvailable=true),
    // auto-restore Redis presence without requiring button press.
    //
    // DRIVERS: Restores driver:presence:{id} + onlineDrivers set
    // TRANSPORTERS: Restores transporter:presence:{id} + online:transporters set
    // ================================================================
    if (role === 'driver') {
      (async () => {
        try {
          const restored = await getDriverService().restorePresence(userId);
          if (restored) {
            logger.info(`[Socket] ✅ Driver ${userId} presence restored on reconnect`);
          }
        } catch (e: any) {
          logger.warn(`[Socket] Failed to restore driver presence: ${e.message}`);
        }
      })();

      // ================================================================
      // PENDING ASSIGNMENT RE-SEND ON DRIVER RECONNECT
      // ================================================================
      // Industry pattern (Ola, Gojek): When driver's socket reconnects,
      // check if they have a pending assignment and re-emit it with the
      // remaining seconds. Without this, a driver who disconnects for
      // 10 seconds comes back to a blank screen and misses the trip.
      //
      // Same concept as transporter reconnect push (line ~450 below)
      // but for driver assignments instead of broadcasts.
      // ================================================================
      (async () => {
        try {
          const { prismaClient } = await import('../database/prisma.service');
          const pendingAssignment = await prismaClient.assignment.findFirst({
            where: { driverId: userId, status: 'pending' },
            orderBy: { assignedAt: 'desc' }
          });

          if (pendingAssignment) {
            // Calculate remaining seconds — must match the setTimeout timer in queue.service.ts
            // Fix H-X1: Use centralized HOLD_CONFIG instead of local parseInt
            const ASSIGNMENT_TIMEOUT_MS = HOLD_CONFIG.driverAcceptTimeoutMs;
            const assignedAtMs = new Date(pendingAssignment.assignedAt || '').getTime();
            const elapsedMs = Date.now() - assignedAtMs;
            const remainingMs = ASSIGNMENT_TIMEOUT_MS - elapsedMs;

            if (remainingMs > 2000) {
              // Still within timeout window — re-send the assignment
              socket.emit(SocketEvent.ASSIGNMENT_STATUS_CHANGED, {
                assignmentId: pendingAssignment.id,
                tripId: pendingAssignment.tripId,
                bookingId: pendingAssignment.bookingId,
                status: 'pending',
                message: 'New trip assigned to you',
                remainingSeconds: Math.floor(remainingMs / 1000),
                _reconnectDelivery: true
              });
              logger.info(`[Socket] 📡 Re-sent pending assignment ${pendingAssignment.id} to driver ${userId} on reconnect (${Math.floor(remainingMs / 1000)}s remaining)`);
            } else {
              logger.debug(`[Socket] Pending assignment ${pendingAssignment.id} for driver ${userId} has <2s remaining — skipping re-send`);
            }
          }
        } catch (e: any) {
          // Non-critical — driver can still accept via FCM notification
          logger.warn(`[Socket] Failed to re-send pending assignment on reconnect for ${userId}: ${e.message}`);
        }
      })();
    } else if (role === 'transporter') {
      (async () => {
        try {
          const { prismaClient } = await import('../database/prisma.service');
          const transporter = await prismaClient.user.findUnique({
            where: { id: userId },
            select: { isAvailable: true }
          });

          if (transporter?.isAvailable) {
            // Restore Redis presence
            const presenceData = JSON.stringify({
              transporterId: userId,
              restored: true,
              lastHeartbeat: new Date().toISOString()
            });
            await redisService.set(
              TRANSPORTER_PRESENCE_KEY(userId),
              presenceData,
              TRANSPORTER_PRESENCE_TTL
            );
            await redisService.sAdd(ONLINE_TRANSPORTERS_SET, userId);

            logger.info(`[Socket] ✅ Transporter ${userId} presence restored on reconnect`);
          }
        } catch (e: any) {
          logger.warn(`[Socket] Failed to restore transporter presence: ${e.message}`);
        }
      })();

      // ================================================================
      // MID-ORDER BROADCAST DELIVERY ON CONNECT
      // ================================================================
      // When a transporter connects (new session or reconnect), push any
      // currently-active broadcasts directly on their socket so they see
      // live orders immediately without waiting for the next broadcast cycle.
      //
      // Safety design:
      //   - Runs in its own async IIFE, never blocks connection handshake
      //   - try/catch: failure here is silent — client has API reconcile fallback
      //   - _reconnectDelivery: true flag lets client BroadcastFlowCoordinator
      //     deduplicate with any Socket.IO or FCM delivery already in flight
      //   - Capped at MAX_RECONNECT_BROADCASTS to avoid flooding slow connections
      // ================================================================
      (async () => {
        try {
          const { bookingService } = await import('../../modules/booking/booking.service');
          // L-5 FIX: Env-configurable reconnect broadcast cap (was hardcoded 20)
          const MAX_RECONNECT_BROADCASTS = parseInt(process.env.MAX_RECONNECT_BROADCASTS || '50', 10);
          const result = await bookingService.getActiveBroadcasts(userId, { page: 1, limit: MAX_RECONNECT_BROADCASTS });
          // bookingService returns { bookings, total, hasMore }
          const broadcasts = (result as any)?.bookings ?? (result as any)?.broadcasts ?? [];

          if (Array.isArray(broadcasts) && broadcasts.length > 0) {
            logger.info(`[Socket] 📡 Pushing ${broadcasts.length} active broadcast(s) to transporter ${userId} on connect`);
            for (const broadcast of broadcasts) {
              socket.emit(SocketEvent.NEW_BROADCAST, {
                ...(broadcast as object),
                _reconnectDelivery: true,   // dedup flag for client coordinator
                _seq: undefined             // skip sequence numbering for reconcile push
              });
            }
          }
        } catch (e: any) {
          // Non-critical — client BroadcastFlowCoordinator.requestReconcile() is the fallback
          logger.warn(`[Socket] Failed to push active broadcasts on connect for ${userId}: ${e.message}`);
        }
      })();

      // C-6 FIX: Also replay order-path broadcasts (not just booking-path)
      (async () => {
        try {
          const { prismaClient } = await import('../database/prisma.service');
          const activeOrderBroadcasts = await prismaClient.order.findMany({
            where: {
              status: { in: ['searching', 'active'] },
              // Only orders where this transporter was notified
              notifiedTransporters: { has: userId },
            },
            select: {
              id: true,
              status: true,
              customerId: true,
              pickupAddress: true,
              dropAddress: true,
              totalAmount: true,
              createdAt: true,
            },
            // L-5 FIX: Use same configurable cap for order-path replays
            take: parseInt(process.env.MAX_RECONNECT_BROADCASTS || '50', 10),
            orderBy: { createdAt: 'desc' },
          });

          for (const order of activeOrderBroadcasts) {
            emitToUser(userId, 'new_broadcast', {
              orderId: order.id,
              status: order.status,
              pickupAddress: order.pickupAddress,
              dropAddress: order.dropAddress,
              totalAmount: order.totalAmount,
              _reconnectDelivery: true,
              _replayed: true,
            });
          }

          if (activeOrderBroadcasts.length > 0) {
            logger.info(`[Socket] Transporter ${userId} reconnect: replayed ${activeOrderBroadcasts.length} order-path broadcast(s)`);
          }
        } catch (orderReplayErr: any) {
          logger.warn(`[Socket] Order-path reconnect replay failed: ${orderReplayErr?.message}`);
        }
      })();
    } else if (role === 'customer') {
      // ================================================================
      // CUSTOMER ORDER STATE SYNC ON RECONNECT (C-1 FIX)
      // ================================================================
      // When a customer reconnects, push current order state so they
      // see live status immediately. Mirrors transporter reconnect pattern.
      // ================================================================
      (async () => {
        try {
          const { prismaClient } = await import('../database/prisma.service');

          // Find active orders for this customer
          const activeOrders = await prismaClient.order.findMany({
            where: {
              customerId: userId,
              status: { in: ['searching', 'active', 'partially_filled'] },
            },
            include: {
              truckRequests: {
                select: { id: true, status: true, vehicleType: true, quantity: true },
              },
            },
            take: 10,
            orderBy: { createdAt: 'desc' },
          });

          if (activeOrders.length > 0) {
            logger.info(`[Socket] Customer ${userId} reconnected — pushing ${activeOrders.length} active order(s)`);
          }

          for (const order of activeOrders) {
            const confirmedCount = order.truckRequests.filter(
              (tr: any) => tr.status === 'confirmed' || tr.status === 'assigned'
            ).length;
            const totalCount = order.truckRequests.length;

            emitToUser(userId, 'order_state_sync', {
              orderId: order.id,
              status: order.status,
              dispatchState: (order as any).dispatchState || 'unknown',
              trucksConfirmed: confirmedCount,
              totalTrucks: totalCount,
              _reconnectDelivery: true,
              _replayed: true,
            });

            // Re-join customer to order room
            const orderRoom = `order:${order.id}`;
            const userSocketSet = userSockets.get(userId);
            if (userSocketSet) {
              for (const sid of userSocketSet) {
                const s = io?.sockets.sockets.get(sid);
                if (s) s.join(orderRoom);
              }
            }
          }

          // Also check legacy bookings
          try {
            const { bookingService } = await import('../../modules/booking/booking.service');
            const activeBookings = await bookingService.getActiveBroadcasts(userId);
            if (activeBookings && activeBookings.length > 0) {
              for (const booking of (activeBookings as any[]).slice(0, 10)) {
                emitToUser(userId, 'order_state_sync', {
                  orderId: (booking as any).id || (booking as any).bookingId,
                  status: (booking as any).status || 'active',
                  _reconnectDelivery: true,
                  _replayed: true,
                });
              }
            }
          } catch (bookingErr: any) {
            logger.warn(`[Socket] Customer reconnect booking lookup failed: ${bookingErr?.message}`);
          }
        } catch (e: any) {
          logger.warn(`[Socket] Customer reconnect state sync failed: ${e?.message}`);
        }
      })();
    }

    // Handle ping from client (for connection quality) - rate limited
    socket.on('ping', () => {
      if (!checkRateLimit(socket.id, socket.data?.userId)) return;
      socket.emit('pong');
    });

    // Handle joining order room (for multi-truck updates)
    // H-S4 FIX: Verify ownership before allowing room join
    socket.on(SocketEvent.JOIN_ORDER, async (orderId: string) => {
      const joinKey = `${userId}:order:${orderId}`;
      const now = Date.now();
      if (recentJoinAttempts.get(joinKey) && now - recentJoinAttempts.get(joinKey)! < 5000) {
        return; // Debounce: ignore duplicate join within 5s
      }
      recentJoinAttempts.set(joinKey, now);

      try {
        const { prismaClient } = await import('../database/prisma.service');
        const order = await prismaClient.order.findUnique({
          where: { id: orderId },
          select: { customerId: true }
        });
        if (!order) {
          socket.emit(SocketEvent.ERROR, { message: 'Order not found' });
          return;
        }
        if (socket.data.role === 'customer' && order.customerId !== socket.data.userId) {
          socket.emit(SocketEvent.ERROR, { message: 'Unauthorized: not your order' });
          return;
        }
        if (socket.data.role === 'driver' || socket.data.role === 'transporter') {
          const assignment = await prismaClient.assignment.findFirst({
            where: {
              orderId,
              OR: [{ driverId: socket.data.userId }, { transporterId: socket.data.userId }]
            },
            select: { id: true }
          });
          if (!assignment) {
            socket.emit(SocketEvent.ERROR, { message: 'Unauthorized: not assigned to this order' });
            return;
          }
        }
        socket.join(`order:${orderId}`);
        logger.debug(`User ${userId} joined order room: ${orderId}`);
      } catch (err: any) {
        logger.warn(`[Socket] join_order ownership check failed, denying: ${err?.message}`);
        socket.emit(SocketEvent.ERROR, { message: 'Failed to verify order access' });
      }
    });

    // Handle leaving order room
    socket.on(SocketEvent.LEAVE_ORDER, (orderId: string) => {
      socket.leave(`order:${orderId}`);
      logger.debug(`User ${userId} left order room: ${orderId}`);
    });

    // ================================================================
    // PHASE 4: SEQUENCE REPLAY ON RECONNECT (flag-gated)
    // ================================================================
    // If FF_SEQUENCE_DELIVERY_ENABLED and client sends lastSeq in auth,
    // replay all unacked messages with seq > lastSeq.
    // This ensures no message is ever lost, even on 2G reconnect.
    // ================================================================
    // H-9 FIX: Default to ON — opt-out with FF_SEQUENCE_DELIVERY_ENABLED=false
    const FF_SEQ = process.env.FF_SEQUENCE_DELIVERY_ENABLED !== 'false';
    if (FF_SEQ) {
      const lastSeq = Number(socket.handshake.auth?.lastSeq || 0);
      if (lastSeq > 0) {
        (async () => {
          try {
            const unackedKey = `socket:unacked:${userId}`;
            const messages = await redisService.zRangeByScore(
              unackedKey,
              lastSeq + 1,  // min: messages after lastSeq
              '+inf'        // max: all newer messages
            );
            if (messages.length > 0) {
              logger.info(`[Phase4] Replaying ${messages.length} unacked messages for ${userId} (lastSeq=${lastSeq})`);
              for (const msgStr of messages) {
                try {
                  const envelope = JSON.parse(msgStr);
                  socket.emit(envelope.event || 'replay', {
                    ...envelope.payload,
                    _seq: envelope.seq,
                    _replayed: true
                  });
                } catch {
                  // Skip malformed messages
                }
              }
            }
          } catch (replayErr: any) {
            // Replay is best-effort — never block connection
            logger.warn(`[Phase4] Sequence replay failed for ${userId}`, {
              error: replayErr?.message
            });
          }
        })();
      }

      // ACK handler — client sends { seq: N } after processing message
      socket.on(SocketEvent.BROADCAST_ACK, (ackData: { seq?: number }) => {
        const ackSeq = Number(ackData?.seq || 0);
        if (ackSeq <= 0) return;
        // Remove all messages with seq <= ackSeq (cumulative ACK)
        redisService.zRemRangeByScore(
          `socket:unacked:${userId}`,
          0,
          ackSeq
        ).catch((err: any) => {
          logger.warn(`[Phase4] Failed to clear acked messages`, {
            userId, ackSeq, error: err?.message
          });
        });
      });
    }
  });

  logger.info('Socket.IO initialized with optimized settings');

  // FIX A5#11: TTL refresh interval — keep alive counters for active users
  // The 300s TTL ensures counters auto-expire if this instance dies.
  // We only refresh TTL, never overwrite count (safe for multi-instance).
  setInterval(async () => {
    try {
      for (const [userId] of userSockets) {
        const connKey = `socket:conncount:${userId}`;
        await redisService.expire(connKey, CONNECTION_COUNTER_TTL_SECONDS).catch(() => {});
      }
    } catch { /* non-fatal */ }
  }, 60_000).unref();

  // FIX A5#10: Periodic sweep for leaked socket entries
  // Detects socketUsers entries whose socket.io handle no longer exists (disconnect missed)
  setInterval(() => {
    if (!io) return;
    let swept = 0;
    for (const [socketId, data] of socketUsers) {
      if (!io.sockets.sockets.has(socketId)) {
        socketUsers.delete(socketId);
        const userId = typeof data === 'string' ? data : (data as any).userId;
        userSockets.get(userId)?.delete(socketId);
        if (userSockets.get(userId)?.size === 0) userSockets.delete(userId);
        // Decrement Redis connection counter to prevent inflation (QA-6 fix)
        const connKey = `socket:conncount:${userId}`;
        redisService.incrBy(connKey, -1).catch(() => {});
        swept++;
      }
    }
    if (swept > 0) logger.info(`[Socket] Swept ${swept} leaked socket entries`);
  }, 5 * 60_000).unref();

  // F-4-20 FIX: Periodic reconciliation of roleCounters (every 60s)
  setInterval(() => {
    if (!io) return;
    const counted = { customers: 0, transporters: 0, drivers: 0 };
    for (const [, socket] of io.sockets.sockets) {
      const r = socket.data?.role;
      if (r === 'customer') counted.customers++;
      else if (r === 'transporter') counted.transporters++;
      else if (r === 'driver') counted.drivers++;
    }
    const hasDrift = roleCounters.customers !== counted.customers ||
      roleCounters.transporters !== counted.transporters ||
      roleCounters.drivers !== counted.drivers;
    if (hasDrift) {
      logger.warn('[Socket] roleCounters drift detected — reconciling', {
        before: { ...roleCounters }, actual: counted
      });
    }
    roleCounters.customers = counted.customers;
    roleCounters.transporters = counted.transporters;
    roleCounters.drivers = counted.drivers;
  }, 60_000).unref();

  // Wire @socket.io/redis-adapter for cross-instance delivery
  // All io.to(room).emit() calls automatically sync across ECS tasks
  setupRedisAdapter(io);

  return io;
}

// =============================================================================
// REDIS STREAMS ADAPTER SETUP
// =============================================================================
// Uses @socket.io/redis-streams-adapter instead of @socket.io/redis-adapter.
// WHY: The original adapter needs PSUBSCRIBE, which ElastiCache Serverless
//      rejects → cross-instance delivery was silently DISABLED.
// FIX: Redis Streams adapter uses XADD/XREAD — fully supported by ElastiCache
//      Serverless. Same sub-millisecond latency, zero packet loss on Redis
//      reconnects (streams persist, unlike pub/sub fire-and-forget).
// =============================================================================

async function setupRedisAdapter(socketServer: Server): Promise<void> {
  if (process.env.REDIS_ENABLED !== 'true') {
    redisPubSubInitialized = false;
    redisAdapterMode = 'disabled';
    redisAdapterLastError = null;
    logger.info('[Socket] REDIS_ENABLED is not true — single-instance mode');
    return;
  }

  // Explicit opt-out (e.g., for local dev without Redis)
  if (process.env.REDIS_PUBSUB_DISABLED === 'true') {
    redisPubSubInitialized = false;
    redisAdapterMode = 'disabled_by_config';
    redisAdapterLastError = null;
    logger.info('[Socket] REDIS_PUBSUB_DISABLED=true — single-instance mode');
    return;
  }

  // Retry with backoff — Redis may not be ready at ECS task startup
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Redis Streams adapter only needs ONE Redis client (not pub+sub pair).
      // It reuses the existing redisService connection → no extra connections.
      // Uses XADD/XREAD (Redis Streams) instead of PSUBSCRIBE:
      //   - Works with ElastiCache Serverless out of the box
      //   - Resilient to temporary Redis disconnects (resumes stream)
      //   - Same sub-ms latency as pub/sub — zero performance impact
      const client = redisService.getClient();
      if (!client) {
        throw new Error('Redis client not available — redisService may not be initialized yet');
      }

      socketServer.adapter(createAdapter(client));

      redisPubSubInitialized = true;
      redisAdapterMode = 'enabled';
      redisAdapterLastError = null;
      logger.info(`[Socket] Redis Streams adapter initialized (Instance: ${SERVER_INSTANCE_ID}) [attempt ${attempt}/${MAX_RETRIES}]`);
      logger.info('   Cross-instance WebSocket delivery ENABLED (ElastiCache Serverless compatible)');
      return; // Success — exit retry loop
    } catch (error: any) {
      redisAdapterLastError = error?.message || 'unknown';
      logger.warn(`[Socket] Redis Streams adapter attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`);

      if (attempt < MAX_RETRIES) {
        logger.info(`[Socket] Retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  // All retries exhausted
  redisPubSubInitialized = false;
  redisAdapterMode = 'failed';
  logger.error(`[Socket] Redis Streams adapter failed after ${MAX_RETRIES} attempts: ${redisAdapterLastError}`);
  logger.warn('[Socket] Falling back to single-instance mode — cross-task socket delivery disabled');
  // FIX A5#5: Track adapter failures in metrics for alerting
  try { const { metrics } = require('../monitoring/metrics.service'); metrics.incrementCounter('socket_adapter_failure_total'); } catch { }

  // Fix H-R4: Schedule periodic reconnection attempts (every 30s)
  const ADAPTER_RECONNECT_INTERVAL_MS = 30_000;
  if (adapterReconnectTimer) clearInterval(adapterReconnectTimer);
  adapterReconnectTimer = setInterval(async () => {
    if (redisAdapterMode === 'enabled') {
      if (adapterReconnectTimer) clearInterval(adapterReconnectTimer);
      adapterReconnectTimer = null;
      return;
    }
    try {
      const client = redisService.getClient();
      if (!client || !io) return;
      io.adapter(createAdapter(client));
      redisPubSubInitialized = true;
      redisAdapterMode = 'enabled';
      redisAdapterLastError = null;
      logger.info('[Socket] Redis Streams adapter RECOVERED via background reconnect');
      try { const { metrics } = require('../monitoring/metrics.service'); metrics.incrementCounter('socket_adapter_recovery_total'); } catch { }
      if (adapterReconnectTimer) clearInterval(adapterReconnectTimer);
      adapterReconnectTimer = null;
    } catch (err: any) {
      redisAdapterLastError = err?.message || 'unknown';
      logger.warn(`[Socket] Adapter reconnect attempt failed: ${err?.message}`);
    }
  }, ADAPTER_RECONNECT_INTERVAL_MS);
  adapterReconnectTimer.unref();
}

// M-17 FIX: Cross-instance sequence counter via Redis range pre-fetch
// Uses Twitter Snowflake-style range allocation: pre-fetch a batch of sequence
// numbers from Redis INCRBY, then hand them out locally without per-event I/O.
// Falls back to local-only counter if Redis is unavailable (fail-open).
const SEQ_BATCH_SIZE = 1000;
let seqRangeStart = 0;
let seqRangeEnd = 0;
let currentSeq = 0;
let seqFetchInFlight = false;

function getNextSequenceSync(): number {
  if (currentSeq >= seqRangeEnd && !seqFetchInFlight) {
    // Asynchronously fetch next batch (non-blocking, fire-and-forget)
    seqFetchInFlight = true;
    redisService.incrBy('socket:global_seq', SEQ_BATCH_SIZE)
      .then((newEnd) => {
        seqRangeStart = newEnd - SEQ_BATCH_SIZE;
        seqRangeEnd = newEnd;
        currentSeq = seqRangeStart;
      })
      .catch(() => { /* fail-open: local counter continues */ })
      .finally(() => { seqFetchInFlight = false; });
  }
  return ++currentSeq;
}

function withSocketMeta(data: any): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'eventVersion') ||
    Object.prototype.hasOwnProperty.call(data, 'serverTimeMs')) {
    return data;
  }
  return {
    ...data,
    eventVersion: SOCKET_EVENT_VERSION,
    serverTimeMs: Date.now(),
    _seq: getNextSequenceSync()
  };
}

/**
 * Emit to a specific user (by userId)
 * Used to send notifications to specific transporters
 * 
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery.
 * io.to(room).emit() publishes to Redis streams → all instances deliver.
 * 
 * NOTE: rooms.get() only returns LOCAL sockets. With multi-server (ECS 2+ tasks),
 * the transporter may be connected to another instance. NEVER return early based
 * on local room count — always let io.to().emit() fire through the adapter.
 */
// Fix E7: Return boolean — false when io=null, true on success
export function emitToUser(userId: string, event: string, data: any): boolean {
  if (!io) {
    logger.error(`[emitToUser] Socket.IO not initialized! Cannot emit ${event} to ${userId}`);
    return false;
  }

  // Observability: log local socket count (may be 0 in multi-server — that's OK)
  const localSocketCount = userSockets.get(userId)?.size || 0;

  if (localSocketCount === 0) {
    logger.debug(`[emitToUser] No LOCAL sockets for user:${userId} — ${event} will route via Redis adapter to other instances`);
  }

  // ALWAYS emit — Redis adapter handles cross-instance delivery
  io.to(`user:${userId}`).emit(event, withSocketMeta(data));

  logger.debug(`[Socket] Emitted ${event} to user:${userId} (${localSocketCount} local sockets)`);
  return true;
}

/**
 * Emit to all sockets in a booking room
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToBooking(bookingId: string, event: string, data: any): void {
  if (!io) return;
  io.to(`booking:${bookingId}`).emit(event, withSocketMeta(data));
  logger.debug(`Emitted ${event} to booking ${bookingId}`);
}

/**
 * Emit to all sockets in a trip room
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToTrip(tripId: string, event: string, data: any): void {
  if (!io) return;
  const roomName = `trip:${tripId}`;

  // Fix H-R1: Skip serialization for high-frequency location updates to empty rooms.
  // Status change events MUST always go through adapter for cross-instance delivery.
  if (event === SocketEvent.LOCATION_UPDATED) {
    const room = io.of('/').adapter.rooms?.get(roomName);
    if (!room || room.size === 0) return;
  }

  io.to(roomName).emit(event, withSocketMeta(data));
}

/**
 * Emit to all connected clients
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToAll(event: string, data: any): void {
  if (!io) return;
  io.emit(event, withSocketMeta(data));
  logger.debug(`Broadcast ${event} to all clients`);
}

/**
 * Get connected user count
 */
export function getConnectedUserCount(): number {
  return userSockets.size;
}

/**
 * Check if user has active socket connections on THIS instance.
 * WARNING: In multi-instance mode, this only checks the local instance.
 * For cross-instance checks, use io.in('user:' + userId).fetchSockets()
 * which queries all instances via the Redis adapter.
 */
export function isUserConnected(userId: string): boolean {
  return userSockets.has(userId) && userSockets.get(userId)!.size > 0;
}

/**
 * Get Socket.IO instance
 */
export function getIO(): Server | null {
  return io;
}

/**
 * Emit to all sockets in an order room
 * Used for multi-truck request updates
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToOrder(orderId: string, event: string, data: any): void {
  if (!io) return;
  io.to(`order:${orderId}`).emit(event, withSocketMeta(data));
  logger.debug(`Emitted ${event} to order ${orderId}`);
}

/**
 * Get detailed connection statistics
 * Industry Standard: DoorDash O(1) counters - eliminates O(n) forEach traversal
 * At 50k connections: O(n) = ~5-10ms blocked, O(1) = ~0.01ms (500x faster)
 */
export function getConnectionStats(): ConnectionStats {
  const socketCount = io?.sockets.sockets.size || 0;

  return {
    totalConnections: socketCount,
    uniqueUsers: userSockets.size,
    // O(1) lookup instead of O(n) forEach - DoorDash pattern
    connectionsByRole: {
      customers: roleCounters.customers,
      transporters: roleCounters.transporters,
      drivers: roleCounters.drivers
    },
    roomCount: io?.sockets.adapter.rooms.size || 0
  };
}

/**
 * Broadcast to multiple users efficiently
 * Used when notifying many transporters about a new order
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToUsers(userIds: string[], event: string, data: any): void {
  if (!io || userIds.length === 0) return;

  const uniqueUserIds = Array.from(new Set(userIds));
  const payload = withSocketMeta(data);
  const userRooms = uniqueUserIds.map((userId) => `user:${userId}`);
  const chunkSize = SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE;

  // A5#24: Socket.IO internally buffers — synchronous loop queues messages.
  // Yielding deferred to future scale (1000+ users). Current callers are sync fire-and-forget.
  for (let index = 0; index < userRooms.length; index += chunkSize) {
    const roomChunk = userRooms.slice(index, index + chunkSize);
    io.to(roomChunk).emit(event, payload);
  }

  logger.debug(`Batch emitted ${event} to ${uniqueUserIds.length} users`);
}

/**
 * Emit to a specific room (e.g., booking:123, trip:456)
 * Used for group notifications like booking updates
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToRoom(room: string, event: string, data: any): void {
  if (!io) return;

  io.to(room).emit(event, withSocketMeta(data));

  logger.debug(`Emitted ${event} to room ${room}`);
}

/**
 * Broadcast to all transporters
 * Used for system-wide announcements
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToAllTransporters(event: string, data: any): void {
  if (!io) return;

  io.to('role:transporter').emit(event, withSocketMeta(data));
  logger.debug(`Broadcast ${event} to transporters`);
}

/**
 * Emit to all drivers belonging to a specific transporter
 *
 * This is CRITICAL for the transporter→driver flow - ensures notifications reach
 * only the drivers who work for that transporter.
 *
 * @param transporterId The transporter's UUID
 * @param event Socket.IO event name
 * @param data Event payload
 */
export function emitToTransporterDrivers(transporterId: string, event: string, data: any): void {
  if (!io) return;

  // Emit to all drivers in transporter room
  io.to(`transporter:${transporterId}`).emit(event, withSocketMeta(data));

  logger.debug(`Emitted ${event} to drivers of transporter:${transporterId}`);
}

export function getRedisAdapterStatus(): {
  enabled: boolean;
  mode: 'enabled' | 'disabled' | 'disabled_by_config' | 'disabled_by_capability' | 'failed';
  lastError: string | null;
} {
  return {
    enabled: redisPubSubInitialized,
    mode: redisAdapterMode,
    lastError: redisAdapterLastError
  };
}

// Types
interface ConnectionStats {
  totalConnections: number;
  uniqueUsers: number;
  connectionsByRole: {
    customers: number;
    transporters: number;
    drivers: number;
  };
  roomCount: number;
}

// =============================================================================
// SOCKET SERVICE OBJECT - Convenience wrapper for all functions
// =============================================================================

/**
 * Socket Service singleton object
 * Provides a unified interface for all socket operations
 */
export const socketService = {
  // Initialization
  initialize: initializeSocket,
  getIO,

  // Emit functions
  emitToUser,
  emitToUsers,
  emitToBooking,
  emitToTrip,
  emitToOrder,
  emitToRoom,
  emitToAll,
  emitToAllTransporters,

  // Alias for emitToAll (used by truck-hold service)
  broadcastToAll: emitToAll,

  // Connection utilities
  isUserConnected,
  getConnectedUserCount,
  getConnectionStats,

  // Server instance ID (for debugging)
  getServerInstanceId: () => SERVER_INSTANCE_ID,

  // Redis adapter status
  isRedisPubSubEnabled: () => redisPubSubInitialized,
  getRedisAdapterStatus,

  // Emit to transporter's drivers
  emitToTransporterDrivers,
};

export function cleanupAdapterReconnect(): void {
  if (adapterReconnectTimer) {
    clearInterval(adapterReconnectTimer);
    adapterReconnectTimer = null;
  }
}
