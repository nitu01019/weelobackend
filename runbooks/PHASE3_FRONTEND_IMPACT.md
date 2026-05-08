# Phase 3 — Frontend Impact Notice (Customer Android + Captain Android)

| | |
|---|---|
| **Date** | 2026-05-09 |
| **Branch** | `fix/critical-broadcast-reliability-2026-04-21` |
| **HEAD at authoring** | `0baa7955` |
| **Source-of-truth** | `/Users/nitishbhardwaj/Downloads/index-20-validated.md` (§1.7 Fix #23, §1.4 Fix #17, §5.3 NEW#3, §2.2.1 Fix #13) |
| **Audience** | Captain Android team, Customer Android team |
| **TL;DR** | **No wire-format changes in Phase 3.** All Phase 3 fixes are server-side correctness work that is invisible to the client. No mobile-side code changes are required. The only observable behavioral difference is a small reduction in misleading "0 km · 0 min" broadcast rows that Captain users were occasionally seeing. |

---

## Section 1 — Fix #23: Skip emit when `pickupData` missing

### What changed (server-side)

In `src/modules/order/order-broadcast.service.ts:997-1004` (primary site, broadcast loop entry at `:964`) and the mirror `src/modules/order/order-broadcast-send.service.ts:676-683` (mirror site, broadcast loop entry at `~:660`), the broadcast emit loop now `continue`s past any transporter whose pickup distance/ETA could not be resolved from the Distance Matrix batch result (`candidateDistanceMap`). Previously the loop would log a warning and fall through to emit `pickupDistanceKm: 0, pickupEtaMinutes: 0` — Captain Android UI would render that as a "0 km · 0 min" pickup distance.

The transporter is **not** marked in `alreadyNotifiedSet`, so the next progressive broadcast step (radius-bumped, fresh DM call) re-attempts the same transporter normally.

### Wire-format impact

**None.** The Socket.IO event payload contract is unchanged.

| Field | Before (HEAD-1) | After (HEAD) |
|---|---|---|
| `pickupDistanceKm` | `number` (could be `0` if DM missed) | `number` (always real value, never `0`-as-fallback) |
| `pickupEtaMinutes` | `number` (could be `0` if DM missed) | `number` (always real value, never `0`-as-fallback) |
| Field presence | always present | always present |
| Field type | `number` | `number` |

The fields are **still always present** and **still typed as `number`** when a `new_broadcast` event is emitted. The only difference is that some transporters, on some progressive-step rounds, no longer receive the broadcast at all (they get re-included on the next step once the DM batch resolves their pickup data).

### Affected event names + emit functions

| Event name | Emit function | File:line | Notes |
|---|---|---|---|
| `new_broadcast` | `queueService.queueBroadcast(transporterId, 'new_broadcast', personalizedBroadcast)` | `src/modules/order/order-broadcast.service.ts:1028` | Primary broadcast site. Personalized payload carries `pickupDistanceKm` + `pickupEtaMinutes`. |
| `new_broadcast` | `queueService.queueBroadcast(transporterId, 'new_broadcast', personalizedBroadcast)` | `src/modules/order/order-broadcast-send.service.ts:700` | Mirror file (same lying-emit pattern at `:691-692` was patched per §1.7 mirror call-out). |

Both sites construct `personalizedBroadcast` from the same `pickupData.distanceKm` / `Math.ceil(pickupData.etaSeconds / 60)` shape — the `continue` guard ensures `pickupData` is non-null before the personalized payload is built.

### Captain Android — what to do

**Nothing required.** No code change.

Existing Captain Android consumers of the `new_broadcast` event payload (the broadcast list/inbox screens that read `pickupDistanceKm` and `pickupEtaMinutes` to render "X km · Y min away" rows) continue to work without modification. The fields remain `number` and remain always present.

**Observable behavioral difference at runtime**: drivers will no longer see occasional "0 km · 0 min" rows in their broadcast inbox. This was always a bug (no broadcast can legitimately have 0 km / 0 min pickup) — the fix removes the bad row entirely rather than displaying a misleading value.

### Customer Android — what to do

**Nothing required.** Customer Android does not consume `new_broadcast` events (those are transporter-targeted). No customer-facing payload is affected by Fix #23.

---

## Section 2 — Fix #17: Cross-pod room replay (Phase 3 step, after 24h+ bake)

### What changed (server-side)

Per `src/shared/services/socket.service.ts` updates landed in HEAD `0baa7955` (commit `fix(timer-replay): Phase 2 — #1 + #36 + NEW#1 + NEW#2 + #21 + #17 SADD + #31`):
- All auto-join `socket.join(...)` sites for `booking:`, `order:`, `trip:`, `transporter:`, `driver:`, `customer:` rooms now also write to a Redis SET `room:members:${room}` with a 24h TTL via `redisService.sAddWithExpire(...)`.
- Disconnect cleanup at `socket.service.ts:752-759` is symmetric — every room family that gets `sAdd` on join gets `sRem` on disconnect.
- Three emit functions (`emitToRoom`, `emitToTransporterDrivers`, `emitToAllTransporters`) gain a cross-pod replay branch gated on `FF_CROSS_POD_ROOM_REPLAY` (default OFF; flipped by operator after a 24h+ bake — see `runbooks/operator-ff-flips.md`).

Industry references: Socket.IO Redis Streams adapter, Discord Gateway Resume protocol (per source-of-truth §1.4).

### Wire-format impact

**None.**

The `room:members:${room}` Redis SET is purely server-internal. No client-visible payload field is added, removed, or changed.

When the FF is flipped after the bake, the only client-observable difference is **higher delivery success during pod restarts / AZ blips** — captains/drivers/customers connected to a pod that doesn't hold the local Socket.IO room will still receive emits via the cross-pod replay path. From the client's perspective, this manifests as "fewer missed broadcasts during deploys", not as a payload change.

The `room:members:*` SET semantics are **purely additive**:
- Adds: `sAddWithExpire(room:members:${room}, 86400, userId)` on every `socket.join`.
- Removes: `sRem(room:members:${room}, userId)` on disconnect, for the same room families.
- Reads: `enumerateCrossPodRoomUserIds(room)` in 2 emit functions; `ONLINE_TRANSPORTERS_SET` sScan in `emitToAllTransporters`.

### Captain Android — what to do

**Nothing required.** No payload change.

The reconnect/replay flow on Captain remains driven by the existing `recover-state` / heartbeat / timeout-restore logic (§7.7, §7.8 of CLAUDE.md). Cross-pod replay is invisible to the client — the server delivers a `new_broadcast`, `broadcast_state_changed`, or other lifecycle event the same way it always did, the only difference is which pod holds the durable destination map.

### Customer Android — what to do

**Nothing required.** No payload change.

Customer Android benefits from cross-pod replay for `customer:`, `order:`, `booking:`, `trip:` room emits — same delivery guarantee, no protocol or schema change.

---

## Section 3 — NEW#3: FCM phantom-key surgery (Juniper)

### What changed (server-side)

Per source-of-truth §5.3 (`/Users/nitishbhardwaj/Downloads/index-20-validated.md:2487-2607`):
- The live inline FCM batch consumer at `src/shared/services/queue.service.ts:1392-1465` previously wrote `DEL fcm_token:${token}` on FCM dead-token responses. The `fcm_token:${token}` key was a **phantom** — it had zero producers in the codebase. The DELs were silent no-ops; dead tokens were never actually removed.
- The canonical FCM token storage is `fcm:tokens:${userId}` as a Redis SET, defined at `src/shared/services/fcm.service.ts:132` (`FCM_TOKEN_KEY = (userId) => 'fcm:tokens:' + userId`), used at `:521`, `:666`, `:693`, `:723`.
- Phase 3 surgery: producer `queueBatchPush` at `queue.service.ts:2039-2077` widens its payload from `{tokens: string[]}` to `{recipients: Array<{userId, token}>}`. Consumer at `queue.service.ts:1392-1465` calls `fcmService.removeToken(userId, token)` (which performs `SREM fcm:tokens:${userId} ${token}`) on FCM dead-token codes (`messaging/registration-token-not-registered`, `messaging/invalid-registration-token`).
- Sequential deploy: consumer-supports-both-shapes lands first, drains in-flight legacy `{tokens: string[]}` jobs, then producer flips to `{recipients}`.

### Wire-format impact

**None — server-internal Redis key shape only.**

There is **no** client-facing payload, Socket.IO event, FCM notification format, or HTTP API change. The change is entirely:
- Internal Redis key (`fcm_token:${token}` → `fcm:tokens:${userId}` as SET).
- Internal Bull job payload shape (`{tokens}` → `{recipients}`) — never crosses the network to a client.

The push notifications themselves (FCM `notification.title`, `notification.body`, `notification.data`) are unchanged in shape and content.

### Captain Android — what to do

**Nothing required.** Push notification format unchanged.

Observable difference at runtime: **dead/uninstalled-app tokens will now actually be removed from `fcm:tokens:${userId}`** when FCM responds with a dead-token code. Drivers/captains who reinstall the app or who change devices will no longer accumulate stale tokens that produce duplicate or doomed FCM sends. This translates to slightly faster delivery of true notifications and lower FCM error rates — invisible to client code, observable only as "the right notifications get delivered, the wrong ones stop being attempted."

### Customer Android — what to do

**Nothing required.** Same logic applies — push notification format unchanged; only the server-side token-set hygiene improves.

---

## Section 4 — Action items

### Captain Android team

| Item | Action | Reason |
|---|---|---|
| **Phase 3 code review** | None. | All Phase 3 fixes are server-side correctness work with no wire-format change. |
| **Regression watch** | After Phase 3 deploys to production, monitor the broadcast-list screen for any unexpected behavior. | Fix #23 reduces (does not eliminate) the rate of `new_broadcast` events for transporters in a given progressive step. The expected user-visible change is "no more 0 km · 0 min rows" — anything else (e.g. broadcast count drop > expected) should be flagged. |
| **Cross-pod replay flip** | None at flip time. After operator flips `FF_CROSS_POD_ROOM_REPLAY=true` (24h+ post-deploy), monitor reconnect/replay success rate from the client side. | The flip is server-side only. If reconnect-after-pod-restart success rate does **not** improve as expected, escalate to backend team — but no client code change is part of the rollout. |

### Customer Android team

| Item | Action | Reason |
|---|---|---|
| **Phase 3 code review** | None. | Customer Android does not consume `new_broadcast` events. Fix #23 is transporter-targeted. Fix #17 cross-pod replay is server-internal. NEW#3 FCM key shape is server-internal. |
| **Regression watch** | None specific to Phase 3. | Continue normal release-quality monitoring. |

### Both teams — Fix #13 (Kismet, dead-code deletion)

Per source-of-truth §2.2.1 and Kismet's task #4: the deleted symbols (e.g. `BroadcastService.acceptBroadcast` method) had **zero callers** outside test files. No client API was wired to these symbols. **No client-side change required.**

---

## Appendix — Source-of-truth citations

| Topic | Source-of-truth section | File:line in repo |
|---|---|---|
| Fix #23 (skip emit, primary) | §1.7 lines 816-913 of `index-20-validated.md` | `src/modules/order/order-broadcast.service.ts:997-1004` (guard), `:1028` (emit) |
| Fix #23 (skip emit, mirror) | §1.7 mirror call-out lines 893-908 of `index-20-validated.md` | `src/modules/order/order-broadcast-send.service.ts:676-683` (guard), `:700` (emit) |
| Fix #17 (cross-pod replay SADD + emit branches) | §1.4 lines 514-651 of `index-20-validated.md` | `src/shared/services/socket.service.ts` SADD/sRem + 3 emit functions |
| Fix #17 operator flip plan | §1.4 Pillar 4 (bake plan) of `index-20-validated.md` | `runbooks/operator-ff-flips.md` |
| NEW#3 (FCM phantom-key) | §5.3 lines 2487-2607 of `index-20-validated.md` | `src/shared/services/queue.service.ts:1392-1465` (consumer), `:2039-2077` (producer); `src/shared/services/fcm.service.ts:132` (canonical key) |
| Fix #13 (dead-code delete) | §2.2.1 lines 1882-1929+ of `index-20-validated.md` | various (`broadcast.service.ts` etc.; see Kismet's PR) |

---

## Change log

| Date | Author | Change |
|---|---|---|
| 2026-05-09 | Gale (cutover-cleanup team) | Initial authoring after Halo confirmed Fix #23 wire-format does not change (only delivery-rate). |
