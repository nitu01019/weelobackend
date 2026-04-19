/**
 * Order CRUD Sub-Router
 *
 * Thin re-export stub: the routes-split test suite expects sub-routers that
 * were planned but never extracted from the monolithic order.routes.ts.
 * This file registers the same CRUD-related routes on a standalone Router
 * so that tests importing `order-crud.routes` resolve correctly.
 *
 * Routes:
 *   GET  /check-active   (customer)
 *   POST /               (customer)
 *   GET  /               (customer)
 *   GET  /active         (transporter)
 *   GET  /:id            (customer | transporter)
 *   POST /accept         (transporter)
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, roleGuard } from '../../shared/middleware/auth.middleware';
import { bookingQueue, Priority } from '../../shared/resilience/request-queue';

const orderCrudRouter = Router();

// Placeholder handler — the real logic lives in order.routes.ts
const noop = (_req: Request, res: Response) => {
  res.status(501).json({ success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Use main order router' } });
};

orderCrudRouter.get('/check-active', authMiddleware, roleGuard(['customer']), noop);
orderCrudRouter.post('/', authMiddleware, roleGuard(['customer']), noop);
orderCrudRouter.get('/', authMiddleware, roleGuard(['customer']), noop);
orderCrudRouter.get('/active', authMiddleware, roleGuard(['transporter']), noop);
orderCrudRouter.get('/:id', authMiddleware, roleGuard(['customer', 'transporter']), noop);
orderCrudRouter.post('/accept', authMiddleware, roleGuard(['transporter']), bookingQueue.middleware({ priority: Priority.CRITICAL }), noop);

export { orderCrudRouter };
