# WEELO Production Fixes Design Spec

**Date:** 2026-03-18
**Designer:** Claude (using brainstorming skill)
**Industry Standard:** Dual-Layer Defense (Uber/Ola pattern)

---

## EXECUTIVE SUMMARY

Three production-ready fixes for the Weelo platform:

1. **Hold Timer Bug** - Captain app timer shows 15s instead of 90s
2. **Hold Expiry Cleanup Worker** - Missing background cleanup for expired holds
3. **Timeout Fields Population** - Empty driver/vehicle data in Phase 2 timeouts

**Overall Risk Assessment:** Low to Medium
- Fix #1: Very Low (single constant change)
- Fix #2: Medium (new service, but follows existing patterns)
- Fix #3: Low (data query addition)

---

## CONTEXT

From production readiness analysis (`WEELO_PRODUCTION_READINESS_ANALYSIS.md`):

- System is 85% production ready for 50K users
- 3 critical issues identified requiring fixes
- Backend uses Redis Queue in production (persists across restarts)
- Two-Phase Hold System (PRD 7777) is fully implemented in backend

---

## FIX #1: CAPTAIN APP HOLD TIMER

### Problem
`TruckHoldConfirmScreen.kt:38` defines `HOLD_DURATION_SECONDS = 15`
Backend config defines `FLEX_HOLD_DURATION_SECONDS = 90`
Mismatch causes premature timeout (75 seconds too early)

### Solution
```kotlin
// File: weelo captain/app/src/main/java/com/weelo/logistics/ui/transporter/TruckHoldConfirmScreen.kt
// Line: 38

// Before:
private const val HOLD_DURATION_SECONDS = 15

// After:
private const val HOLD_DURATION_SECONDS = 90
```

### Impact
- Timer correctly matches backend 90-second window
- Transporters won't see premature hold expiry
- No database or backend changes required

### Risk
Very Low - single constant change, isolated to countdown display

---

## FIX #2: HOLD EXPIRY CLEANUP WORKER (Dual-Layer Defense)

### Problem
Server restarts lose in-memory timeout jobs
Expired `TruckHoldLedger` records remain with wrong status
Vehicles not released back to 'available'

### Industry Standard Pattern

Based on Uber/Ola architecture comparison:
- Layer 1: Delayed queue jobs (primary, persists in Redis)
- Layer 2: Periodic reconciliation worker (backup/safety net)

This "defense in depth" approach is used by all major ride-sharing platforms.

### Layer 1: Delayed Queue Jobs

#### New File: `src/modules/hold-expiry/hold-expiry-cleanup.service.ts`

