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
export declare const NotificationType: {
    readonly NEW_BROADCAST: "new_broadcast";
    readonly ASSIGNMENT_UPDATE: "assignment_update";
    readonly TRIP_UPDATE: "trip_update";
    readonly PAYMENT: "payment";
    readonly GENERAL: "general";
};
/**
 * FCM Service class
 *
 * NOTE: Firebase Admin SDK integration is optional.
 * The service works without it by logging notifications (useful for development).
 *
 * To enable real push notifications:
 * 1. npm install firebase-admin
 * 2. Set FIREBASE_SERVICE_ACCOUNT_PATH in .env
 * 3. Uncomment Firebase Admin initialization below
 */
declare class FCMService {
    private isInitialized;
    private admin;
    /**
     * Initialize Firebase Admin SDK
     * Call this on server startup
     */
    initialize(): Promise<void>;
    /**
     * Register FCM token for a user
     * Called when mobile app sends its FCM token after login
     */
    registerToken(userId: string, token: string): void;
    /**
     * Remove FCM token (on logout or token refresh)
     */
    removeToken(userId: string, token: string): void;
    /**
     * Get all tokens for a user
     */
    getTokens(userId: string): string[];
    /**
     * Send notification to a specific user
     */
    sendToUser(userId: string, notification: FCMNotification): Promise<boolean>;
    /**
     * Send notification to multiple users
     */
    sendToUsers(userIds: string[], notification: FCMNotification): Promise<number>;
    /**
     * Send notification to FCM tokens
     */
    sendToTokens(tokens: string[], notification: FCMNotification): Promise<boolean>;
    /**
     * Send notification to a topic (e.g., all transporters with specific vehicle type)
     *
     * Topics:
     * - transporter_all: All transporters
     * - transporter_mini: Transporters with Mini trucks
     * - transporter_open: Transporters with Open trucks
     * - driver_all: All drivers
     */
    sendToTopic(topic: string, notification: FCMNotification): Promise<boolean>;
    /**
     * Subscribe user to a topic
     */
    subscribeToTopic(userId: string, topic: string): Promise<boolean>;
    /**
     * Build FCM message payload
     */
    private buildMessage;
    /**
     * Get notification channel ID based on type
     */
    private getChannelId;
    /**
     * Log notification (for development/mock mode)
     */
    private logNotification;
    /**
     * Send new broadcast notification to transporters
     */
    notifyNewBroadcast(transporterIds: string[], broadcast: {
        broadcastId: string;
        customerName: string;
        vehicleType: string;
        trucksNeeded: number;
        farePerTruck: number;
        pickupCity: string;
        dropCity: string;
    }): Promise<number>;
    /**
     * Send assignment update notification
     */
    notifyAssignmentUpdate(userId: string, assignment: {
        assignmentId: string;
        tripId: string;
        status: string;
        bookingId: string;
    }): Promise<boolean>;
    /**
     * Send payment notification
     */
    notifyPayment(userId: string, payment: {
        amount: number;
        tripId: string;
        status: 'received' | 'pending';
    }): Promise<boolean>;
}
export declare const fcmService: FCMService;
export interface FCMNotification {
    type: string;
    title: string;
    body: string;
    priority?: 'high' | 'normal';
    data?: Record<string, any>;
}
export {};
//# sourceMappingURL=fcm.service.d.ts.map