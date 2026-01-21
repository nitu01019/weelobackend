/**
 * =============================================================================
 * CORE CONSTANTS - Single Source of Truth
 * =============================================================================
 * 
 * All application-wide constants in one place.
 * Import from '@core/constants' in other modules.
 * 
 * BENEFITS:
 * - No magic strings/numbers scattered in code
 * - Easy to find and modify values
 * - Type safety with enums
 * - Self-documenting code
 * 
 * =============================================================================
 */

// =============================================================================
// USER ROLES
// =============================================================================

/**
 * User roles in the system
 */
export enum UserRole {
  CUSTOMER = 'customer',
  TRANSPORTER = 'transporter',
  DRIVER = 'driver',
  ADMIN = 'admin'
}

/**
 * Role display names (for UI/notifications)
 */
export const ROLE_DISPLAY_NAMES: Record<UserRole, string> = {
  [UserRole.CUSTOMER]: 'Customer',
  [UserRole.TRANSPORTER]: 'Transporter',
  [UserRole.DRIVER]: 'Driver',
  [UserRole.ADMIN]: 'Admin'
};

// =============================================================================
// BOOKING STATUS
// =============================================================================

/**
 * Booking lifecycle states
 */
export enum BookingStatus {
  PENDING = 'pending',           // Created, waiting for transporter
  CONFIRMED = 'confirmed',       // Transporter accepted
  ASSIGNED = 'assigned',         // Driver assigned
  DRIVER_EN_ROUTE = 'driver_en_route', // Driver going to pickup
  AT_PICKUP = 'at_pickup',       // Driver at pickup location
  IN_TRANSIT = 'in_transit',     // Goods in transit
  AT_DROPOFF = 'at_dropoff',     // Driver at dropoff location
  COMPLETED = 'completed',       // Delivered successfully
  CANCELLED = 'cancelled'        // Cancelled by any party
}

/**
 * Allowed status transitions
 */
export const BOOKING_STATUS_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  [BookingStatus.PENDING]: [BookingStatus.CONFIRMED, BookingStatus.CANCELLED],
  [BookingStatus.CONFIRMED]: [BookingStatus.ASSIGNED, BookingStatus.CANCELLED],
  [BookingStatus.ASSIGNED]: [BookingStatus.DRIVER_EN_ROUTE, BookingStatus.CANCELLED],
  [BookingStatus.DRIVER_EN_ROUTE]: [BookingStatus.AT_PICKUP, BookingStatus.CANCELLED],
  [BookingStatus.AT_PICKUP]: [BookingStatus.IN_TRANSIT, BookingStatus.CANCELLED],
  [BookingStatus.IN_TRANSIT]: [BookingStatus.AT_DROPOFF, BookingStatus.CANCELLED],
  [BookingStatus.AT_DROPOFF]: [BookingStatus.COMPLETED],
  [BookingStatus.COMPLETED]: [],
  [BookingStatus.CANCELLED]: []
};

// =============================================================================
// VEHICLE STATUS
// =============================================================================

/**
 * Vehicle availability status
 */
export enum VehicleStatus {
  AVAILABLE = 'available',       // Ready for assignments
  IN_TRANSIT = 'in_transit',     // Currently on a trip
  MAINTENANCE = 'maintenance',   // Under maintenance
  INACTIVE = 'inactive'          // Deactivated/suspended
}

// =============================================================================
// ORDER STATUS (Multi-vehicle orders)
// =============================================================================

/**
 * Order lifecycle states
 */
export enum OrderStatus {
  DRAFT = 'draft',               // Customer creating order
  PENDING = 'pending',           // Submitted, waiting for matches
  BROADCASTING = 'broadcasting', // Actively finding transporters
  PARTIAL = 'partial',           // Some trucks assigned
  CONFIRMED = 'confirmed',       // All trucks assigned
  IN_PROGRESS = 'in_progress',   // At least one truck started
  COMPLETED = 'completed',       // All deliveries complete
  CANCELLED = 'cancelled'        // Order cancelled
}

// =============================================================================
// ASSIGNMENT STATUS
// =============================================================================

/**
 * Assignment (driver-vehicle to booking) status
 */
export enum AssignmentStatus {
  PENDING = 'pending',           // Offered to driver
  ACCEPTED = 'accepted',         // Driver accepted
  REJECTED = 'rejected',         // Driver rejected
  IN_TRANSIT = 'in_transit',     // Trip in progress
  COMPLETED = 'completed',       // Delivery complete
  CANCELLED = 'cancelled'        // Assignment cancelled
}

// =============================================================================
// VEHICLE TYPES
// =============================================================================

/**
 * Supported vehicle types
 */
export enum VehicleType {
  TRACTOR = 'tractor',
  TRUCK = 'truck',
  MINI_TRUCK = 'mini_truck',
  PICKUP = 'pickup',
  THREE_WHEELER = 'three_wheeler',
  TRAILER = 'trailer',
  CONTAINER = 'container'
}