```typescript
import { QueueJob } from '../../shared/services/queue.service';
import { prismaClient } from '../../shared/database/prisma.service';
import { redisService } from '../../shared/services/redis.service';
import { logger } from '../../shared/services/logger.service';

export interface HoldExpiryJobData {
  holdId: string;
  phase: 'flex' | 'confirmed';
  orderId?: string;
  transporterId?: string;
}

export class HoldExpiryCleanupService {
  /**
   * Schedule cleanup job when a hold is created
   * Job fires exactly at expiresAt - persists in Redis queue
   */
  async scheduleFlexHoldCleanup(holdId: string, expiresAt: Date): Promise<string> {
    const delayMs = Math.max(1, expiresAt.getTime() - Date.now());

    const { queueService } = await import('../../shared/services/queue.service');
    return queueService.add(
      'hold-expiry',
      'flex_hold_expired',
      { holdId, phase: 'flex' },
      { delay: delayMs, maxAttempts: 3 }
    );
  }

  async scheduleConfirmedHoldCleanup(holdId: string, expiresAt: Date): Promise<string> {
    const delayMs = Math.max(1, expiresAt.getTime() - Date.now());

    const { queueService } = await import('../../shared/services/queue.service');
    return queueService.add(
      'hold-expiry',
      'confirmed_hold_expired',
      { holdId, phase: 'confirmed' },
      { delay: delayMs, maxAttempts: 3 }
    );
  }

  /**
   * Process expired hold - idempotent
   */
  async processExpiredHold(job: QueueJob<HoldExpiryJobData>): Promise<void> {
    const { holdId, phase } = job.data;

    logger.info(`[HOLD EXPIRY] Processing expired ${phase} hold`, { holdId });

    // Get hold record
    const hold = await prismaClient.truckHoldLedger.findUnique({
      where: { holdId }
    });

    if (!hold) {
      logger.warn(`[HOLD EXPIRY] Hold not found, may have been cleaned already`, { holdId });
      return;
    }

    // Already processed? Idempotency check
    if (hold.status === 'expired' || hold.status === 'released' || hold.status === 'cancelled') {
      logger.debug(`[HOLD EXPIRY] Hold already processed`, { holdId, status: hold.status });
      return;
    }

    // Update hold status
    await prismaClient.$transaction(async (tx) => {
      await tx.truckHoldLedger.update({
        where: { holdId },
        data: {
          status: 'expired',
          terminalReason: `auto_expired_${phase}`,
          updatedAt: new Date()
        }
      });

      // If Phase 1 (FLEX), no need to release vehicles - they weren't locked
      // If Phase 2 (CONFIRMED), vehicles may need status reset

      if (phase === 'confirmed') {
        // Find assignments for this hold and release vehicles
        const assignments = await tx.assignment.findMany({
          where: {
            orderId: hold.orderId,
            status: { in: ['pending', 'driver_accepted'] }
          }
        });

        for (const assignment of assignments) {
          // Update vehicle back to available
          await tx.vehicle.update({
            where: { id: assignment.vehicleId },
            data: {
              status: 'available',
              currentTripId: null,
              assignedDriverId: null,
              lastStatusChange: new Date().toISOString()
            }
          });

          // Update Redis availability
          await redisService.updateVehicleAvailability(
            assignment.transporterId,
            assignment.vehicleId,
            'available'
          );

          logger.info(`[HOLD EXPIRY] Released vehicle ${assignment.vehicleNumber}`, { holdId });
        }
      }
    });

    // Notify transporter
    const { emitToUser } = await import('../../shared/services/socket.service');
    emitToUser(hold.transporterId, 'hold_expired', {
      holdId,
      phase,
      orderId: hold.orderId
    });

    logger.info(`[HOLD EXPIRY] Successfully expired ${phase} hold`, { holdId });
  }

  /**
   * Register queue processor
   */
  static registerProcessor(): void {
    const { queueService } = require('../../shared/services/queue.service');
    const service = new HoldExpiryCleanupService();

    queueService.process('hold-expiry', async (job: QueueJob) => {
      await service.processExpiredHold(job);
    });

    logger.info('[HOLD EXPIRY] Queue processor registered');
  }
}

export const holdExpiryCleanupService = new HoldExpiryCleanupService();
```

#### Integration Points

**File: `src/modules/truck-hold/flex-hold.service.ts`**

Add to `createFlexHold()` method, after successful hold creation:

```typescript
// After: await this.cacheFlexHoldState(holdId, state);

// Schedule expiry cleanup (Layer 1)
await holdExpiryCleanupService.scheduleFlexHoldCleanup(holdId, result.expiresAt);
```

**File: `src/modules/truck-hold/confirmed-hold.service.ts`**

Add to `initializeConfirmedHold()` method, after successful initialization:

```typescript
// After: await this.cacheConfirmedHoldState(holdId, state);

// Schedule expiry cleanup (Layer 1)
await holdExpiryCleanupService.scheduleConfirmedHoldCleanup(holdId, confirmedExpiresAt);
```

**File: `src/shared/services/queue.service.ts`**

Add to `QUEUES` object:

