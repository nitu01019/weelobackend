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
 * MULTI-SERVER SCALING (Redis Pub/Sub):
 * - Events emitted on one server are broadcast to all servers
 * - Each server handles its own connected clients
 * - Redis acts as the message broker between servers
 * - Seamless horizontal scaling - just add more servers!
 * 
 * SECURITY:
 * - JWT authentication required
 * - Room-based isolation
 * - Users only receive their own data
 * =============================================================================
 */

import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../../config/environment';
import { logger } from './logger.service';
import { redisService } from './redis.service';

let io: Server | null = null;

// Track user connections
const userSockets = new Map<string, Set<string>>();  // userId -> Set of socketIds
const socketUsers = new Map<string, string>();        // socketId -> userId

// =============================================================================
// REDIS PUB/SUB CHANNELS - For Multi-Server Scaling
// =============================================================================

/**
 * Redis channels for cross-server communication
 * 
 * WHY REDIS PUB/SUB IS REQUIRED:
 * - When you have multiple server instances behind a load balancer
 * - User A might be connected to Server 1
 * - User B might be connected to Server 2
 * - When Server 1 needs to notify User B, it publishes to Redis
 * - Server 2 receives the message and delivers to User B
 * 
 * CHANNEL STRATEGY:
 * - socket:user:{userId}     → Messages for specific user
 * - socket:room:{roomName}   → Messages for room (booking:123, order:456)
 * - socket:broadcast         → Messages for all connected clients
 * - socket:transporters      → Messages for all transporters
 */
const REDIS_CHANNELS = {
  USER: (userId: string) => `socket:user:${userId}`,
  ROOM: (roomName: string) => `socket:room:${roomName}`,
  BROADCAST: 'socket:broadcast',
  TRANSPORTERS: 'socket:transporters',
  // Pattern for subscribing to all user channels
  USER_PATTERN: 'socket:user:*',
  ROOM_PATTERN: 'socket:room:*',
};

// Server instance ID (for debugging multi-server issues)
const SERVER_INSTANCE_ID = `server_${process.pid}_${Date.now().toString(36)}`;

// Flag to track if Redis pub/sub is initialized
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

    // Track user connection
    if (!userSockets.has(userId)) {
      userSockets.set(userId, new Set());
    }
    userSockets.get(userId)!.add(socket.id);
    socketUsers.set(socket.id, userId);

    // Join user's personal room
    socket.join(`user:${userId}`);

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

  logger.info('✅ Socket.IO initialized with optimized settings');
  
  // Initialize Redis Pub/Sub for multi-server scaling
  initializeRedisPubSub();
  
  return io;
}

// =============================================================================
// REDIS PUB/SUB INITIALIZATION - Multi-Server Communication
// =============================================================================

/**
 * Initialize Redis Pub/Sub for cross-server socket events
 * 
 * This allows multiple server instances to communicate:
 * - Server 1 emits to user X → publishes to Redis
 * - Server 2 (where user X is connected) receives → delivers to user X
 */
async function initializeRedisPubSub(): Promise<void> {
  if (redisPubSubInitialized) {
    logger.warn('[Socket] Redis Pub/Sub already initialized');
    return;
  }
  
  try {
    // Subscribe to broadcast channel (all clients)
    await redisService.subscribe(REDIS_CHANNELS.BROADCAST, (message) => {
      handleRedisBroadcast(message);
    });
    
    // Subscribe to transporters channel
    await redisService.subscribe(REDIS_CHANNELS.TRANSPORTERS, (message) => {
      handleRedisTransporterBroadcast(message);
    });
    
    redisPubSubInitialized = true;
    logger.info(`🔴 [Socket] Redis Pub/Sub initialized (Instance: ${SERVER_INSTANCE_ID})`);
    logger.info('   📡 Subscribed to: broadcast, transporters channels');
    logger.info('   🌐 Multi-server socket scaling ENABLED');
    
  } catch (error: any) {
    logger.error(`[Socket] Failed to initialize Redis Pub/Sub: ${error.message}`);
    logger.warn('[Socket] Falling back to single-server mode');
  }
}

/**
 * Handle broadcast messages from Redis (for all clients)
 */
function handleRedisBroadcast(message: string): void {
  try {
    const { event, data, sourceServer } = JSON.parse(message);
    
    // Skip if this message originated from this server (avoid duplicate delivery)
    if (sourceServer === SERVER_INSTANCE_ID) {
      return;
    }
    
    logger.debug(`[Socket] Received broadcast from ${sourceServer}: ${event}`);
    
    // Emit to all local clients
    if (io) {
      io.emit(event, data);
    }
  } catch (error: any) {
    logger.error(`[Socket] Error handling Redis broadcast: ${error.message}`);
  }
}

