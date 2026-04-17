# Phase 3 End-to-End Smoke Harness — Runbook (W0-5)

**Script:** `scripts/phase3-smoke-harness.ts`
**When to run:** After W0-1 (FCM priority fix) **AND** W0-2 (SQL migrations) have landed on staging.
**Where to run:** Ops laptop / CI job pointed at staging — **NEVER prod**.
**Who runs it:** Release engineer during a staging deploy validation window.

---

## 1. What this smokes

Three assertions that collectively prove Phase 3 broadcast + FCM + dedup wiring is healthy:

| # | Assertion                               | Pass condition                                                                 |
|---|-----------------------------------------|---------------------------------------------------------------------------------|
| 1 | Socket `new_broadcast` event received   | Authenticated driver socket receives the event with matching `orderId` + `eventId`. |
| 2 | FCM envelope carries `priority:'high'`  | Captured FCM record (or CloudWatch log line) shows `android.priority === 'high'` AND top-level `priority === 'high'` (W0-1 regression guard). |
| 3 | Cross-channel dedup contract            | Socket payload + FCM payload share the **same `eventId`** and arrive within `DEDUP_WINDOW_MS`. This is what the captain-app F-C-02 coordinator keys on. |

The script will NOT run against a URL whose host matches the production denylist (`api.weelo.in`, etc.) — if you see `Refusing to run`, your `STAGING_URL` is wrong.

---

## 2. Prerequisites

### 2.1 One-time setup on the operator machine

```bash
# Node 18+ required (native fetch + global crypto)
node --version   # -> v18.x.x or newer

# From the repo root — install socket.io-client WITHOUT saving to package.json.
# (It's a smoke-only dep; we do NOT ship it to prod.)
npm i --no-save socket.io-client@^4.7.2

# Confirm ts-node is available (it is, via devDependencies -> ts-node-dev,
# which transitively installs ts-node). If not, install without saving:
npx --no-install ts-node --version || npm i --no-save ts-node
```

### 2.2 Staging fixtures

You need a dedicated staging transporter + driver + vehicle provisioned for smoke:

- The transporter's KYC is **VERIFIED** (F-B-75 broadcast filter).
- The driver is registered under that transporter, online, and has an FCM token.
- The vehicle is `status = 'available'` under that transporter.

Ask the staging seed job (or run `scripts/load/seed.ts` in STAGING only) to provision these if missing. Record the IDs in your shell.

### 2.3 FCM capture endpoint (HIGHLY RECOMMENDED)

To verify `android.priority === 'high'`, the staging deploy must route outbound FCM payloads to a capture endpoint. Two supported shapes:

**Option A — FCM sink service (preferred).**
Operate a small staging-only receiver (e.g. Lambda + DynamoDB) that the backend posts to alongside (or instead of) Firebase. Point `FCM_CAPTURE_URL` at its `GET /captures` endpoint. Contract:

```
GET $FCM_CAPTURE_URL?since=<epochMs>&runId=<smokeRunId>
→ 200
  { "records": [
      { "userId": "<driver-uuid>",
        "eventId": "<uuid from broadcast>",
        "type": "new_broadcast",
        "priority": "high",
        "android": { "priority": "high" },
        "capturedAt": 1713350000000,
        "data": { "orderId": "<...>" } }
    ] }
```

**Option B — CloudWatch log scrape (fallback).**
If the sink is not deployed, set `CLOUDWATCH_TAIL_ENABLED=true` and start a side-by-side CloudWatch tail (example in section 5.2). In this mode assertion #2 degrades to a manual eyeball — the script will report `FCM_CAPTURE_URL not set — cannot observe android.priority` and assertion #2 will FAIL unless you also configure `FCM_CAPTURE_URL`. See "Known limitations" below.

---

## 3. Environment variables