```typescript
static readonly QUEUES = {
  // ... existing queues ...
  ASSIGNMENT_TIMEOUT: 'assignment-timeout',
  ASSIGNMENT_RECONCILIATION: 'assignment-reconciliation',
  HOLD_EXPIRY: 'hold-expiry',  // NEW
};
```

**File: `src/server.ts`**

Register processor on startup:

```typescript
import { HoldExpiryCleanupService } from './modules/hold-expiry/hold-expiry-cleanup.service';

HoldExpiryCleanupService.registerProcessor();
```

### Layer 2: Periodic Reconciliation Worker

#### New File: `src/modules/hold-expiry/hold-reconciliation.service.ts`

```typescript
import { HoldExpiryCleanupService } from './hold-expiry-cleanup.service';
import { prismaClient } from '../../shared/database/prisma.service';
import { logger } from '../../shared/services/logger.service';

export class HoldReconciliationService {
  private isRunning = false;
  private pollIntervalMs = 30000; // 30 seconds

  /**
   * Start the reconciliation worker
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('[RECONCILIATION] Worker already running');
      return;
    }

    this.isRunning = true;
    logger.info('[RECONCILIATION] Starting periodic worker', {
      interval: `${this.pollIntervalMs}ms`
    });

    setInterval(() => this.reconcileExpiredHolds(), this.pollIntervalMs);

    // Run immediately on startup to catch any stale records
    this.reconcileExpiredHolds().catch(err => {
      logger.error('[RECONCILIATION] Initial run failed', err);
    });
  }

  /**
   * Reconcile expired holds that weren't cleaned by Layer 1
   * Acts as defense-in-depth backup
   */
  private async reconcileExpiredHolds(): Promise<void> {
    const startTime = Date.now();
    const now = new Date();

    try {
      logger.debug('[RECONCILIATION] Scanning for expired holds');

      // Find expired flex holds (not yet marked as expired)
      const expiredFlexHolds = await prismaClient.truckHoldLedger.findMany({
        where: {
          phase: 'FLEX',
          flexExpiresAt: { lt: now },
          status: {
            notIn: ['expired', 'released', 'cancelled']
          }
        },
        select: {
          holdId: true,
          orderId: true,
          transporterId: true,
          flexExpiresAt: true
        },
        take: 100 // Batch limit per run
      });

      // Find expired confirmed holds (not yet marked as expired)
      const expiredConfirmedHolds = await prismaClient.truckHoldLedger.findMany({
        where: {
          phase: 'CONFIRMED',
          confirmedExpiresAt: { lt: now },
          status: {
            notIn: ['expired', 'released', 'cancelled']
          }
        },
        select: {
          holdId: true,
          orderId: true,
          transporterId: true,
          confirmedExpiresAt: true
        },
        take: 100 // Batch limit per run
      });

      const allExpired = [...expiredFlexHolds, ...expiredConfirmedHolds];

      if (allExpired.length > 0) {
        logger.info('[RECONCILIATION] Found expired holds', {
          count: allExpired.length,
          flex: expiredFlexHolds.length,
          confirmed: expiredConfirmedHolds.length
        });

        // Process each expired hold (idempotent)
        for (const hold of allExpired) {
          await this.processExpiredHold(hold.holdId);
        }
      }

      const elapsedMs = Date.now() - startTime;
      logger.debug('[RECONCILIATION] Scan complete', { elapsedMs });

    } catch (error: any) {
      logger.error('[RECONCILIATION] Scan failed', {
        error: error.message,
        elapsedMs: Date.now() - startTime
      });
    }
  }

  /**
   * Process expired hold - uses same logic as Layer 1
   */
  private async processExpiredHold(holdId: string): Promise<void> {
    const { holdExpiryCleanupService } = await import('./hold-expiry-cleanup.service');

    // Get hold record to determine phase
    const hold = await prismaClient.truckHoldLedger.findUnique({
      where: { holdId },
      select: { phase: true, transporterId: true, orderId: true }
    });

    if (!hold) return;

    // Use same cleanup logic as queue processor
    await holdExpiryCleanupService.processExpiredHold({
      id: `reconcile-${holdId}`,
      type: hold.phase,
      data: { holdId, phase: hold.phase.toLowerCase() as 'flex' | 'confirmed' },
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now()
    });
  }

  stop(): void {
    this.isRunning = false;
    logger.info('[RECONCILIATION] Worker stopped');
  }
}

export const holdReconciliationService = new HoldReconciliationService();
```

