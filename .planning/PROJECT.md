# Weelo

## What This Is

Weelo is a logistics/trucking platform that connects customers who need goods transported with transporters who own fleets of trucks and drivers. It consists of three apps: a Node.js/TypeScript backend (Express + Prisma + PostgreSQL + Redis) deployed on AWS ECS, a Captain App (Android/Kotlin/Jetpack Compose) for transporters and drivers to manage fleet and accept trips, and a Customer App (Android/Kotlin) for booking shipments and tracking deliveries in real-time.

## Core Value

Customers can reliably search for trucks, get matched with available transporters, and track their shipment from pickup to delivery — with zero ghost requests, zero stuck states, and real-time visibility for all parties.

## Requirements

### Validated

- [x] Customer can create single-truck and multi-truck bookings — existing
- [x] OTP-based phone authentication for all user roles — existing
- [x] Driver/transporter online/offline toggle with Redis presence and distributed locking — existing (hardened through 15+ fixes)
- [x] Real-time location tracking via WebSocket (Socket.IO) — existing
- [x] FCM push notifications for booking lifecycle events — existing
- [x] Server-side pricing with price validation — existing
- [x] Geospatial transporter matching by vehicle type — existing
- [x] Driver rating system with customer feedback — existing
- [x] 11-language localization (Captain App) — existing
- [x] Transporter fleet management (vehicles, drivers) — existing
- [x] Trip status tracking (at_pickup, loaded, in_transit, completed) — existing
- [x] Redis-backed rate limiting across all endpoints — existing
- [x] Broadcast optimization with Redis online:transporters set — existing
- [x] Stale transporter cleanup (30s interval, presence TTL) — existing
- [x] Driver offline detection (30s checker, 2min threshold) — existing
- [x] AWS deployment (ECS Fargate + ALB + RDS + ElastiCache) — existing

### Active

- [ ] Driver online/offline visibility reflected in real-time on transporter side
- [ ] Broadcast rules: one active broadcast per customer, multiple customers concurrent
- [ ] Customer search cancel/timeout with full cleanup (no ghost requests)
- [ ] Broadcast lifecycle states (Created → Broadcasting → Awaiting → Terminal)
- [ ] Exactly-one-winner rule for broadcast acceptance
- [ ] Idempotent search (double-tap protection)
- [ ] Migrate secrets from plain-text ECS env vars to AWS Secrets Manager
- [ ] CI/CD pipeline via GitHub Actions (build, test, deploy)
- [ ] RDS hardening (Multi-AZ, 7-day backup retention, deletion protection)

### Out of Scope

- HTTPS/ALB HTTPS listener — no domain yet, HTTP works for now
- WAF on ALB — defer until HTTPS is set up
- Mobile app redesign — current UI works, focus on backend reliability
- Pricing algorithm changes — current pricing logic is stable
- Customer App Jetpack Compose migration — XML layouts work fine

## Context

**Existing codebase:** ~940 lines in AGENTS.md documenting 15+ critical fixes, 5 phases of features, and detailed architecture decisions. The backend is production-deployed on AWS ECS with 2 tasks behind an ALB.

**Key technical patterns:**
- Redis for everything distributed: rate limiting, presence, locks, caching, timers
- Graceful degradation on all Redis operations (falls back to DB/in-memory)
- WebSocket events for real-time updates (driver_status_changed, broadcast events)
- Zod schema validation on all endpoints
- Optimistic UI in Captain App with revert-on-failure pattern

**Known issues (from AGENTS.md):**
- Two order services exist: `src/modules/order/order.service.ts` (main) and `src/modules/booking/order.service.ts` (legacy)
- Secrets stored as plain-text ECS environment variables
- No CI/CD pipeline (manual docker build + ECR push + ECS force-deploy)
- RDS single-AZ with 1-day backup retention
- tsconfig strict mode is false

**PRD reference:** `~/Desktop/DRIVER_ONLINE_BROADCAST_SEARCH_PRD.md` — non-technical PRD covering driver visibility, broadcast rules, and search cancel/timeout cleanup.

**Open product decisions (from PRD Section 13):**
1. New search while one active: block or auto-cancel previous?
2. Broadcast timeout duration (30s / 60s / 120s)?
3. Can drivers go offline during active trip?
4. Show broadcast history to customer/transporter?

## Constraints

- **Tech Stack**: Node.js/TypeScript/Express/Prisma/PostgreSQL/Redis backend — no changes
- **Android**: Captain App (Kotlin/Compose), Customer App (Kotlin/XML) — no platform changes
- **AWS**: ECS Fargate + ALB + RDS + ElastiCache — existing infrastructure
- **Compatibility**: All changes must be backward-compatible with deployed Captain/Customer app versions
- **Performance**: Redis operations must remain O(1) per transporter for broadcast filtering

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| HTTP-only for now | No domain available for SSL cert | — Pending |
| Backend-first development | Backend drives all business logic; apps consume APIs | — Pending |
| Redis presence model for driver visibility | Already battle-tested through 15+ fixes | ✓ Good |
| Optimistic UI pattern in Captain App | Instant feedback with revert-on-failure | ✓ Good |
| Broadcast cleanup on terminal state | PRD requires zero ghost requests | — Pending |

---
*Last updated: 2026-02-19 after initialization*