| Var                            | Required | Example                                          | Notes                                                                                         |
|--------------------------------|----------|--------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `STAGING_URL`                  | yes      | `https://staging.weelo-backend.internal`         | Base URL of staging API. Host is checked against the prod denylist.                           |
| `CUSTOMER_TOKEN`               | yes      | `eyJhbGciOi...`                                  | JWT for the staging customer account that will POST the order.                                |
| `TRANSPORTER_TOKEN`            | yes      | `eyJhbGciOi...`                                  | JWT for the staging transporter the vehicle belongs to.                                        |
| `DRIVER_TOKEN`                 | yes      | `eyJhbGciOi...`                                  | JWT for the staging driver whose socket we attach to.                                          |
| `STAGING_TRANSPORTER_ID`       | yes      | `00000000-0000-0000-0000-00000000aaaa`           | UUID of the staging transporter.                                                              |
| `STAGING_DRIVER_ID`            | yes      | `00000000-0000-0000-0000-00000000bbbb`           | UUID of the staging driver (used to filter FCM captures).                                      |
| `STAGING_VEHICLE_ID`           | yes      | `00000000-0000-0000-0000-00000000cccc`           | UUID of the vehicle available for assignment.                                                  |
| `SMOKE_RUN_ID`                 | no       | `smoke-1713350000-abc12345`                      | Auto-generated if omitted. Use a fixed value when replaying for debugging.                     |
| `FCM_CAPTURE_URL`              | no       | `https://smoke-sink.weelo-staging.internal/captures` | Enables assertion #2's positive check. Strongly recommended.                             |
| `CLOUDWATCH_TAIL_ENABLED`      | no       | `true`                                           | Hint flag only — you still need to run `aws logs` in another shell (see 5.2).                 |
| `SOCKET_CONNECT_TIMEOUT_MS`    | no       | `10000`                                          | Socket.IO handshake timeout.                                                                   |
| `SOCKET_EVENT_WAIT_MS`         | no       | `20000`                                          | How long to wait for `new_broadcast` after order creation.                                     |
| `DEDUP_WINDOW_MS`              | no       | `5000`                                           | Max socket↔FCM delta tolerated for dedup assertion.                                            |

---

## 4. Invocation

```bash
# From the repo root
export STAGING_URL=https://staging.weelo-backend.internal
export CUSTOMER_TOKEN=...    # JWT
export TRANSPORTER_TOKEN=... # JWT
export DRIVER_TOKEN=...      # JWT
export STAGING_TRANSPORTER_ID=...
export STAGING_DRIVER_ID=...
export STAGING_VEHICLE_ID=...
export FCM_CAPTURE_URL=https://smoke-sink.weelo-staging.internal/captures

npx ts-node scripts/phase3-smoke-harness.ts
```

Invocation **must** happen from the repo root so `node_modules/` resolution (including the no-save `socket.io-client`) works.

---

## 5. Expected PASS output

Each line is a single-line JSON log record. The tail of a PASSing run looks like:

```json
{"t":"2026-04-17T12:34:56.789Z","level":"info","msg":"Phase 3 smoke harness starting","meta":{"runId":"smoke-1713350000-abc12345","stagingUrl":"https://staging.weelo-backend.internal","driverId":"00000000-0000-0000-0000-00000000bbbb","fcmCaptureEnabled":true}}
{"t":"2026-04-17T12:34:57.123Z","level":"info","msg":"Driver socket connected","meta":{"sid":"Rr9fK..."}}
{"t":"2026-04-17T12:34:58.901Z","level":"info","msg":"Test order created","meta":{"orderId":"...","truckRequestId":"..."}}
{"t":"2026-04-17T12:34:59.234Z","level":"info","msg":"Socket new_broadcast observed","meta":{"orderId":"...","eventId":"..."}}
{"t":"2026-04-17T12:35:04.567Z","level":"info","msg":"FCM captures retrieved","meta":{"count":1}}
{"t":"2026-04-17T12:35:04.600Z","level":"pass","msg":"socket:new_broadcast received","meta":{"detail":"orderId=... eventId=..."}}
{"t":"2026-04-17T12:35:04.601Z","level":"pass","msg":"fcm:android.priority === \"high\"","meta":{"detail":"1 push(es) all carried priority:high"}}
{"t":"2026-04-17T12:35:04.602Z","level":"pass","msg":"cross-channel dedup (socket ↔ FCM)","meta":{"detail":"eventId=... carried on both channels"}}
{"t":"2026-04-17T12:35:05.100Z","level":"info","msg":"Teardown complete","meta":{"orderId":"..."}}
{"t":"2026-04-17T12:35:05.101Z","level":"pass","msg":"Smoke harness finished","meta":{"exitCode":0,"runId":"smoke-1713350000-abc12345"}}
```

**Shell exit code: `0`.**

### 5.1 Piping to `jq` while keeping exit code intact

```bash
# Keep the script's exit code, not jq's.
npx ts-node scripts/phase3-smoke-harness.ts 2>&1 | tee /tmp/smoke.log | jq -Rc 'try fromjson // .'
# The process substitution keeps "$?" as the ts-node child's exit code on bash:
(npx ts-node scripts/phase3-smoke-harness.ts 2>&1 1>&3 3>&- | tee /tmp/smoke.err >&2) 3>&1
echo "exit=$?"
```

### 5.2 Side-car CloudWatch tail (fallback for FCM inspection)

In a separate shell:

```bash
STREAM=$(aws logs describe-log-streams \
  --log-group-name weelobackendtask \
  --order-by LastEventTime --descending --max-items 1 \
  --region ap-south-1 --output json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['logStreams'][0]['logStreamName'])")

aws logs tail weelobackendtask \
  --log-stream-names "$STREAM" \
  --region ap-south-1 \
  --follow \
  --format short \
  --filter-pattern '"android.priority"'
```