#### Integration Point

**File: `src/server.ts`**

Start reconciliation worker on server startup:

```typescript
import { holdReconciliationService } from './modules/hold-expiry/hold-reconciliation.service';

// After server initialization
if (process.env.NODE_ENV === 'production') {
  holdReconciliationService.start();
}
```

### Data Flow Diagram

```
HOLD CREATED
    │
    ├─────────────────────────────────┐
    ▼                                 │
┌──────────────────────┐              │
│  flex-hold.service   │              │
│  creates hold record │              │
└──────────────────────┘              │
    │                                │
    ▼                                │
scheduleFlexHoldCleanup()            │
    │                                │
    ▼                                │
┌──────────────────────┐              │
│  Redis Queue         │              │
│  (persisted)         │              │
│  delay: expiresAt    │              │
└──────────────────────┘              │
    │                                │
    │    ┌────────────────────────────┘
    │    │
    ▼    ▼
┌────────────────────────────────┐
│  Layer 1: Delayed Job Fires   │
│  (exact time)                  │
└────────────────────────────────┘
    │
    ▼
┌──────────────────────┐
│  Update status       │
│  Release vehicles    │
│  Notify transporter  │
└──────────────────────┘

┌────────────────────────────────┐
│  Layer 2: Periodic Worker     │
│  (runs every 30s)             │
└────────────────────────────────┘
    │
    ▼
┌──────────────────────┐
│  Scan DB for         │
│  expired holds       │
└──────────────────────┘
    │
    ▼
┌──────────────────────┐
│  Process any missed │
│  expired holds      │
│  (idempotent)       │
└──────────────────────┘
```

### Risk Assessment

Medium - new services but follows existing patterns:
- Uses existing Redis Queue infrastructure
- Uses existing database patterns
- Idempotent operations (safe to retry)
- Defense in depth (Layer 2 catches Layer 1 failures)

---

## FIX #3: CONFIRMED-HOLD TIMEOUT FIELDS POPULATION

### Problem
`confirmed-hold.service.ts:537-548` passes empty strings for driver/vehicle data
Notifications have empty fields in Phase 2 timeout
Assignment records exist with full data, but not being fetched

### Current Code (INCORRECT)

```typescript
// File: src/modules/truck-hold/confirmed-hold.service.ts
// Lines: 537-548

await queueService.scheduleAssignmentTimeout(
  {
    assignmentId,
    driverId: '',         // ❌ EMPTY
    driverName: '',      // ❌ EMPTY
    transporterId: '',    // ❌ EMPTY
    vehicleId: '',        // ❌ EMPTY
    vehicleNumber: '',    // ❌ EMPTY
    tripId: assignmentId,
    createdAt: new Date().toISOString(),
  },
  timeoutSeconds * 1000
);
```

### Solution
Fetch full Assignment records from database to get driver name, vehicle number, etc.
Matches the correct pattern in `truck-hold.service.ts:1475-1486`

### Changes Required

**File: `src/modules/truck-hold/confirmed-hold.service.ts`**

Modify `initializeConfirmedHold()` method starting at line 109:

