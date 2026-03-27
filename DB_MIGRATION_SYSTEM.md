# Weelo Backend — DB Migration System

> **Last Updated:** 2026-03-23
> **Commit:** `16a5db0`
> **Pattern:** Netflix / Stripe / Airbnb industry standard

---

## 📋 What Was The Problem?

### Before (Broken) ❌

```
Container starts
    ↓
docker-entrypoint.sh runs: npx prisma db push
    ↓
prisma db push FAILS every deploy because:
  - Old tables (DispatchReplayCheckpoint, etc.) exist in DB but not in schema
  - Prisma refuses to drop them without --accept-data-loss
    ↓
Script says: "⚠️ Failed, but continuing..."  ← SILENT FAILURE!
    ↓
App starts with DB that may be out of sync
```

**Real Impact:**
- `HoldPhase` ENUM was never added to DB automatically
- Had to manually run SQL on production DB to fix it
- Every future DB column change would have the same problem
- `prisma db push` can accidentally DROP data if schema changes

---

## ✅ What We Fixed

### After (Industry Standard) ✅

```
Push to GitHub main
    ↓
GitHub Actions:
  Step 1: npm ci
  Step 2: TypeScript check (npx tsc --noEmit)
  Step 3: Run tests (jest)
  Step 4: ← NEW → Run database migrations (prisma migrate deploy)
           If fails → STOP deployment, protect production DB ✅
  Step 5: Build Docker image
  Step 6: Deploy to ECS
    ↓
Container starts
    ↓
docker-entrypoint.sh runs: npx prisma migrate deploy
    ↓
Runs ONLY new migration files (skips already-applied ones)
    ↓
If fails → exit 1 → ECS won't route traffic to broken container ✅
    ↓
App starts with CORRECT, synced DB ✅
```

---

## 🔄 How It Works — Simple English

### `prisma db push` (OLD — removed)
- Looks at schema.prisma → tries to make DB match it
- If something is different → may DROP columns, DROP tables
- Doesn't track what it did → runs same thing every restart
- Can silently fail and continue

### `prisma migrate deploy` (NEW — industry standard)
- Looks at `prisma/migrations/` folder for SQL files
- Checks `_prisma_migrations` table in DB — "what have I already run?"
- Runs ONLY new files it hasn't run before
- **Idempotent** — safe to run 1000 times, same result
- If fails → STOPS (doesn't silently continue)

---

## 📁 Migration Files Structure

```
prisma/migrations/
├── 20260219_add_broadcast_lifecycle_states/migration.sql    ✅ Applied
├── 20260225_add_truckrequest_notified_transporters_gin_index/migration.sql  ✅ Applied
├── 20260228_phase2_reliability_core/migration.sql           ✅ Applied
├── 20260228_phase4_hold_reliability/migration.sql           ✅ Applied
├── 20260228_phase5_cancel_reliability/migration.sql         ✅ Applied
└── 20260321_hold_phase_system/migration.sql                 ← NEW (idempotent)
```

### What the new migration does:
1. Creates `HoldPhase` ENUM (`FLEX`, `CONFIRMED`, `EXPIRED`, `RELEASED`) — safe if exists
2. Converts `phase` column TEXT → ENUM — OR adds it if missing (handles BOTH states)
3. Adds `phaseChangedAt`, `flexExpiresAt`, `flexExtendedCount`, `confirmedExpiresAt` — IF NOT EXISTS
4. Creates indexes — IF NOT EXISTS

---

## 🚀 How To Add A New DB Column In Future

### Step 1: Create migration file
```bash
mkdir prisma/migrations/YYYYMMDD_describe_change
# Create migration.sql with your SQL
```

### Step 2: Write idempotent SQL (always)
```sql
-- Good: safe to run multiple times
ALTER TABLE "MyTable" ADD COLUMN IF NOT EXISTS "newColumn" TEXT;

-- Good: safe enum creation
DO $$ BEGIN
    CREATE TYPE "MyEnum" AS ENUM ('A', 'B');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Bad: will fail if run twice
ALTER TABLE "MyTable" ADD COLUMN "newColumn" TEXT;  ← don't do this
```

### Step 3: Commit & push to main
```bash
git add prisma/migrations/YYYYMMDD_describe_change/migration.sql
git commit -m "feat: add newColumn to MyTable"
git push origin main
```

### Step 4: GitHub Actions automatically:
1. Runs `prisma migrate deploy` → applies your new file ✅
2. Builds Docker image ✅
3. Deploys to ECS ✅
4. ECS container also runs `prisma migrate deploy` on startup (safety net) ✅

---

## 🛡️ Safety Guarantees

| Scenario | What Happens |
|----------|-------------|
| Migration runs successfully | `_prisma_migrations` records it → never runs again |
| Migration fails | GitHub Actions stops → no Docker build → no deploy → production safe |
| Two containers start simultaneously | Both run `migrate deploy` → Postgres advisory locks ensure only one runs |
| Same migration runs twice | Skipped (already in `_prisma_migrations`) |
| Network blip during migration | Fails → exits 1 → ECS won't start container |
| Invalid SQL in migration | Fails in CI/CD → catches before production |

---

## 🏢 Industry Comparison

| Company | Strategy | What We Do |
|---------|----------|-----------|
| Netflix | CI/CD migrations + blue-green deploy | ✅ Migrations in GitHub Actions |
| Stripe | Idempotent migrations + fail-fast | ✅ Idempotent SQL + exit 1 on failure |
| Airbnb | Migration job separate from deploy | ✅ Separate step before Docker build |
| Uber | Staged migrations (test → prod) | 🟡 Can add staging later |
| Shopify | Auto-migrations on startup with locking | ✅ Container startup as safety net |

---

## ⚠️ Important Rules

1. **NEVER use `prisma db push` on production** — can drop data
2. **Always write idempotent SQL** — use `IF NOT EXISTS`, `DO $$ EXCEPTION` blocks
3. **One migration = one logical change** — don't mix unrelated changes
4. **Never edit an already-applied migration file** — create a new one instead
5. **Test migration locally before pushing** — `npx prisma migrate deploy` on local DB

---

## 🔑 Environment Variables Required

```env
DATABASE_URL=postgresql://...  # Must be set in GitHub Secrets AND ECS task definition
```

GitHub Secret: `DATABASE_URL` — used by GitHub Actions migration step
ECS Task Definition: `DATABASE_URL` — used by container startup migration

---

## 📊 What Was Fixed Today (2026-03-23)

| What | Before | After |
|------|--------|-------|
| DB sync method | `prisma db push` (risky) | `prisma migrate deploy` (safe) |
| Migration failure | Silent warning, app starts | Hard fail, blocks deployment |
| Migration tracking | None (`_prisma_migrations` didn't exist) | Full tracking via `_prisma_migrations` |
| Migration files | 3 separate broken files (wrong table names) | 1 clean idempotent file |
| CI/CD | No migration step | Migrations run before Docker build |
| HoldPhase ENUM | Had to manually run SQL | Auto-applied via migration |

