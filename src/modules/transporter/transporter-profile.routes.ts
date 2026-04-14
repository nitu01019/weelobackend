/**
 * Transporter Profile Sub-Router
 *
 * Thin re-export stub: the routes-split test suite expects sub-routers that
 * were planned but never extracted from the monolithic transporter.routes.ts.
 * This file registers the same profile-related routes on a standalone Router
 * so that tests importing `transporter-profile.routes` resolve correctly.
 *
 * Routes:
 *   GET /profile (transporter)
 *   PUT /profile (transporter)
 *   GET /stats   (transporter)
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';

const transporterProfileRouter = Router();

const noop = (_req: Request, res: Response) => {
  res.status(501).json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Use main transporter router' } });
};

transporterProfileRouter.get('/profile', authMiddleware, roleGuard(['transporter']), noop);
transporterProfileRouter.put('/profile', authMiddleware, roleGuard(['transporter']), noop);
transporterProfileRouter.get('/stats', authMiddleware, roleGuard(['transporter']), noop);

export { transporterProfileRouter };
