"use strict";
/**
 * =============================================================================
 * PROFILE MODULE - ROUTES
 * =============================================================================
 *
 * API routes for profile management.
 * =============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.profileRouter = void 0;
const express_1 = require("express");
const profile_service_1 = require("./profile.service");
const auth_middleware_1 = require("../../shared/middleware/auth.middleware");
const validation_utils_1 = require("../../shared/utils/validation.utils");
const profile_schema_1 = require("./profile.schema");
const router = (0, express_1.Router)();
exports.profileRouter = router;
/**
 * @route   GET /profile
 * @desc    Get current user's profile
 * @access  All authenticated users
 */
router.get('/', auth_middleware_1.authMiddleware, async (req, res, next) => {
    try {
        const user = await profile_service_1.profileService.getProfile(req.user.userId);
        res.json({
            success: true,
            data: { user }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   PUT /profile/customer
 * @desc    Create/Update customer profile
 * @access  Customer only
 */
router.put('/customer', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['customer']), async (req, res, next) => {
    try {
        const data = (0, validation_utils_1.validateSchema)(profile_schema_1.customerProfileSchema, req.body);
        const profile = await profile_service_1.profileService.updateCustomerProfile(req.user.userId, req.user.phone, data);
        res.json({
            success: true,
            data: { profile }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   PUT /profile/transporter
 * @desc    Create/Update transporter profile
 * @access  Transporter only
 */
router.put('/transporter', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const data = (0, validation_utils_1.validateSchema)(profile_schema_1.transporterProfileSchema, req.body);
        const user = await profile_service_1.profileService.updateTransporterProfile(req.user.userId, req.user.phone, data);
        res.json({
            success: true,
            data: { user }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   PUT /profile/driver
 * @desc    Create/Update driver profile
 * @access  Driver only
 */
router.put('/driver', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver']), async (req, res, next) => {
    try {
        const data = (0, validation_utils_1.validateSchema)(profile_schema_1.driverProfileSchema, req.body);
        const user = await profile_service_1.profileService.updateDriverProfile(req.user.userId, req.user.phone, data);
        res.json({
            success: true,
            data: { user }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /profile/drivers
 * @desc    Get transporter's drivers
 * @access  Transporter only
 */
router.get('/drivers', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const drivers = await profile_service_1.profileService.getTransporterDrivers(req.user.userId);
        res.json({
            success: true,
            data: { drivers }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   POST /profile/drivers
 * @desc    Add driver to transporter's fleet
 * @access  Transporter only
 */
router.post('/drivers', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        const data = (0, validation_utils_1.validateSchema)(profile_schema_1.addDriverSchema, req.body);
        const driver = await profile_service_1.profileService.addDriver(req.user.userId, data);
        res.status(201).json({
            success: true,
            data: { driver }
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   DELETE /profile/drivers/:driverId
 * @desc    Remove driver from fleet
 * @access  Transporter only
 */
router.delete('/drivers/:driverId', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['transporter']), async (req, res, next) => {
    try {
        await profile_service_1.profileService.removeDriver(req.user.userId, req.params.driverId);
        res.json({
            success: true,
            message: 'Driver removed'
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * @route   GET /profile/transporter
 * @desc    Get driver's transporter info
 * @access  Driver only
 */
router.get('/my-transporter', auth_middleware_1.authMiddleware, (0, auth_middleware_1.roleGuard)(['driver']), async (req, res, next) => {
    try {
        const transporter = await profile_service_1.profileService.getDriverTransporter(req.user.userId);
        res.json({
            success: true,
            data: { transporter }
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=profile.routes.js.map