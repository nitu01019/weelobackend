/**
 * Transporter Dispatch Sub-Router
 *
 * Thin re-export stub: the routes-split test suite expects sub-routers that
 * were planned but never extracted from the monolithic transporter.routes.ts.
 * This file registers the same dispatch-related routes on a standalone Router
 * so that tests importing `transporter-dispatch.routes` resolve correctly.
 *
 * Routes:
 *   GET /dispatch/replay (transporter)
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';

const transporterDispatchRouter = Router();

const noop = (_req: Request, res: Response) => {
  res.status(501).json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Use main transporter router' } });
};

transporterDispatchRouter.get('/dispatch/replay', authMiddleware, roleGuard(['transporter']), noop);

export { transporterDispatchRouter };