You are looking for lines containing `priority:"high"` generated by `fcm.service.ts`. If you see `priority:"normal"` on a driver dispatch, assertion #2 has regressed — W0-1 did not fully land.

---

## 6. Interpreting failures

| Exit code | Meaning                                  | First debugging step                                                                 |
|-----------|------------------------------------------|-------------------------------------------------------------------------------------|
| `0`       | All three assertions passed              | Record the run ID in the Wave 0 review doc and move on.                              |
| `1`       | Setup failure (env / socket / HTTP)      | Check the last `{"level":"error",...}` line; verify tokens, STAGING_URL, fixture IDs. |
| `2`       | **Assertion** failure (the fix is broken)| Read the FAIL lines — each one names the broken contract and prints `detail`.         |
| `3`       | Teardown failed — order may be leaked    | `detail` in the last error line includes `orderId`; cancel manually via admin tool.   |

### 6.1 Specific failure patterns

- **`socket:new_broadcast received` FAIL, `orderId mismatch`** — Server emitted `new_broadcast` for a DIFFERENT order (concurrent traffic). Re-run with a quieter staging window, or narrow the match filter in the script by `SMOKE_RUN_ID` tag.
- **`fcm:android.priority === "high"` FAIL, `FCM_CAPTURE_URL not set`** — You must configure the FCM sink. Without it assertion #2 is structurally unprovable.
- **`fcm:android.priority === "high"` FAIL, `priority != high`** — W0-1 regressed. Check recent commits to `fcm.service.ts` or `queue.service.ts` for a priority-drop. **Do not close Wave 0.** Escalate to W0-1 owner.
- **`cross-channel dedup (socket ↔ FCM)` FAIL, `no FCM record with eventId=...`** — Server-side `order-broadcast-send.service.ts` did not propagate the `eventId` to the FCM payload. Check for a recent change to the FCM builder that stripped `eventId` from `data.*`.
- **`cross-channel dedup (socket ↔ FCM)` FAIL, `delta ... exceeds DEDUP_WINDOW_MS`** — FCM dispatch is lagging socket by more than the window. Bump `DEDUP_WINDOW_MS` only after confirming the latency is acceptable on the product side; otherwise investigate queue backlog.

---

## 7. Teardown

The script cancels the test order automatically via `PATCH /api/v1/orders/{id}/cancel` with `reason: "smoke-teardown"`. If teardown fails (non-2xx or thrown error), the script prints the `orderId` and `runId` in a `{"level":"error"}` line. Operator then:

1. Log into staging admin console.
2. Find the order by `orderId` printed in the log line.
3. Force-cancel via the admin cancel tool.
4. If a TruckHoldLedger row was created, verify it was released (phase flipped to `RELEASED` or `EXPIRED`).
5. Note the leak + manual cleanup in the Wave 0 review doc.

The harness does NOT run SQL against staging. Any DB state touched was created via normal API calls and will be cleaned up by the normal order-cancel path.

---

## 8. Known limitations

1. **FCM priority without capture sink**: The only reliable way to observe `android.priority` is the FCM capture endpoint (Option A). The Firebase Admin SDK does not expose send-side rendering of the outgoing payload from the console. If you run without `FCM_CAPTURE_URL`, assertion #2 will fail loudly with `cannot observe android.priority` — intentional, so ops doesn't silently miss a W0-1 regression.
2. **Not for CI**: This script is **NOT** part of `npm test`. It is gated on staging network access, live fixtures, and a JWT minted for a real driver account. Do not wire it into the `jest` config.
3. **Single-tenant noise window**: If another transporter on staging is posting orders simultaneously, the socket listener may match a neighbor's broadcast. Prefer running in a quiet window or override the match filter by orderId (the script already narrows by orderId once the order is created).
4. **No Android priority delivery proof**: `android.priority:'high'` only requests a high-priority delivery from FCM — the OS can still degrade based on battery optimizer / Doze. This smoke proves the server's intent, not the device's actual wake. Device-side verification belongs in the captain-app instrumented tests (see Phase 3 plan, F-C-01 notes).
5. **socket.io-client lazy-required**: The client lib is loaded via `require()` at runtime. If the operator forgets the `npm i --no-save` step, the script fails with a clear message pointing to the install command.
6. **Does NOT run `psql`**: Per CLAUDE.md rule, no direct DB access. All teardown goes through the public cancel API.

---

## 9. Change control

Any change to the three assertions is a BLOCKING gate on Wave 0 closure. Escalate via the Wave 0 reviewer before editing assertion logic in `scripts/phase3-smoke-harness.ts`.

— Last updated: 2026-04-17 (W0-5 initial)