/**
 * Vehicle subtypes by type
 */
export const VEHICLE_SUBTYPES: Record<VehicleType, string[]> = {
  [VehicleType.TRACTOR]: ['Standard Tractor', 'Heavy Duty Tractor'],
  [VehicleType.TRUCK]: ['10 Feet', '14 Feet', '17 Feet', '19 Feet', '20 Feet', '22 Feet', '24 Feet', '32 Feet'],
  [VehicleType.MINI_TRUCK]: ['Tata Ace', 'Mahindra Pickup', 'Ashok Leyland Dost'],
  [VehicleType.PICKUP]: ['Single Cabin', 'Double Cabin'],
  [VehicleType.THREE_WHEELER]: ['Loader', 'E-Rickshaw'],
  [VehicleType.TRAILER]: ['Flatbed', 'Low Bed', 'High Bed'],
  [VehicleType.CONTAINER]: ['20 Feet', '40 Feet', '40 Feet HC']
};

// =============================================================================
// API CONFIGURATION
// =============================================================================

/**
 * API versioning
 */
export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;

/**
 * Pagination defaults
 */
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100
} as const;

/**
 * Rate limiting tiers
 */
export const RATE_LIMITS = {
  // General API
  STANDARD: { windowMs: 60 * 1000, max: 100 },    // 100 req/min
  
  // Auth endpoints (stricter)
  AUTH: { windowMs: 60 * 1000, max: 10 },          // 10 req/min
  OTP: { windowMs: 60 * 1000, max: 5 },            // 5 req/min
  
  // High-frequency endpoints
  TRACKING: { windowMs: 60 * 1000, max: 300 },    // 300 req/min (GPS updates)
  
  // Search/listing
  SEARCH: { windowMs: 60 * 1000, max: 50 }        // 50 req/min
} as const;

// =============================================================================
// OTP CONFIGURATION
// =============================================================================

export const OTP_CONFIG = {
  LENGTH: 6,
  EXPIRY_MINUTES: 5,
  MAX_ATTEMPTS: 3,
  RESEND_COOLDOWN_SECONDS: 30,
  
  // Development mode (bypass SMS)
  DEV_OTP: '123456',
  DEV_PHONES: ['9999999999', '8888888888', '7777777777']
} as const;

// =============================================================================
// JWT CONFIGURATION
// =============================================================================

export const JWT_CONFIG = {
  ACCESS_TOKEN_EXPIRY: '15m',
  REFRESH_TOKEN_EXPIRY: '7d',
  ALGORITHM: 'HS256' as const
} as const;

// =============================================================================
// FILE UPLOAD LIMITS
// =============================================================================

export const UPLOAD_CONFIG = {
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10 MB
  MAX_FILES: 5,
  ALLOWED_MIME_TYPES: [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
  ],
  IMAGE_RESIZE: {
    THUMBNAIL: { width: 150, height: 150 },
    MEDIUM: { width: 500, height: 500 },
    LARGE: { width: 1200, height: 1200 }
  }
} as const;

// =============================================================================
// NOTIFICATION TYPES
// =============================================================================

/**
 * Push notification types
 */
export enum NotificationType {
  // Booking related
  NEW_BOOKING = 'new_booking',
  BOOKING_CONFIRMED = 'booking_confirmed',
  BOOKING_CANCELLED = 'booking_cancelled',
  DRIVER_ASSIGNED = 'driver_assigned',
  DRIVER_EN_ROUTE = 'driver_en_route',
  DRIVER_ARRIVED = 'driver_arrived',
  TRIP_STARTED = 'trip_started',
  TRIP_COMPLETED = 'trip_completed',
  
  // Order related (multi-vehicle)
  ORDER_UPDATE = 'order_update',
  TRUCK_ASSIGNED = 'truck_assigned',
  
  // General
  PAYMENT_RECEIVED = 'payment_received',
  RATING_RECEIVED = 'rating_received',
  PROMO_OFFER = 'promo_offer',
  SYSTEM_ALERT = 'system_alert'
}

// =============================================================================
// SOCKET EVENTS
// =============================================================================

/**
 * WebSocket event names
 */
export const SOCKET_EVENTS = {
  // Connection
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  ERROR: 'error',
  
  // Authentication
  AUTHENTICATE: 'authenticate',
  AUTHENTICATED: 'authenticated',
  
  // Location tracking
  LOCATION_UPDATE: 'location_update',
  LOCATION_SUBSCRIBE: 'location_subscribe',
  LOCATION_UNSUBSCRIBE: 'location_unsubscribe',
  
  // Booking updates
  BOOKING_UPDATE: 'booking_update',
  BOOKING_STATUS_CHANGE: 'booking_status_change',
  
  // Driver events
  DRIVER_ONLINE: 'driver_online',
  DRIVER_OFFLINE: 'driver_offline',
  NEW_ASSIGNMENT: 'new_assignment',
  
  // Broadcast
  BROADCAST_REQUEST: 'broadcast_request',
  BROADCAST_RESPONSE: 'broadcast_response'
} as const;