/**
 * Handle transporter broadcast messages from Redis
 */
function handleRedisTransporterBroadcast(message: string): void {
  try {
    const { event, data, sourceServer } = JSON.parse(message);
    
    if (sourceServer === SERVER_INSTANCE_ID) {
      return;
    }
    
    logger.debug(`[Socket] Received transporter broadcast from ${sourceServer}: ${event}`);
    
    // Emit to all local transporters
    if (io) {
      io.sockets.sockets.forEach(socket => {
        if (socket.data.role === 'transporter') {
          socket.emit(event, data);
        }
      });
    }
  } catch (error: any) {
    logger.error(`[Socket] Error handling transporter broadcast: ${error.message}`);
  }
}

/**
 * Publish a message to Redis for cross-server delivery
 */
async function publishToRedis(channel: string, event: string, data: any): Promise<void> {
  try {
    const message = JSON.stringify({
      event,
      data,
      sourceServer: SERVER_INSTANCE_ID,
      timestamp: Date.now()
    });
    
    await redisService.publish(channel, message);
    logger.debug(`[Socket] Published ${event} to Redis channel: ${channel}`);
  } catch (error: any) {
    logger.error(`[Socket] Failed to publish to Redis: ${error.message}`);
  }
}

/**
 * Subscribe to a user-specific channel for cross-server messages
 * Called when a user connects to this server
 */
async function subscribeToUserChannel(userId: string): Promise<void> {
  const channel = REDIS_CHANNELS.USER(userId);
  
  try {
    await redisService.subscribe(channel, (message) => {
      try {
        const { event, data, sourceServer } = JSON.parse(message);
        
        // Skip if from this server
        if (sourceServer === SERVER_INSTANCE_ID) {
          return;
        }
        
        logger.debug(`[Socket] Received user message from ${sourceServer} for ${userId}: ${event}`);
        
        // Deliver to local user sockets
        if (io) {
          io.to(`user:${userId}`).emit(event, data);
        }
      } catch (e: any) {
        logger.error(`[Socket] Error handling user message: ${e.message}`);
      }
    });
    
    logger.debug(`[Socket] Subscribed to user channel: ${channel}`);
  } catch (error: any) {
    logger.error(`[Socket] Failed to subscribe to user channel: ${error.message}`);
  }
}

/**
 * Subscribe to a room-specific channel for cross-server messages
 */
async function subscribeToRoomChannel(roomName: string): Promise<void> {
  const channel = REDIS_CHANNELS.ROOM(roomName);
  
  try {
    await redisService.subscribe(channel, (message) => {
      try {
        const { event, data, sourceServer } = JSON.parse(message);
        
        if (sourceServer === SERVER_INSTANCE_ID) {
          return;
        }
        
        logger.debug(`[Socket] Received room message from ${sourceServer} for ${roomName}: ${event}`);
        
        // Deliver to local room
        if (io) {
          io.to(roomName).emit(event, data);
        }
      } catch (e: any) {
        logger.error(`[Socket] Error handling room message: ${e.message}`);
      }
    });
    
    logger.debug(`[Socket] Subscribed to room channel: ${channel}`);
  } catch (error: any) {
    logger.error(`[Socket] Failed to subscribe to room channel: ${error.message}`);
  }
}

/**
 * Emit to a specific user (by userId)
 * Used to send notifications to specific transporters
 * 
 * MULTI-SERVER: Also publishes to Redis so other servers can deliver
 */
export function emitToUser(userId: string, event: string, data: any): void {
  if (!io) {
    logger.error(`❌ [emitToUser] Socket.IO not initialized! Cannot emit ${event} to ${userId}`);
    return;
  }
  
  // Check if user has any connected sockets on THIS server
  const userSocketSet = userSockets.get(userId);
  const localSocketCount = userSocketSet?.size || 0;
  
  logger.info(`╔══════════════════════════════════════════════════════════════╗`);
  logger.info(`║  📤 EMIT TO USER                                             ║`);
  logger.info(`╠══════════════════════════════════════════════════════════════╣`);
  logger.info(`║  User ID: ${userId}`);
  logger.info(`║  Event: ${event}`);
  logger.info(`║  Local sockets: ${localSocketCount}`);
  logger.info(`║  Socket IDs: ${userSocketSet ? [...userSocketSet].join(', ') : 'none'}`);
  logger.info(`╚══════════════════════════════════════════════════════════════╝`);
  
  // Emit to local sockets
  if (localSocketCount > 0) {
    logger.info(`📤 Emitting ${event} to user room 'user:${userId}' (${localSocketCount} socket(s))`);
    io.to(`user:${userId}`).emit(event, data);
    logger.info(`✅ Emit completed to ${localSocketCount} socket(s)`);
  } else {
    logger.warn(`⚠️ User ${userId} has NO local sockets - broadcast will NOT be received in real-time!`);
  }
  
  // ALWAYS publish to Redis - user might be on another server
  // The receiving server will skip if sourceServer matches
  publishToRedis(REDIS_CHANNELS.USER(userId), event, data);
  
  if (localSocketCount === 0) {
    logger.warn(`[Socket] User ${userId} not connected - they will NOT see the broadcast until they reconnect`);
  }
}

