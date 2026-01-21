"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.successResponse = successResponse;
exports.errorResponse = errorResponse;
/**
 * Helper to create success response
 */
function successResponse(data, meta) {
    return {
        success: true,
        data,
        ...(meta && { meta })
    };
}
/**
 * Helper to create error response
 */
function errorResponse(code, message, details) {
    return {
        success: false,
        error: {
            code,
            message,
            ...(details && { details })
        }
    };
}
//# sourceMappingURL=api.types.js.map