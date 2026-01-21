/**
 * =============================================================================
 * API TYPES - SHARED CONTRACTS
 * =============================================================================
 *
 * These types define the API contract between backend and clients.
 * Any changes here must be versioned (see RULES.md).
 *
 * Frontend types ≠ Backend types ≠ AI types
 * This is the neutral contract layer.
 * =============================================================================
 */
/**
 * Standard API response wrapper
 */
export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: ApiError;
    meta?: ApiMeta;
}
/**
 * API error structure
 */
export interface ApiError {
    code: string;
    message: string;
    details?: Record<string, unknown>;
}
/**
 * API metadata (pagination, etc.)
 */
export interface ApiMeta {
    page?: number;
    limit?: number;
    total?: number;
    hasMore?: boolean;
}
/**
 * Pagination request params
 */
export interface PaginationParams {
    page?: number;
    limit?: number;
}
/**
 * Location coordinates
 */
export interface Coordinates {
    latitude: number;
    longitude: number;
}
/**
 * Address with coordinates
 */
export interface Location {
    coordinates: Coordinates;
    address: string;
    city?: string;
    state?: string;
    pincode?: string;
}
/**
 * User roles
 */
export type UserRole = 'customer' | 'transporter' | 'driver' | 'admin';
/**
 * Booking status
 */
export type BookingStatus = 'active' | 'partially_filled' | 'fully_filled' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
/**
 * Assignment status
 */
export type AssignmentStatus = 'pending' | 'driver_accepted' | 'en_route_pickup' | 'at_pickup' | 'in_transit' | 'completed' | 'cancelled';
/**
 * Vehicle type
 */
export type VehicleType = 'mini' | 'lcv' | 'tipper' | 'container' | 'trailer' | 'tanker' | 'bulker' | 'open' | 'dumper' | 'tractor';
/**
 * Helper to create success response
 */
export declare function successResponse<T>(data: T, meta?: ApiMeta): ApiResponse<T>;
/**
 * Helper to create error response
 */
export declare function errorResponse(code: string, message: string, details?: Record<string, unknown>): ApiResponse;
//# sourceMappingURL=api.types.d.ts.map