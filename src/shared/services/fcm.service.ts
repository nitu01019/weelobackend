/**
 * =============================================================================
 * FCM SERVICE - Firebase Cloud Messaging for Push Notifications
 * =============================================================================
 * 
 * Sends push notifications to mobile apps when:
 * - New booking broadcast is created
 * - Assignment status changes
 * - Trip status updates
 * - Payment received
 * 
 * SETUP REQUIRED:
 * 1. Create Firebase project at https://console.firebase.google.com
 * 2. Download service account key JSON
 * 3. Set FIREBASE_SERVICE_ACCOUNT_PATH in .env
 * 
 * FOR BACKEND DEVELOPERS:
 * - Use sendToUser() for targeted notifications
 * - Use sendToTopic() for broadcast to vehicle types
 * - Always include 'type' in data for client-side routing
 * 
 * SCALABILITY:
 * - FCM handles millions of messages automatically
 * - Use topics for efficient broadcast to groups
 * - Batch notifications when possible
 * =============================================================================
 */

import { logger } from './logger.service';
import { redisService } from './redis.service';

// Notification types - must match mobile apps
export const NotificationType = {
  NEW_BROADCAST: 'new_broadcast',
  ASSIGNMENT_UPDATE: 'assignment_update',
  TRIP_UPDATE: 'trip_update',
  PAYMENT: 'payment',
  GENERAL: 'general'
} as const;

// =============================================================================
// FCM TOKEN STORAGE
// =============================================================================
// 
// SCALABILITY:
// - Primary: Redis SET per userId — shared across all ECS instances
// - Fallback: In-memory Map — used if Redis is unavailable
// - 90-day TTL on Redis keys (FCM tokens expire ~60 days)
// 
// EASY UNDERSTANDING:
// - registerToken() → Add token to user's set (Redis SADD = no duplicates)
// - removeToken() → Remove token from user's set (Redis SREM)
// - getTokens() → Get all tokens for a user (Redis SMEMBERS)
// 
// MODULARITY:
// - Uses existing redisService singleton (no new connections)
// - In-memory Map is independent fallback, not a cache layer
// =============================================================================

// In-memory fallback for when Redis is unavailable
const userTokensFallback = new Map<string, string[]>();

// Redis key pattern for FCM tokens
const FCM_TOKEN_KEY = (userId: string) => `fcm:tokens:${userId}`;

// FCM tokens expire after ~60 days, we set 90-day TTL for safety
const FCM_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

/**
 * FCM Service class
 * 
 * SCALABILITY:
 * - FCM tokens stored in Redis (shared across ECS instances)
 * - Falls back to in-memory Map if Redis is unavailable
 * - Firebase Admin SDK handles millions of messages automatically
 * 
 * EASY UNDERSTANDING:
 * - Firebase Admin SDK integration is optional
 * - Works without it by logging notifications (useful for development)
 * - Token storage is transparent — Redis or in-memory, same API
 * 
 * MODULARITY:
 * - Token storage is decoupled from notification sending
 * - Can switch storage backend without changing notification logic
 * 
 * To enable real push notifications:
 * 1. npm install firebase-admin
 * 2. Set FIREBASE_SERVICE_ACCOUNT_PATH in .env
 * 3. Uncomment Firebase Admin initialization below
 */
class FCMService {
  private isInitialized = false;
  private admin: any = null;

  /**
   * Initialize Firebase Admin SDK
   * Call this on server startup
   */
  async initialize(): Promise<void> {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    
    if (!serviceAccountPath) {
      logger.warn('⚠️ FCM: FIREBASE_SERVICE_ACCOUNT_PATH not set. Push notifications disabled.');
      logger.info('📱 FCM: Notifications will be logged to console instead.');
      return;
    }

    try {
      // Dynamic import of firebase-admin (optional dependency)
      const firebaseAdmin = await import('firebase-admin');
      
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const serviceAccount = require(serviceAccountPath);
      
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(serviceAccount)
      });
      
