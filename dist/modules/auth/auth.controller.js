"use strict";
/**
 * =============================================================================
 * AUTH MODULE - CONTROLLER
 * =============================================================================
 *
 * Handles HTTP requests for authentication.
 * Controller only handles request/response - business logic is in service.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.authController = void 0;
const auth_service_1 = require("./auth.service");
const auth_schema_1 = require("./auth.schema");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const api_types_1 = require("../../shared/types/api.types");
const error_middleware_1 = require("../../shared/middleware/error.middleware");
class AuthController {
    /**
     * Send OTP to phone number
     */
    sendOtp = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const data = (0, validation_utils_1.validateSchema)(auth_schema_1.sendOtpSchema, req.body);
        const result = await auth_service_1.authService.sendOtp(data.phone, data.role || 'customer');
        res.status(200).json((0, api_types_1.successResponse)({
            message: result.message,
            expiresIn: result.expiresIn
        }));
    });
    /**
     * Verify OTP and return tokens
     */
    verifyOtp = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        // Debug: Log incoming request body
        console.log('=== VERIFY OTP REQUEST ===');
        console.log('Request body:', JSON.stringify(req.body, null, 2));
        console.log('==========================');
        const data = (0, validation_utils_1.validateSchema)(auth_schema_1.verifyOtpSchema, req.body);
        const result = await auth_service_1.authService.verifyOtp(data.phone, data.otp, data.role || 'customer');
        res.status(200).json((0, api_types_1.successResponse)({
            user: result.user,
            tokens: {
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                expiresIn: result.expiresIn
            },
            isNewUser: result.isNewUser
        }));
    });
    /**
     * Refresh access token
     */
    refreshToken = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const data = (0, validation_utils_1.validateSchema)(auth_schema_1.refreshTokenSchema, req.body);
        const result = await auth_service_1.authService.refreshToken(data.refreshToken);
        res.status(200).json((0, api_types_1.successResponse)({
            accessToken: result.accessToken,
            expiresIn: result.expiresIn
        }));
    });
    /**
     * Logout user
     */
    logout = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const userId = req.userId;
        await auth_service_1.authService.logout(userId);
        res.status(200).json((0, api_types_1.successResponse)({
            message: 'Logged out successfully'
        }));
    });
    /**
     * Get current user info
     */
    getCurrentUser = (0, error_middleware_1.asyncHandler)(async (req, res, _next) => {
        const userId = req.userId;
        const user = await auth_service_1.authService.getUserById(userId);
        res.status(200).json((0, api_types_1.successResponse)({ user }));
    });
}
exports.authController = new AuthController();
//# sourceMappingURL=auth.controller.js.map