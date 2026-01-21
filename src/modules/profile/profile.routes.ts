/**
 * =============================================================================
 * PROFILE MODULE - ROUTES
 * =============================================================================
 * 
 * API routes for profile management.
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { profileService } from './profile.service';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { validateSchema } from '../../shared/utils/validation.utils';
import {
  customerProfileSchema,
  transporterProfileSchema,
  driverProfileSchema,
  addDriverSchema
} from './profile.schema';

const router = Router();

/**
 * @route   GET /profile
 * @desc    Get current user's profile
 * @access  All authenticated users
 */
router.get(
  '/',
  authMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await profileService.getProfile(req.user!.userId);
      
      res.json({
        success: true,
        data: { user }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /profile/customer
 * @desc    Create/Update customer profile
 * @access  Customer only
 */
router.put(
  '/customer',
  authMiddleware,
  roleGuard(['customer']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = validateSchema(customerProfileSchema, req.body);
      
      const profile = await profileService.updateCustomerProfile(
        req.user!.userId,
        req.user!.phone,
        data
      );
      
      res.json({
        success: true,
        data: { profile }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /profile/transporter
 * @desc    Create/Update transporter profile
 * @access  Transporter only
 */
router.put(
  '/transporter',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = validateSchema(transporterProfileSchema, req.body);
      
      const user = await profileService.updateTransporterProfile(
        req.user!.userId,
        req.user!.phone,
        data
      );
      
      res.json({
        success: true,
        data: { user }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /profile/driver
 * @desc    Create/Update driver profile
 * @access  Driver only
 */
router.put(
  '/driver',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = validateSchema(driverProfileSchema, req.body);
      
      const user = await profileService.updateDriverProfile(
        req.user!.userId,
        req.user!.phone,
        data
      );
      
      res.json({
        success: true,
        data: { user }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /profile/drivers
 * @desc    Get transporter's drivers
 * @access  Transporter only
 */
router.get(
  '/drivers',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const drivers = await profileService.getTransporterDrivers(req.user!.userId);
      
      res.json({
        success: true,
        data: { drivers }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /profile/drivers
 * @desc    Add driver to transporter's fleet
 * @access  Transporter only
 */
router.post(
  '/drivers',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = validateSchema(addDriverSchema, req.body);
      
      const driver = await profileService.addDriver(req.user!.userId, data);
      
      res.status(201).json({
        success: true,
        data: { driver }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   DELETE /profile/drivers/:driverId
 * @desc    Remove driver from fleet
 * @access  Transporter only
 */
router.delete(
  '/drivers/:driverId',
  authMiddleware,
  roleGuard(['transporter']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await profileService.removeDriver(req.user!.userId, req.params.driverId);
      
      res.json({
        success: true,
        message: 'Driver removed'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /profile/transporter
 * @desc    Get driver's transporter info
 * @access  Driver only
 */
router.get(
  '/my-transporter',
  authMiddleware,
  roleGuard(['driver']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transporter = await profileService.getDriverTransporter(req.user!.userId);
      
      res.json({
        success: true,
        data: { transporter }
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as profileRouter };
