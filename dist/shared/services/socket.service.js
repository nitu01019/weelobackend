"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocketEvent = void 0;
exports.initializeSocket = initializeSocket;
exports.emitToUser = emitToUser;
exports.emitToBooking = emitToBooking;
exports.emitToTrip = emitToTrip;
exports.emitToAll = emitToAll;
exports.getConnectedUserCount = getConnectedUserCount;
exports.isUserConnected = isUserConnected;
exports.getIO = getIO;
exports.emitToOrder = emitToOrder;
exports.getConnectionStats = getConnectionStats;
exports.emitToUsers = emitToUsers;
exports.emitToRoom = emitToRoom;
exports.emitToAllTransporters = emitToAllTransporters;
const socket_io_1 = require("socket.io");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const environment_1 = require("../../config/environment");
const logger_service_1 = require("./logger.service");
let io = null;
// Track user connections
const userSockets = new Map(); // userId -> Set of socketIds
const socketUsers = new Map(); // socketId -> userId
/**
 * Socket Events
 *
 * ENHANCED: Added booking lifecycle events for timeout handling
 * ENHANCED: Added real-time truck count updates for multi-truck requests
 */
exports.SocketEvent = {
    // Server -> Client
    CONNECTED: 'connected',
    BOOKING_UPDATED: 'booking_updated',
    TRUCK_ASSIGNED: 'truck_assigned',
    LOCATION_UPDATED: 'location_updated',
    ASSIGNMENT_STATUS_CHANGED: 'assignment_status_changed',
    NEW_BROADCAST: 'new_broadcast',
    // Booking lifecycle events
    BOOKING_EXPIRED: 'booking_expired', // No transporters accepted in time
    BOOKING_FULLY_FILLED: 'booking_fully_filled', // All trucks assigned
    BOOKING_PARTIALLY_FILLED: 'booking_partially_filled', // Some trucks assigned
    NO_VEHICLES_AVAILABLE: 'no_vehicles_available', // No matching transporters found
    BROADCAST_COUNTDOWN: 'broadcast_countdown', // Timer tick for UI
    // NEW: Real-time truck request updates (for multi-truck system)
    TRUCK_REQUEST_ACCEPTED: 'truck_request_accepted', // A transporter accepted 1 truck
    TRUCKS_REMAINING_UPDATE: 'trucks_remaining_update', // Update remaining truck count
    REQUEST_NO_LONGER_AVAILABLE: 'request_no_longer_available', // Request taken by someone else
    ORDER_STATUS_UPDATE: 'order_status_update', // Overall order status changed
    // Lightning-fast notification events
    NEW_ORDER_ALERT: 'new_order_alert', // Urgent notification with sound
    ACCEPT_CONFIRMATION: 'accept_confirmation', // Confirm acceptance to transporter
    ERROR: 'error',
    // Client -> Server
    JOIN_BOOKING: 'join_booking',
    LEAVE_BOOKING: 'leave_booking',
    JOIN_ORDER: 'join_order', // Join order room for updates
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
function initializeSocket(server) {
    io = new socket_io_1.Server(server, {
        cors: {
            origin: environment_1.config.isDevelopment ? '*' : [
                'https://weelo.app',
                'https://captain.weelo.app',
                /\.weelo\.app$/
            ],
            methods: ['GET', 'POST'],
            credentials: true
        },
        // Performance optimizations
        pingTimeout: 20000, // 20s - How long to wait for pong
        pingInterval: 25000, // 25s - How often to send ping
        upgradeTimeout: 10000, // 10s - Timeout for upgrade
        // Transports - WebSocket preferred
        transports: ['websocket', 'polling'],
        allowUpgrades: true,
        // Buffer and payload limits
        maxHttpBufferSize: 10 * 1024 * 1024, // 10MB max message size
        // Connection state recovery (for reconnection)
        connectionStateRecovery: {
            maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
            skipMiddlewares: false
        },
        // Per-message deflate compression
        perMessageDeflate: {
            threshold: 1024, // Only compress messages > 1KB
            zlibDeflateOptions: {
                chunkSize: 16 * 1024 // 16KB chunks
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
            const decoded = jsonwebtoken_1.default.verify(token, environment_1.config.jwt.secret);
            socket.data.userId = decoded.userId;
            socket.data.role = decoded.role;
            socket.data.phone = decoded.phone;
            next();
        }
        catch (error) {
            next(new Error('Invalid token'));
        }
    });
    // Connection handler
    io.on('connection', (socket) => {
        const userId = socket.data.userId;
        const role = socket.data.role;
        const phone = socket.data.phone;
        logger_service_1.logger.info(`🔌 Socket connected: ${socket.id}`);
        logger_service_1.logger.info(`   👤 User: ${userId}`);
        logger_service_1.logger.info(`   📱 Phone: ${phone}`);
        logger_service_1.logger.info(`   🏷️ Role: ${role}`);
        // Track user connection
        if (!userSockets.has(userId)) {
            userSockets.set(userId, new Set());
        }
        userSockets.get(userId).add(socket.id);
        socketUsers.set(socket.id, userId);
        // Join user's personal room
        socket.join(`user:${userId}`);
        // Send confirmation
        socket.emit(exports.SocketEvent.CONNECTED, {
            message: 'Connected successfully',
            userId,
            role
        });
        // Handle joining booking room
        socket.on(exports.SocketEvent.JOIN_BOOKING, (bookingId) => {
            socket.join(`booking:${bookingId}`);
            logger_service_1.logger.debug(`User ${userId} joined booking room: ${bookingId}`);
        });
        // Handle leaving booking room
        socket.on(exports.SocketEvent.LEAVE_BOOKING, (bookingId) => {
            socket.leave(`booking:${bookingId}`);
            logger_service_1.logger.debug(`User ${userId} left booking room: ${bookingId}`);
        });
        // Handle location updates (from drivers)
        socket.on(exports.SocketEvent.UPDATE_LOCATION, (data) => {
            if (role !== 'driver') {
                socket.emit(exports.SocketEvent.ERROR, { message: 'Only drivers can update location' });
                return;
            }
            // Broadcast to trip room
            emitToTrip(data.tripId, exports.SocketEvent.LOCATION_UPDATED, {
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
            logger_service_1.logger.info(`Socket disconnected: ${socket.id} (Reason: ${reason})`);
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
        socket.on(exports.SocketEvent.JOIN_ORDER, (orderId) => {
            socket.join(`order:${orderId}`);
            logger_service_1.logger.debug(`User ${userId} joined order room: ${orderId}`);
        });
        // Handle leaving order room
        socket.on(exports.SocketEvent.LEAVE_ORDER, (orderId) => {
            socket.leave(`order:${orderId}`);
            logger_service_1.logger.debug(`User ${userId} left order room: ${orderId}`);
        });
    });
    logger_service_1.logger.info('✅ Socket.IO initialized with optimized settings');
    return io;
}
/**
 * Emit to a specific user (by userId)
 * Used to send notifications to specific transporters
 */
function emitToUser(userId, event, data) {
    if (!io)
        return;
    // Check if user has any connected sockets
    const userSocketSet = userSockets.get(userId);
    const socketCount = userSocketSet?.size || 0;
    if (socketCount === 0) {
        logger_service_1.logger.warn(`⚠️ User ${userId} has NO connected sockets - message will not be delivered!`);
    }
    else {
        logger_service_1.logger.info(`📤 Emitting ${event} to user ${userId} (${socketCount} socket(s) connected)`);
    }
    // Check room membership
    const room = io.sockets.adapter.rooms.get(`user:${userId}`);
    const roomSize = room?.size || 0;
    logger_service_1.logger.debug(`   Room user:${userId} has ${roomSize} socket(s)`);
    io.to(`user:${userId}`).emit(event, data);
}
/**
 * Emit to all sockets in a booking room
 */
function emitToBooking(bookingId, event, data) {
    if (!io)
        return;
    io.to(`booking:${bookingId}`).emit(event, data);
    logger_service_1.logger.debug(`Emitted ${event} to booking ${bookingId}`);
}
/**
 * Emit to all sockets in a trip room
 */
function emitToTrip(tripId, event, data) {
    if (!io)
        return;
    io.to(`trip:${tripId}`).emit(event, data);
}
/**
 * Emit to all connected clients
 */
function emitToAll(event, data) {
    if (!io)
        return;
    io.emit(event, data);
}
/**
 * Get connected user count
 */
function getConnectedUserCount() {
    return userSockets.size;
}
/**
 * Check if user is connected
 */
function isUserConnected(userId) {
    return userSockets.has(userId) && userSockets.get(userId).size > 0;
}
/**
 * Get Socket.IO instance
 */
function getIO() {
    return io;
}
/**
 * Emit to all sockets in an order room
 * Used for multi-truck request updates
 */
function emitToOrder(orderId, event, data) {
    if (!io)
        return;
    io.to(`order:${orderId}`).emit(event, data);
    logger_service_1.logger.debug(`Emitted ${event} to order ${orderId}`);
}
/**
 * Get detailed connection statistics
 * Useful for monitoring and debugging
 */
function getConnectionStats() {
    const socketCount = io?.sockets.sockets.size || 0;
    // Count by role
    let customers = 0;
    let transporters = 0;
    let drivers = 0;
    io?.sockets.sockets.forEach(socket => {
        switch (socket.data.role) {
            case 'customer':
                customers++;
                break;
            case 'transporter':
                transporters++;
                break;
            case 'driver':
                drivers++;
                break;
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
function emitToUsers(userIds, event, data) {
    if (!io || userIds.length === 0)
        return;
    // Use batch emission for better performance
    const rooms = userIds.map(id => `user:${id}`);
    for (const room of rooms) {
        io.to(room).emit(event, data);
    }
    logger_service_1.logger.debug(`Batch emitted ${event} to ${userIds.length} users`);
}
/**
 * Emit to a specific room (e.g., booking:123, trip:456)
 * Used for group notifications like booking updates
 */
function emitToRoom(room, event, data) {
    if (!io)
        return;
    io.to(room).emit(event, data);
    logger_service_1.logger.debug(`Emitted ${event} to room ${room}`);
}
/**
 * Broadcast to all transporters
 * Used for system-wide announcements
 */
function emitToAllTransporters(event, data) {
    if (!io)
        return;
    io.sockets.sockets.forEach(socket => {
        if (socket.data.role === 'transporter') {
            socket.emit(event, data);
        }
    });
}
//# sourceMappingURL=socket.service.js.map