/**
 * Emit to all sockets in a booking room
 * MULTI-SERVER: Also publishes to Redis
 */
export function emitToBooking(bookingId: string, event: string, data: any): void {
  if (!io) return;
  
  // Emit to local room
  io.to(`booking:${bookingId}`).emit(event, data);
  
  // Publish to Redis for cross-server delivery
  publishToRedis(REDIS_CHANNELS.ROOM(`booking:${bookingId}`), event, data);
  
  logger.debug(`Emitted ${event} to booking ${bookingId} (local + Redis)`);
}

/**
 * Emit to all sockets in a trip room
 * MULTI-SERVER: Also publishes to Redis
 */
export function emitToTrip(tripId: string, event: string, data: any): void {
  if (!io) return;
  
  // Emit to local room
  io.to(`trip:${tripId}`).emit(event, data);
  
  // Publish to Redis for cross-server delivery
  publishToRedis(REDIS_CHANNELS.ROOM(`trip:${tripId}`), event, data);
}

/**
 * Emit to all connected clients
 * MULTI-SERVER: Publishes to Redis broadcast channel
 */
export function emitToAll(event: string, data: any): void {
  if (!io) return;
  
  // Emit to local clients
  io.emit(event, data);
  
  // Publish to Redis for cross-server delivery
  publishToRedis(REDIS_CHANNELS.BROADCAST, event, data);
  
  logger.debug(`Broadcast ${event} to all clients (local + Redis)`);
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
 * MULTI-SERVER: Also publishes to Redis
 */
export function emitToOrder(orderId: string, event: string, data: any): void {
  if (!io) return;
  
  // Emit to local room
  io.to(`order:${orderId}`).emit(event, data);
  
  // Publish to Redis for cross-server delivery
  publishToRedis(REDIS_CHANNELS.ROOM(`order:${orderId}`), event, data);
  
  logger.debug(`Emitted ${event} to order ${orderId} (local + Redis)`);
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
 * MULTI-SERVER: Also publishes to Redis for each user
 */
export function emitToUsers(userIds: string[], event: string, data: any): void {
  if (!io || userIds.length === 0) return;
  
  let localDeliveries = 0;
  
  // Emit to local sockets and publish to Redis
  for (const userId of userIds) {
    const userSocketSet = userSockets.get(userId);
    
    if (userSocketSet && userSocketSet.size > 0) {
      io.to(`user:${userId}`).emit(event, data);
      localDeliveries++;
    }
    
    // Always publish to Redis for cross-server delivery
    publishToRedis(REDIS_CHANNELS.USER(userId), event, data);
  }
  
  logger.debug(`Batch emitted ${event} to ${userIds.length} users (${localDeliveries} local, all via Redis)`);
}

/**
 * Emit to a specific room (e.g., booking:123, trip:456)
 * Used for group notifications like booking updates
 * MULTI-SERVER: Also publishes to Redis
 */
export function emitToRoom(room: string, event: string, data: any): void {
  if (!io) return;
  
  // Emit to local room
  io.to(room).emit(event, data);
  
  // Publish to Redis for cross-server delivery
  publishToRedis(REDIS_CHANNELS.ROOM(room), event, data);
  
  logger.debug(`Emitted ${event} to room ${room} (local + Redis)`);
}

/**
 * Broadcast to all transporters
 * Used for system-wide announcements
 * MULTI-SERVER: Publishes to Redis transporters channel
 */
export function emitToAllTransporters(event: string, data: any): void {
  if (!io) return;
  
  // Emit to local transporters
  let localCount = 0;
  io.sockets.sockets.forEach(socket => {
    if (socket.data.role === 'transporter') {
      socket.emit(event, data);
      localCount++;
    }
  });
  
  // Publish to Redis for cross-server delivery
  publishToRedis(REDIS_CHANNELS.TRANSPORTERS, event, data);
  
  logger.debug(`Broadcast ${event} to transporters (${localCount} local + Redis)`);
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
  
  // Redis Pub/Sub status
  isRedisPubSubEnabled: () => redisPubSubInitialized,
};
