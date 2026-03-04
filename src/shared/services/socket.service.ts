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
import { logger } from './logger.service';
import { redisService } from './redis.service';
import {
  TRANSPORTER_PRESENCE_KEY,
  PRESENCE_TTL_SECONDS as TRANSPORTER_PRESENCE_TTL,
  ONLINE_TRANSPORTERS_SET
} from './transporter-online.service';

// Lazy import to avoid circular dependency (socket.service ↔ driver.service)
let _driverService: any = null;
function getDriverService() {
  if (!_driverService) {
    _driverService = require('../../modules/driver/driver.service').driverService;
  }
  return _driverService;
}

let io: Server | null = null;

// Track user connections
const userSockets = new Map<string, Set<string>>();  // userId -> Set of socketIds
const socketUsers = new Map<string, string>();        // socketId -> userId

// Max WebSocket connections per user — prevents memory exhaustion from malicious clients.
// Normal usage: 1-2 connections (app foreground + background reconnect).
// 5 allows multi-device + reconnect overlap without abuse.
const MAX_CONNECTIONS_PER_USER = 5;

// Server instance ID (for debugging multi-server issues)
const SERVER_INSTANCE_ID = `server_${process.pid}_${Date.now().toString(36)}`;

// Flag to track if Redis adapter is initialized
let redisPubSubInitialized = false;
let redisAdapterMode: 'enabled' | 'disabled' | 'disabled_by_config' | 'disabled_by_capability' | 'failed' = 'disabled';
let redisAdapterLastError: string | null = null;
const SOCKET_EVENT_VERSION = 1;
const SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE = Math.max(
  25,
  parseInt(process.env.SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE || '300', 10) || 300
);

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
  LOCATION_UPDATED: 'location_updated',
  ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
  NEW_BROADCAST: 'new_broadcast',

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

  // Client -> Server
  JOIN_BOOKING: 'join_booking',
  LEAVE_BOOKING: 'leave_booking',
  JOIN_ORDER: 'join_order',                     // Join order room for updates
  LEAVE_ORDER: 'leave_order',
  UPDATE_LOCATION: 'update_location',
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
    pingTimeout: 10000,           // 10s - Detect dead sockets faster (was 20s)
    pingInterval: 12000,          // 12s - Probe more frequently (was 25s)
    upgradeTimeout: 10000,        // 10s - Timeout for upgrade

    // Transports - WebSocket preferred
    transports: ['websocket', 'polling'],
    allowUpgrades: true,

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

  // Authentication middleware
  io.use((socket, next) => {
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
      await redisService.expire(connKey, 3600); // 1hr TTL (auto-cleanup)
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

    // Send confirmation
    socket.emit(SocketEvent.CONNECTED, {
      message: 'Connected successfully',
      userId,
      role
    });

    // Handle joining booking room
    socket.on(SocketEvent.JOIN_BOOKING, (bookingId: string) => {
      socket.join(`booking:${bookingId}`);
      logger.debug(`User ${userId} joined booking room: ${bookingId}`);
    });

    // Handle leaving booking room
    socket.on(SocketEvent.LEAVE_BOOKING, (bookingId: string) => {
      socket.leave(`booking:${bookingId}`);
      logger.debug(`User ${userId} left booking room: ${bookingId}`);
    });

    // Handle location updates (from drivers)
    socket.on(SocketEvent.UPDATE_LOCATION, (data: {
      tripId: string;
      latitude: number;
      longitude: number;
      speed?: number;
      bearing?: number;
    }) => {
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

      // Remove from tracking
      const userId = socketUsers.get(socket.id);
      if (userId) {
        userSockets.get(userId)?.delete(socket.id);
        if (userSockets.get(userId)?.size === 0) {
          userSockets.delete(userId);
        }
        // Decrement Redis connection counter (cross-instance tracking)
        try { redisService.incrBy(`socket:conncount:${userId}`, -1).catch(() => { }); } catch { }
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
              // No presence key — transporter is offline, ignore stale heartbeat
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
      //   - Capped at 20 broadcasts to avoid flooding slow connections
      // ================================================================
      (async () => {
        try {
          const { bookingService } = await import('../../modules/booking/booking.service');
          const result = await bookingService.getActiveBroadcasts(userId, { limit: 20 } as any);
          // bookingService returns { bookings, total, hasMore }
          const broadcasts = (result as any)?.bookings ?? (result as any)?.broadcasts ?? [];

          if (Array.isArray(broadcasts) && broadcasts.length > 0) {
            logger.info(`[Socket] 📡 Pushing ${broadcasts.length} active broadcast(s) to transporter ${userId} on connect`);
            for (const broadcast of broadcasts) {
              socket.emit('new_broadcast', {
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
    }

    // Handle ping from client (for connection quality)
    socket.on('ping', () => {
      socket.emit('pong');
    });

    // Handle joining order room (for multi-truck updates)
    socket.on(SocketEvent.JOIN_ORDER, (orderId: string) => {
      socket.join(`order:${orderId}`);
      logger.debug(`User ${userId} joined order room: ${orderId}`);
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
    const FF_SEQ = process.env.FF_SEQUENCE_DELIVERY_ENABLED === 'true';
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
    serverTimeMs: Date.now()
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
export function emitToUser(userId: string, event: string, data: any): void {
  if (!io) {
    logger.error(`[emitToUser] Socket.IO not initialized! Cannot emit ${event} to ${userId}`);
    return;
  }

  // Observability: log local socket count (may be 0 in multi-server — that's OK)
  const localSocketCount = userSockets.get(userId)?.size || 0;

  if (localSocketCount === 0) {
    logger.debug(`[emitToUser] No LOCAL sockets for user:${userId} — ${event} will route via Redis adapter to other instances`);
  }

  // ALWAYS emit — Redis adapter handles cross-instance delivery
  io.to(`user:${userId}`).emit(event, withSocketMeta(data));

  logger.debug(`[Socket] Emitted ${event} to user:${userId} (${localSocketCount} local sockets)`);
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
  io.to(`trip:${tripId}`).emit(event, withSocketMeta(data));
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
 * Check if user is connected
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
 * Useful for monitoring and debugging
 */
export function getConnectionStats(): ConnectionStats {
  const socketCount = io?.sockets.sockets.size || 0;

  // Count by role
  let customers = 0;
  let transporters = 0;
  let drivers = 0;

  io?.sockets.sockets.forEach(socket => {
    switch (socket.data.role) {
      case 'customer': customers++; break;
      case 'transporter': transporters++; break;
      case 'driver': drivers++; break;
    }
  });

  return {
    totalConnections: socketCount,
    uniqueUsers: userSockets.size,
    connectionsByRole: {
      customers,
      transporters,
      drivers
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

  for (let index = 0; index < userRooms.length; index += SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE) {
    const roomChunk = userRooms.slice(index, index + SOCKET_MULTI_ROOM_EMIT_CHUNK_SIZE);
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
};
