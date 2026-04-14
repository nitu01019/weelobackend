/**
 * =============================================================================
 * PRISMA CLIENT — Thin delegation layer to prisma.service.ts
 * =============================================================================
 *
 * @deprecated Use prismaClient from './prisma.service' instead.
 * This file originally created a SEPARATE connection pool (connection_limit=50).
 * It now delegates to the single pool in prisma.service.ts to avoid pool
 * divergence (Issue #22). Do not add new imports of this file in production code.
 *
 * Existing repository files (src/shared/database/repositories/*) still import
 * from here for backward compatibility — they get the same singleton pool.
 * =============================================================================
 */

import { PrismaClient } from '@prisma/client';
import { prismaClient } from './prisma.service';

// =============================================================================
// DB ERROR SANITIZER — Prevents leaking hostnames/credentials in logs
// =============================================================================
export function sanitizeDbError(msg: string): string {
  return msg
    .replace(/(?:postgresql|mysql|mongodb):\/\/[^\s]+/gi, '[DB_URL_REDACTED]')
    .replace(/\.rds\.amazonaws\.com\S*/g, '.[RDS_REDACTED]')
    .replace(/password\s*=\s*\S+/gi, 'password=[REDACTED]')
    .replace(/host\s*=\s*\S+/gi, 'host=[REDACTED]')
    .replace(/user\s*=\s*\S+/gi, 'user=[REDACTED]');
}

// =============================================================================
// PAGINATION SAFETY — Prevents unbounded queries from exhausting memory
// =============================================================================
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

// =============================================================================
// CONNECTION POOL CONFIGURATION (read-only reference — actual config lives in prisma.service.ts)
// =============================================================================
export const DB_POOL_CONFIG = {
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
  poolTimeout: parseInt(process.env.DB_POOL_TIMEOUT || '5', 10),
};

/**
 * @deprecated Use `prismaClient` from './prisma.service' instead.
 * Returns the SAME singleton PrismaClient from prisma.service.ts.
 * No separate connection pool is created.
 */
export function getPrismaClient(): PrismaClient {
  return prismaClient;
}

// =============================================================================
// Re-export withDbTimeout from prisma.service.ts for backward compatibility.
// All production code already imports from prisma.service.ts directly.
// This re-export exists only so test files that import from this module still work.
// =============================================================================
export { withDbTimeout } from './prisma.service';

// =============================================================================
// Re-export getReadReplicaClient — delegates to prisma.service.ts singleton.
// Not used by any production code, kept for test backward compatibility.
// =============================================================================
import { prismaReadClient } from './prisma.service';

export function getReadReplicaClient(): PrismaClient {
  return prismaReadClient;
}
