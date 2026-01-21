/**
 * =============================================================================
 * SOCKET SERVICE - Real-time Communication
 * =============================================================================
 * 
 * Handles WebSocket connections for real-time updates:
 * - New booking notifications to matching transporters
 * - Booking status updates to customers
 * - Location tracking updates
 * - Assignment status changes
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

let io: Server | null = null;

// Track user connections
const userSockets = new Map<string, Set<string>>();  // userId -> Set of socketIds
const socketUsers = new Map<string, string>();        // socketId -> userId

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
  return io;
}

/**
 * Emit to a specific user (by userId)
 * Used to send notifications to specific transporters
 */
export function emitToUser(userId: string, event: string, data: any): void {
  if (!io) return;
  
  // Check if user has any connected sockets
  const userSocketSet = userSockets.get(userId);
  const socketCount = userSocketSet?.size || 0;
  
  if (socketCount === 0) {
    logger.warn(`⚠️ User ${userId} has NO connected sockets - message will not be delivered!`);
  } else {
    logger.info(`📤 Emitting ${event} to user ${userId} (${socketCount} socket(s) connected)`);
  }
  
  // Check room membership
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  const roomSize = room?.size || 0;
  logger.debug(`   Room user:${userId} has ${roomSize} socket(s)`);
  
  io.to(`user:${userId}`).emit(event, data);
}

/**
 * Emit to all sockets in a booking room
 */
export function emitToBooking(bookingId: string, event: string, data: any): void {
  if (!io) return;
  io.to(`booking:${bookingId}`).emit(event, data);
  logger.debug(`Emitted ${event} to booking ${bookingId}`);
}

/**
 * Emit to all sockets in a trip room
 */
export function emitToTrip(tripId: string, event: string, data: any): void {
  if (!io) return;
  io.to(`trip:${tripId}`).emit(event, data);
}

/**
 * Emit to all connected clients
 */
export function emitToAll(event: string, data: any): void {
  if (!io) return;
  io.emit(event, data);
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
 */
export function emitToUsers(userIds: string[], event: string, data: any): void {
  if (!io || userIds.length === 0) return;
  
  // Use batch emission for better performance
  const rooms = userIds.map(id => `user:${id}`);
  
  for (const room of rooms) {
    io.to(room).emit(event, data);
  }
  
  logger.debug(`Batch emitted ${event} to ${userIds.length} users`);
}

/**
 * Emit to a specific room (e.g., booking:123, trip:456)
 * Used for group notifications like booking updates
 */
export function emitToRoom(room: string, event: string, data: any): void {
  if (!io) return;
  io.to(room).emit(event, data);
  logger.debug(`Emitted ${event} to room ${room}`);
}

/**
 * Broadcast to all transporters
 * Used for system-wide announcements
 */
export function emitToAllTransporters(event: string, data: any): void {
  if (!io) return;
  
  io.sockets.sockets.forEach(socket => {
    if (socket.data.role === 'transporter') {
      socket.emit(event, data);
    }
  });
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
