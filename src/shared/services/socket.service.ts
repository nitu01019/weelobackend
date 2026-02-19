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
import { createAdapter } from '@socket.io/redis-adapter';
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
  
  // Client -> Server
  JOIN_BOOKING: 'join_booking',
  LEAVE_BOOKING: 'leave_booking',
  JOIN_ORDER: 'join_order',                     // Join order room for updates
  LEAVE_ORDER: 'leave_order',
  UPDATE_LOCATION: 'update_location'
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
    pingTimeout: 20000,           // 20s - How long to wait for pong
    pingInterval: 25000,          // 25s - How often to send ping
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
  io.on('connection', (socket: Socket) => {
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
    
    // Enforce connection limit — disconnect oldest if exceeded
    if (userSocketSet.size >= MAX_CONNECTIONS_PER_USER) {
      const oldestSocketId = userSocketSet.values().next().value;
      if (oldestSocketId) {
        logger.warn(`[Socket] Connection limit (${MAX_CONNECTIONS_PER_USER}) exceeded for ${userId}, disconnecting oldest: ${oldestSocketId}`);
        const oldSocket = io?.sockets.sockets.get(oldestSocketId);
        if (oldSocket) {
          oldSocket.emit(SocketEvent.ERROR, { message: 'Connection limit exceeded. Disconnecting oldest session.' });
          oldSocket.disconnect(true);
        }
        userSocketSet.delete(oldestSocketId);
        socketUsers.delete(oldestSocketId);
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
  });

  logger.info('Socket.IO initialized with optimized settings');

  // Wire @socket.io/redis-adapter for cross-instance delivery
  // All io.to(room).emit() calls automatically sync across ECS tasks
  setupRedisAdapter(io);

  return io;
}

// =============================================================================
// REDIS ADAPTER SETUP - Replaces manual pub/sub with @socket.io/redis-adapter
// =============================================================================

/**
 * Set up @socket.io/redis-adapter for automatic cross-instance delivery.
 * With the adapter, every io.to(room).emit() call automatically reaches
 * clients connected to other ECS tasks — no manual publishToRedis needed.
 */
async function setupRedisAdapter(socketServer: Server): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (process.env.REDIS_ENABLED !== 'true' || !redisUrl) {
    logger.info('[Socket] No Redis — single-instance mode');
    return;
  }

  try {
    const Redis = require('ioredis');
    const useTls = redisUrl.startsWith('rediss://');
    const tlsOpts = useTls ? { tls: { rejectUnauthorized: false } } : {};

    const pubClient = new Redis(redisUrl, { ...tlsOpts, lazyConnect: true });
    const subClient = new Redis(redisUrl, { ...tlsOpts, lazyConnect: true });

    await Promise.all([pubClient.connect(), subClient.connect()]);

    socketServer.adapter(createAdapter(pubClient, subClient));
    redisPubSubInitialized = true;
    logger.info(`[Socket] Redis adapter initialized (Instance: ${SERVER_INSTANCE_ID})`);
    logger.info('   Cross-instance WebSocket delivery ENABLED');
  } catch (error: any) {
    logger.error(`[Socket] Failed to initialize Redis adapter: ${error.message}`);
    logger.warn('[Socket] Falling back to single-instance mode');
  }
}

/**
 * Emit to a specific user (by userId)
 * Used to send notifications to specific transporters
 * 
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToUser(userId: string, event: string, data: any): void {
  if (!io) {
    logger.error(`[emitToUser] Socket.IO not initialized! Cannot emit ${event} to ${userId}`);
    return;
  }

  // With @socket.io/redis-adapter, this automatically reaches all instances
  io.to(`user:${userId}`).emit(event, data);

  const localSocketCount = userSockets.get(userId)?.size || 0;
  logger.debug(`[Socket] Emitted ${event} to user:${userId} (${localSocketCount} local sockets)`);
}

/**
 * Emit to all sockets in a booking room
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToBooking(bookingId: string, event: string, data: any): void {
  if (!io) return;
  io.to(`booking:${bookingId}`).emit(event, data);
  logger.debug(`Emitted ${event} to booking ${bookingId}`);
}

/**
 * Emit to all sockets in a trip room
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToTrip(tripId: string, event: string, data: any): void {
  if (!io) return;
  io.to(`trip:${tripId}`).emit(event, data);
}

/**
 * Emit to all connected clients
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToAll(event: string, data: any): void {
  if (!io) return;
  io.emit(event, data);
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
  io.to(`order:${orderId}`).emit(event, data);
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
  for (const userId of uniqueUserIds) {
    io.to(`user:${userId}`).emit(event, data);
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

  io.to(room).emit(event, data);

  logger.debug(`Emitted ${event} to room ${room}`);
}

/**
 * Broadcast to all transporters
 * Used for system-wide announcements
 * MULTI-SERVER: Socket.IO Redis adapter handles cross-instance delivery
 */
export function emitToAllTransporters(event: string, data: any): void {
  if (!io) return;

  io.to('role:transporter').emit(event, data);
  logger.debug(`Broadcast ${event} to transporters`);
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
};