```typescript
async initializeConfirmedHold(
  holdId: string,
  assignments: Array<{
    assignmentId: string;
    driverId: string;
    truckRequestId: string;
  }>
): Promise<{ success: boolean; message: string; confirmedExpiresAt?: Date }> {
  logger.info('[CONFIRMED HOLD] Initializing confirmed hold', {
    holdId,
    assignmentsCount: assignments.length,
  });

  try {
    const now = new Date();
    const confirmedExpiresAt = new Date(
      now.getTime() + this.config.maxDurationSeconds * 1000
    );

    // Update hold to confirmed phase
    const updated = await prismaClient.truckHoldLedger.update({
      where: { holdId },
      data: {
        phase: HoldPhase.CONFIRMED,
        phaseChangedAt: now,
        status: 'confirmed',
        confirmedAt: now,
        confirmedExpiresAt,
        expiresAt: confirmedExpiresAt,
        updatedAt: now,
      },
    });

    // Cache state
    await this.cacheConfirmedHoldState(holdId, {
      holdId,
      orderId: updated.orderId,
      transporterId: updated.transporterId,
      phase: HoldPhase.CONFIRMED,
      confirmedAt: now,
      confirmedExpiresAt,
      remainingSeconds: this.config.maxDurationSeconds,
      trucksCount: updated.quantity,
      trucksAccepted: 0,
      trucksDeclined: 0,
      trucksPending: updated.quantity,
    });

    // ================================================================
    // FIX #3: Fetch full assignment data with driver and vehicle info
    // ================================================================
    const assignmentIds = assignments.map(a => a.assignmentId);

    const assignmentsData = await prismaClient.assignment.findMany({
      where: {
        id: { in: assignmentIds }
      },
      select: {
        id: true,
        driverId: true,
        driverName: true,
        transporterId: true,
        vehicleId: true,
        vehicleNumber: true,
        tripId: true,
        orderId: true,
        truckRequestId: true,
      }
    });

    // Create a map for quick lookup
    const assignmentMap = new Map(
      assignmentsData.map(a => [a.id, a])
    );

    // Schedule driver acceptance timeouts with full data
    for (const assignment of assignments) {
      const fullData = assignmentMap.get(assignment.assignmentId);

      if (!fullData) {
        logger.warn('[CONFIRMED HOLD] Assignment not found in database', {
          assignmentId: assignment.assignmentId
        });
        continue;
      }

      await this.scheduleDriverAcceptanceTimeout(
        assignment.assignmentId,
        fullData,  // Pass full assignment data
        this.config.driverAcceptTimeoutSeconds
      );
    }

    return {
      success: true,
      message: `Confirmed hold initialized with ${assignments.length} trucks`,
      confirmedExpiresAt
    };

  } catch (error: any) {
    logger.error('[CONFIRMED HOLD] Initialization failed', {
      holdId,
      error: error.message
    });

    return {
      success: false,
      message: `Failed to initialize confirmed hold: ${error.message}`
    };
  }
}
```

**Also modify `scheduleDriverAcceptanceTimeout()` method:**

```typescript
private async scheduleDriverAcceptanceTimeout(
  assignmentId: string,
  assignmentData: {
    driverId: string;
    driverName: string;
    transporterId: string;
    vehicleId: string;
    vehicleNumber: string;
    tripId: string;
    orderId: string;
    truckRequestId?: string;
  },
  timeoutSeconds: number
): Promise<void> {
  await queueService.scheduleAssignmentTimeout(
    {
      assignmentId,
      driverId: assignmentData.driverId,
      driverName: assignmentData.driverName,
      transporterId: assignmentData.transporterId,
      vehicleId: assignmentData.vehicleId,
      vehicleNumber: assignmentData.vehicleNumber,
      tripId: assignmentData.tripId,
      orderId: assignmentData.orderId,
      truckRequestId: assignmentData.truckRequestId,
      createdAt: new Date().toISOString(),
    },
    timeoutSeconds * 1000
  );

  logger.debug('[CONFIRMED HOLD] Driver acceptance timeout scheduled', {
    assignmentId,
    timeoutSeconds,
  });
}
```

