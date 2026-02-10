/**
 * =============================================================================
 * CUSTOMER ROUTES - Wallet, Trips, Settings
 * =============================================================================
 * 
 * SCALABILITY:
 * - All endpoints cached with Redis
 * - Cache-Control headers for client-side caching
 * 
 * EASY UNDERSTANDING:
 * - RESTful endpoint naming
 * - Standard HTTP methods
 * 
 * MODULARITY:
 * - Separate from booking/auth routes
 * 
 * CODING STANDARDS:
 * - Consistent response format
 * - Proper error handling
 * =============================================================================
 */

import { Router, Request, Response, NextFunction } from 'express';
import { customerService } from './customer.service';
import { authMiddleware } from '../../shared/middleware/auth.middleware';

const router = Router();

/**
 * @route   GET /customer/wallet
 * @desc    Get customer wallet balance
 * @access  Authenticated customers only
 * 
 * SCALABILITY: Cached in Redis (10 min TTL)
 */
router.get(
  '/wallet',
  authMiddleware,
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const userId = req.userId!;
      
      const wallet = await customerService.getWallet(userId);
      
      // SCALABILITY: Add Cache-Control header (5 minutes)
      res.setHeader('Cache-Control', 'private, max-age=300');
      
      res.json({
        success: true,
        data: { wallet }
      });
    } catch (error) {
      _next(error);
    }
  }
);

/**
 * @route   GET /customer/trips
 * @desc    Get customer trip count
 * @access  Authenticated customers only
 * 
 * SCALABILITY: Cached count query
 */
router.get(
  '/trips',
  authMiddleware,
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const userId = req.userId!;
      
      const tripCount = await customerService.getTripCount(userId);
      
      // SCALABILITY: Cache-Control header
      res.setHeader('Cache-Control', 'private, max-age=300');
      
      res.json({
        success: true,
        data: { tripCount }
      });
    } catch (error) {
      _next(error);
    }
  }
);

/**
 * @route   GET /customer/settings
 * @desc    Get customer settings
 * @access  Authenticated customers only
 * 
 * SCALABILITY: Cached in Redis
 */
router.get(
  '/settings',
  authMiddleware,
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const userId = req.userId!;
      
      const settings = await customerService.getSettings(userId);
      
      // SCALABILITY: Cache-Control header
      res.setHeader('Cache-Control', 'private, max-age=300');
      
      res.json({
        success: true,
        data: { settings }
      });
    } catch (error) {
      _next(error);
    }
  }
);

/**
 * @route   PUT /customer/settings
 * @desc    Update customer settings
 * @access  Authenticated customers only
 * 
 * MODULARITY: Simple update endpoint
 */
router.put(
  '/settings',
  authMiddleware,
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const userId = req.userId!;
      const data = req.body;
      
      const settings = await customerService.updateSettings(userId, data);
      
      res.json({
        success: true,
        data: { settings }
      });
    } catch (error) {
      _next(error);
    }
  }
);

export default router;
