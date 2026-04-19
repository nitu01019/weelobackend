# `@weelo/contracts` — event & enum source of truth

Owned by **F-C-52** (event names) and **F-C-78** (enums). This package is the
single source of truth for socket event names and shared enum values across
the Weelo monorepo.

## Why

Three repos (backend, captain, customer) used to hand-roll their own event
registries and enum classes. A rename on one side was silently dropped on the
other two — see TM-8.md:47-56 for the drift evidence. This package replaces
that with a deterministic AsyncAPI + protobuf codegen.

## Layout

```
packages/contracts/
├── events.asyncapi.yaml        # source of truth — socket event names
├── schemas/enums.proto         # source of truth — HoldPhase, AssignmentStatus, VehicleStatus, BookingStatus
├── codegen.mjs                 # Node script (zero deps) → TS outputs
├── events.generated.ts         # SocketEvent map + SocketEventName union (committed)
├── enums.generated.ts          # Enum value maps + fromBackendString helpers (committed)
├── verify.mjs                  # CI drift guard (advisory; --strict fails build)
└── README.md                   # you are here
```

Generated artifacts are committed so downstream repos never run codegen at install time.

## Regenerate

```bash
node packages/contracts/codegen.mjs
```

## Verify locally (what CI runs)

```bash
npm run contracts:verify         # advisory mode (exits 0 with warnings)
npm run contracts:verify -- --strict   # strict mode (exits 1 on drift)
```

Verify checks two invariants:

1. **Regeneration determinism** — codegen output matches committed files exactly.
2. **No hand-rolled registries** — no file outside `packages/contracts/`
   declares `export const SocketEvent = { ... }`.

## Consumer contract

### Backend (this repo)

```ts
// src/shared/services/socket.service.ts
import { SocketEvent } from '../../../packages/contracts/events.generated';
import { HoldPhase } from '../../../packages/contracts/enums.generated';
export { SocketEvent } from '../../../packages/contracts/events.generated';
```

Call sites already reference `SocketEvent.FLEX_HOLD_STARTED` etc. — no change required.

### Captain + Customer (P10, not this PR)

Both Kotlin repos will gain a `typealias SocketEvent = generated.SocketEvent`
once the Kotlin emitter is stood up (tracked under F-C-78 downstream waves).

## Extending

- **New event**: add a `<name>:\n  address: <name>\n  messages: {}` block under
  `channels:` in `events.asyncapi.yaml`, then run codegen.
- **Legacy alias**: add `<MEMBER_NAME>: <existing_address>` under the
  `x-event-aliases:` section. Validates that the target exists.
- **New enum value**: edit `schemas/enums.proto`, then run codegen. Make sure
  Prisma schema + any migrations land in the same PR (or precede it).

## Rollout

This is a build-time contract, not a runtime flag. Rollout plan in 4 PRs:

1. (this PR) — codegen lands; `verify.mjs` in advisory mode.
2. Per-module migrations: replace remaining `socket.emit('<literal>')` sites.
3. Flip `verify.mjs` to `--strict` in CI.
4. Captain/customer consumers swap to typealias (P10).