// =============================================================================
// HTTP STATUS CODES (for consistency)
// =============================================================================

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503
} as const;

// =============================================================================
// ERROR CODES
// =============================================================================

/**
 * Application-specific error codes
 */
export enum ErrorCode {
  // Authentication (1xxx)
  AUTH_INVALID_CREDENTIALS = 'AUTH_1001',
  AUTH_TOKEN_EXPIRED = 'AUTH_1002',
  AUTH_TOKEN_INVALID = 'AUTH_1003',
  AUTH_OTP_EXPIRED = 'AUTH_1004',
  AUTH_OTP_INVALID = 'AUTH_1005',
  AUTH_OTP_MAX_ATTEMPTS = 'AUTH_1006',
  AUTH_USER_NOT_FOUND = 'AUTH_1007',
  AUTH_USER_INACTIVE = 'AUTH_1008',
  
  // Validation (2xxx)
  VALIDATION_ERROR = 'VAL_2001',
  VALIDATION_PHONE_INVALID = 'VAL_2002',
  VALIDATION_REQUIRED_FIELD = 'VAL_2003',
  
  // Booking (3xxx)
  BOOKING_NOT_FOUND = 'BOOK_3001',
  BOOKING_INVALID_STATUS = 'BOOK_3002',
  BOOKING_ALREADY_ASSIGNED = 'BOOK_3003',
  BOOKING_CANNOT_CANCEL = 'BOOK_3004',
  
  // Vehicle (4xxx)
  VEHICLE_NOT_FOUND = 'VEH_4001',
  VEHICLE_NOT_AVAILABLE = 'VEH_4002',
  VEHICLE_ALREADY_EXISTS = 'VEH_4003',
  
  // Driver (5xxx)
  DRIVER_NOT_FOUND = 'DRV_5001',
  DRIVER_NOT_AVAILABLE = 'DRV_5002',
  DRIVER_ALREADY_ASSIGNED = 'DRV_5003',
  
  // Order (6xxx)
  ORDER_NOT_FOUND = 'ORD_6001',
  ORDER_INVALID_STATUS = 'ORD_6002',
  
  // System (9xxx)
  INTERNAL_ERROR = 'SYS_9001',
  SERVICE_UNAVAILABLE = 'SYS_9002',
  RATE_LIMIT_EXCEEDED = 'SYS_9003',
  DATABASE_ERROR = 'SYS_9004'
}

// =============================================================================
// REGEX PATTERNS
// =============================================================================

export const REGEX = {
  // Indian phone number (10 digits, starting with 6-9)
  PHONE_INDIA: /^[6-9]\d{9}$/,
  
  // Vehicle number (Indian format: MH12AB1234)
  VEHICLE_NUMBER: /^[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}$/,
  
  // Email
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  
  // GST Number (Indian)
  GST: /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/,
  
  // PAN Number (Indian)
  PAN: /^[A-Z]{5}\d{4}[A-Z]{1}$/,
  
  // Pincode (Indian - 6 digits)
  PINCODE: /^\d{6}$/,
  
  // UUID
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
} as const;

// =============================================================================
// TIMEOUTS & INTERVALS
// =============================================================================

export const TIMEOUTS = {
  // API request timeout
  API_REQUEST: 30 * 1000,        // 30 seconds
  
  // Database query timeout
  DB_QUERY: 10 * 1000,           // 10 seconds
  
  // External service timeout
  EXTERNAL_SERVICE: 15 * 1000,   // 15 seconds
  
  // SMS delivery timeout
  SMS_DELIVERY: 30 * 1000,       // 30 seconds
  
  // Socket ping interval
  SOCKET_PING: 25 * 1000,        // 25 seconds
  
  // Location update interval (minimum)
  LOCATION_UPDATE_MIN: 5 * 1000, // 5 seconds
  
  // Broadcast timeout (waiting for responses)
  BROADCAST: 30 * 1000           // 30 seconds
} as const;

// =============================================================================
// CACHE KEYS & TTL
// =============================================================================

export const CACHE = {
  // Key prefixes
  PREFIX: {
    USER: 'user:',
    VEHICLE: 'vehicle:',
    BOOKING: 'booking:',
    OTP: 'otp:',
    SESSION: 'session:',
    RATE_LIMIT: 'rl:',
    AVAILABILITY: 'avail:'
  },
  
  // TTL in seconds
  TTL: {
    USER: 300,           // 5 minutes
    VEHICLE: 300,        // 5 minutes
    BOOKING: 60,         // 1 minute
    AVAILABILITY: 30,    // 30 seconds
    OTP: 300,            // 5 minutes
    SESSION: 86400 * 7,  // 7 days
    RATE_LIMIT: 60       // 1 minute
  }
} as const;