      this.admin = firebaseAdmin;
      this.isInitialized = true;
      logger.info('✅ FCM: Firebase Admin SDK initialized');
    } catch (error) {
      logger.warn('⚠️ FCM: Firebase Admin SDK not available. Using mock mode.', error);
    }
  }

  // ===========================================================================
  // TOKEN MANAGEMENT (Redis-backed with in-memory fallback)
  // ===========================================================================

  /**
   * Check if Redis is available for token storage
   * 
   * EASY UNDERSTANDING: Simple boolean check — no complex logic
   * MODULARITY: Centralized check used by all token methods
   */
  private isRedisAvailable(): boolean {
    return redisService.isRedisEnabled() && redisService.isConnected();
  }

  /**
   * Register FCM token for a user
   * Called when mobile app sends its FCM token after login
   * 
   * SCALABILITY: Uses Redis SADD — atomic, no duplicates, O(1)
   * - Token is added to user's set in Redis (shared across all servers)
   * - 90-day TTL ensures stale tokens are cleaned up automatically
   * - Falls back to in-memory Map if Redis is unavailable
   * 
   * EASY UNDERSTANDING: SADD = Set Add. If token already exists, it's a no-op.
   */
  async registerToken(userId: string, token: string): Promise<void> {
    // Try Redis first (primary storage)
    if (this.isRedisAvailable()) {
      try {
        const key = FCM_TOKEN_KEY(userId);
        await redisService.sAdd(key, token);
        await redisService.expire(key, FCM_TOKEN_TTL_SECONDS);
        logger.info(`FCM: Token registered for user ${userId} [Redis]`);
        return;
      } catch (error: any) {
        logger.warn(`FCM: Redis registerToken failed: ${error.message}. Using fallback.`);
      }
    }

    // Fallback to in-memory
    if (!userTokensFallback.has(userId)) {
      userTokensFallback.set(userId, []);
    }
    const tokens = userTokensFallback.get(userId)!;
    if (!tokens.includes(token)) {
      tokens.push(token);
      logger.info(`FCM: Token registered for user ${userId} [InMemory]`);
    }
  }

  /**
   * Remove FCM token (on logout or token refresh)
   * 
   * SCALABILITY: Uses Redis SREM — atomic removal, O(1)
   * EASY UNDERSTANDING: SREM = Set Remove. If token doesn't exist, it's a no-op.
   */
  async removeToken(userId: string, token: string): Promise<void> {
    // Try Redis first
    if (this.isRedisAvailable()) {
      try {
        const key = FCM_TOKEN_KEY(userId);
        await redisService.sRem(key, token);
        logger.info(`FCM: Token removed for user ${userId} [Redis]`);
        return;
      } catch (error: any) {
        logger.warn(`FCM: Redis removeToken failed: ${error.message}. Using fallback.`);
      }
    }

    // Fallback to in-memory
    const tokens = userTokensFallback.get(userId);
    if (tokens) {
      const index = tokens.indexOf(token);
      if (index > -1) {
        tokens.splice(index, 1);
        logger.info(`FCM: Token removed for user ${userId} [InMemory]`);
      }
    }
  }

  /**
   * Get all tokens for a user
   * 
   * SCALABILITY: Uses Redis SMEMBERS — returns all set members, O(N)
   * EASY UNDERSTANDING: Returns array of FCM tokens for the user's devices
   * 
   * NOTE: This is async now (Redis operations are async).
   * All callers already use `await` or `.then()` patterns.
   */
  async getTokens(userId: string): Promise<string[]> {
    // Try Redis first
    if (this.isRedisAvailable()) {
      try {
        const key = FCM_TOKEN_KEY(userId);
        const tokens = await redisService.sMembers(key);
        return tokens;
      } catch (error: any) {
        logger.warn(`FCM: Redis getTokens failed: ${error.message}. Using fallback.`);
      }
    }

    // Fallback to in-memory
    return userTokensFallback.get(userId) || [];
  }

  /**
   * Send notification to a specific user
   * 
   * SCALABILITY: Fetches tokens from Redis (shared across instances)
   * EASY UNDERSTANDING: Get tokens → send to all devices → return success
   */
  async sendToUser(
    userId: string,
    notification: FCMNotification
  ): Promise<boolean> {
    const tokens = await this.getTokens(userId);
    
    if (tokens.length === 0) {
      logger.debug(`FCM: No tokens found for user ${userId}`);
      return false;
    }

    return this.sendToTokens(tokens, notification);
  }

  /**
   * Send notification to multiple users
   */
  async sendToUsers(
    userIds: string[],
    notification: FCMNotification
  ): Promise<number> {
    let successCount = 0;
    
    for (const userId of userIds) {
      const success = await this.sendToUser(userId, notification);
      if (success) successCount++;
    }
    
    return successCount;
  }

  /**
   * Send notification to FCM tokens
   */
  async sendToTokens(
    tokens: string[],
    notification: FCMNotification
  ): Promise<boolean> {
    if (tokens.length === 0) return false;

    const message = this.buildMessage(notification, tokens);

    if (!this.isInitialized || !this.admin) {
      // Mock mode - log notification instead
      this.logNotification(notification, tokens);
      return true;
    }

    try {
      if (tokens.length === 1) {
        await this.admin.messaging().send({
          ...message,
          token: tokens[0]
        });
      } else {
        await this.admin.messaging().sendMulticast({
          ...message,
          tokens
        });
      }
      
      logger.info(`FCM: Notification sent to ${tokens.length} device(s)`);
      return true;
    } catch (error) {
      logger.error('FCM: Failed to send notification', error);
      return false;
    }
  }

  /**
   * Send notification to a topic (e.g., all transporters with specific vehicle type)
   * 
   * Topics:
   * - transporter_all: All transporters
   * - transporter_mini: Transporters with Mini trucks
   * - transporter_open: Transporters with Open trucks
   * - driver_all: All drivers
   */
  async sendToTopic(
    topic: string,
    notification: FCMNotification
  ): Promise<boolean> {
    const message = this.buildMessage(notification);

    if (!this.isInitialized || !this.admin) {
      this.logNotification(notification, [], topic);
      return true;
    }

    try {
      await this.admin.messaging().send({
        ...message,
        topic
      });
      
      logger.info(`FCM: Notification sent to topic: ${topic}`);
      return true;
    } catch (error) {
      logger.error(`FCM: Failed to send to topic ${topic}`, error);
      return false;
    }
  }

  /**
   * Subscribe user to a topic
   * 
   * SCALABILITY: Fetches tokens from Redis before subscribing
   */
  async subscribeToTopic(userId: string, topic: string): Promise<boolean> {
    const tokens = await this.getTokens(userId);
    
    if (tokens.length === 0 || !this.isInitialized || !this.admin) {
      logger.debug(`FCM: Cannot subscribe ${userId} to ${topic}`);
      return false;
    }

    try {
      await this.admin.messaging().subscribeToTopic(tokens, topic);
      logger.info(`FCM: User ${userId} subscribed to topic: ${topic}`);
      return true;
    } catch (error) {
      logger.error(`FCM: Failed to subscribe to topic ${topic}`, error);
      return false;
    }
  }

  /**
   * Build FCM message payload
   */
  private buildMessage(notification: FCMNotification, tokens?: string[]): any {
    return {
      notification: {
        title: notification.title,
        body: notification.body
      },
      data: {
        type: notification.type,
        ...notification.data,
        // Convert all values to strings (FCM requirement)
        ...(notification.data && Object.fromEntries(
          Object.entries(notification.data).map(([k, v]) => [k, String(v)])
        ))
      },
      android: {
        priority: notification.priority === 'high' ? 'high' : 'normal',
        notification: {
          channelId: this.getChannelId(notification.type),
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1
          }
        }
      }
    };
  }

  /**
   * Get notification channel ID based on type
   */
  private getChannelId(type: string): string {
    switch (type) {
      case NotificationType.NEW_BROADCAST:
        return 'broadcasts';
      case NotificationType.TRIP_UPDATE:
        return 'trips';
      case NotificationType.PAYMENT:
        return 'payments';
      default:
        return 'general';
    }
  }

  /**
   * Log notification (for development/mock mode)
   */
  private logNotification(
    notification: FCMNotification,
    tokens: string[],
    topic?: string
  ): void {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  📱 PUSH NOTIFICATION (Mock Mode)                          ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  Type:    ${notification.type.padEnd(47)}║`);
    console.log(`║  Title:   ${notification.title.substring(0, 47).padEnd(47)}║`);
    console.log(`║  Body:    ${notification.body.substring(0, 47).padEnd(47)}║`);
    if (topic) {
      console.log(`║  Topic:   ${topic.padEnd(47)}║`);
    } else {
      console.log(`║  Tokens:  ${tokens.length} device(s)`.padEnd(59) + '║');
    }
    console.log('║                                                            ║');
    console.log('║  Data:                                                     ║');
    Object.entries(notification.data || {}).forEach(([key, value]) => {
      const line = `    ${key}: ${String(value).substring(0, 40)}`;
      console.log(`║  ${line.padEnd(56)}║`);
    });
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
  }

  // ============================================================================
  // CONVENIENCE METHODS - Use these for common notification types
  // ============================================================================

  /**
   * Send new broadcast notification to transporters
   */
  async notifyNewBroadcast(
    transporterIds: string[],
    broadcast: {
      broadcastId: string;
      customerName: string;
      vehicleType: string;
      trucksNeeded: number;
      farePerTruck: number;
      pickupCity: string;
      dropCity: string;
    }
  ): Promise<number> {
    const notification: FCMNotification = {
      type: NotificationType.NEW_BROADCAST,
      title: '🚛 New Booking Request!',
      body: `${broadcast.trucksNeeded} ${broadcast.vehicleType} truck(s) needed • ₹${broadcast.farePerTruck}/truck • ${broadcast.pickupCity} → ${broadcast.dropCity}`,
      priority: 'high',
      data: {
        broadcastId: broadcast.broadcastId,
        customerName: broadcast.customerName,
        vehicleType: broadcast.vehicleType,
        trucksNeeded: broadcast.trucksNeeded,
        farePerTruck: broadcast.farePerTruck,
        pickupCity: broadcast.pickupCity,
        dropCity: broadcast.dropCity
      }
    };

    return this.sendToUsers(transporterIds, notification);
  }

  /**
   * Send assignment update notification
   */
  async notifyAssignmentUpdate(
    userId: string,
    assignment: {
      assignmentId: string;
      tripId: string;
      status: string;
      bookingId: string;
    }
  ): Promise<boolean> {
    const statusMessages: Record<string, string> = {
      pending: 'New trip assigned to you',
      driver_accepted: 'You accepted the trip',
      in_transit: 'Trip is now in transit',
      completed: 'Trip completed successfully!',
      cancelled: 'Trip was cancelled'
    };

    const notification: FCMNotification = {
      type: NotificationType.ASSIGNMENT_UPDATE,
      title: '📋 Assignment Update',
      body: statusMessages[assignment.status] || `Status: ${assignment.status}`,
      priority: assignment.status === 'pending' ? 'high' : 'normal',
      data: {
        assignmentId: assignment.assignmentId,
        tripId: assignment.tripId,
        status: assignment.status,
        bookingId: assignment.bookingId
      }
    };

    return this.sendToUser(userId, notification);
  }

  /**
   * Send payment notification
   */
  async notifyPayment(
    userId: string,
    payment: {
      amount: number;
      tripId: string;
      status: 'received' | 'pending';
    }
  ): Promise<boolean> {
    const notification: FCMNotification = {
      type: NotificationType.PAYMENT,
      title: payment.status === 'received' ? '💰 Payment Received!' : '⏳ Payment Pending',
      body: `₹${payment.amount} for trip`,
      priority: 'high',
      data: {
        amount: payment.amount,
        tripId: payment.tripId,
        status: payment.status
      }
    };

    return this.sendToUser(userId, notification);
  }
}

// Singleton instance
export const fcmService = new FCMService();

// Types
export interface FCMNotification {
  type: string;
  title: string;
  body: string;
  priority?: 'high' | 'normal';
  data?: Record<string, any>;
}

// =============================================================================
// CONVENIENCE EXPORTS - For backward compatibility and cleaner imports
// =============================================================================

/**
 * Send push notification to a single user
 * @param userId - The user ID to send notification to
 * @param notification - Notification payload
 */
export async function sendPushNotification(
  userId: string,
  notification: { title: string; body: string; data?: Record<string, any> }
): Promise<boolean> {
  return fcmService.sendToUser(userId, {
    type: notification.data?.type || NotificationType.GENERAL,
    title: notification.title,
    body: notification.body,
    priority: 'high',
    data: notification.data
  });
}

/**
 * Send push notifications to multiple users
 * @param userIds - Array of user IDs to send notification to
 * @param notification - Notification payload
 * @returns Number of successful notifications sent
 */
export async function sendBatchPushNotifications(
  userIds: string[],
  notification: { title: string; body: string; data?: Record<string, any> }
): Promise<number> {
  return fcmService.sendToUsers(userIds, {
    type: notification.data?.type || NotificationType.GENERAL,
    title: notification.title,
    body: notification.body,
    priority: 'high',
    data: notification.data
  });
}