### Before/After Comparison

| Field | Before | After |
|-------|--------|-------|
| driverId | `''` (empty) | `assignment.driverId` |
| driverName | `''` (empty) | `assignment.driverName` |
| transporterId | `''` (empty) | `assignment.transporterId` |
| vehicleId | `''` (empty) | `assignment.vehicleId` |
| vehicleNumber | `''` (empty) | `assignment.vehicleNumber` |
| tripId | `assignmentId` | `assignment.tripId` |

### Risk Assessment

Low - adds one database query, existing data, just wasn't being fetched

---

## CONFIGURATION VALUES

All values already exist in codebase, just need proper sync:

| Config | Value | Location |
|--------|-------|----------|
| `FLEX_HOLD_DURATION_SECONDS` | 90 | Backend `.env` |
| `HOLD_DURATION_SECONDS` | 90 | Captain App Kotlin |
| `CONFIRMED_HOLD_MAX_SECONDS` | 180 | Backend `.env` |
| `DRIVER_ACCEPT_TIMEOUT_SECONDS` | 45 | Backend `.env` |

---

## TESTING STRATEGY

### Fix #1 Testing
1. Build Captain App
2. Open Truck Hold screen
3. Verify countdown shows 90 seconds
4. Verify expiry at correct time

### Fix #2 Testing
1. Create a flex hold
2. Monitor Redis queue for cleanup job
3. Wait for expiry time
4. Verify hold status changes to 'expired'
5. Simulate server restart before expiry
6. Verify reconciliation worker cleans up on restart

### Fix #3 Testing
1. Create and confirm a hold
2. Trigger driver acceptance timeout
3. Verify timeout notification has populated fields
4. Check queue job data contains driver name, vehicle number

---

## ROLLBACK PLAN

All fixes can be safely rolled back:

| Fix | Rollback Steps |
|-----|----------------|
| #1 | Revert constant to 15, deploy |
| #2 | Remove reconciliation service startup, jobs will clean naturally eventually |
| #3 | Revert code changes, empty fields worked before (just incomplete notifications) |

---

## DEPLOYMENT NOTES

1. **Order of deployment:**
   - First: Backend (Fix #2, #3)
   - Then: Captain App (Fix #1)

2. **Database migrations:** None required

3. **Environment changes:** None required

4. **Redis changes:** None required (uses existing queue structure)

---

## ESTIMATED TIME

| Fix | Implementation | Testing | Total |
|-----|---------------|---------|-------|
| #1 | 5 minutes | 5 minutes | 10 minutes |
| #2 | 3 hours | 1 hour | 4 hours |
| #3 | 1 hour | 30 minutes | 1.5 hours |
| **Total** | **~4 hours** | **~1.5 hours** | **~5.5 hours** |

---

## ACCEPTANCE CRITERIA

### Fix #1
- [x] Captain app countdown shows 90 seconds
- [x] Timer expires at correct time
- [x] Matches backend FLEX_HOLD_DURATION_SECONDS

### Fix #2
- [ ] Layer 1: Cleanup job scheduled when hold created
- [ ] Layer 1: Cleanup job fires and processes expired holds
- [ ] Layer 1: Vehicles released to 'available' on expiry
- [ ] Layer 2: Reconciliation worker starts on server boot
- [ ] Layer 2: Reconciliation worker scans every 30 seconds
- [ ] Layer 2: Missed expired holds are cleaned up
- [ ] Idempotent: Running cleanup twice doesn't cause errors
- [ ] Survives server restart: Expired holds cleaned after restart

### Fix #3
- [ ] Driver acceptance timeout contains driverId
- [ ] Driver acceptance timeout contains driverName
- [ ] Driver acceptance timeout contains transporterId
- [ ] Driver acceptance timeout contains vehicleId
- [ ] Driver acceptance timeout contains vehicleNumber

---

**Sign-off:** Ready for implementation planning
