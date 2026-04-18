# Metrics Naming Convention — V1 (P1 baseline)

**Owner:** T1.6 (`t1-6-metrics-infra`)
**Scope:** all Prometheus metrics in `src/shared/monitoring/metrics.service.ts` + `metrics-definitions.ts`.
**Status:** ratified for P1; P2+ appends under new labeled blocks.
**Last updated:** 2026-04-19 (rebased onto `main-new`)

## 1. Naming grammar

| Type | Pattern | Example |
|---|---|---|
| Counter | `<subsystem>_<object>_<verb>_total` | `eta_ranking_fallback_total` |
| Gauge | `<subsystem>_<object>_<unit>` | `broadcast_queue_depth` |
| Histogram | `<subsystem>_<object>_<unit>` | `http_request_duration_ms` |

1. Snake_case only. No dots in new names (legacy dots stay).
2. Counters end in `_total`.
3. Gauges/histograms carry a unit suffix: `_ms`, `_bytes`, `_seconds`, `_count`, `_depth`.
4. Subsystem prefix: `hold_*`, `broadcast_*`, `tracking_*`, `fleet_cache_*`, `cancel_*`, `eta_*`, `socket_*`, `fcm_*`, `server_boot_*`.
5. No vendor names unless intrinsic.

## 2. Label cardinality

- <= 3 labels per counter.
- Values from a bounded enum only (e.g. `reason`, `cache`, `channel`, `priority`, `event`, `mode`, `stage`, `source`, `status`).
- Document the enum in the registration comment.
- Never: raw ids, free-text errors, unnormalized paths, timestamps.

## 3. Registration flow

```
1. Add to metrics-definitions.ts inside YOUR labeled block (section 4).
2. Emit: metrics.incrementCounter(name, {label: value}).
3. Add a registration test (src/__tests__/p1-t1-6-process-metrics.test.ts pattern).
```

Auto-create is hygiene-grade only; emits `logger.warn` on first unregistered use.

## 4. Reserved-block template (Phase-2+ copy this)

Append at the END of the relevant `register*` function. Keep the trailing comma on the last real entry; block markers are comments only.

```ts
    // Existing last counter entry (keeps its trailing comma):
    counter('fcm_push_priority_total', '...'),

    // === P<n>-<ticket> (<your-slug>) ===
    // <1-2 line plain-English explanation>
    //   Labels:
    //     <name> = '<v1>' | '<v2>'   (bounded enum)
    //   Call site: <file>:<line-range>
    counter(
      '<subsystem>_<object>_<verb>_total',
      '<Prometheus # HELP description>'
    ),
```

Section header: `// === P<phase>-<ticket> (<teammate-slug>) ===`
Example: `// === P2-C1 (t2-1-cancellation) ===`.

Never edit another teammate's block. Renames/deprecations use a 2-phase sunset.

## 5. Section map + P1 counter manifest

| Section | Owner |
|---|---|
| core HTTP / DB / cache | platform |
| load testing | platform |
| tracking stream | telemetry |
| broadcast queue guard | dispatch |
| cancellation | order lifecycle |
| truck hold | hold |
| phase-6 dispatch pipeline | Phase 6 |
| reconciliation (legacy dotted) | ops |
| F-A-70/85/86, W0-4 | misc |
| P1-L3 | T1.1 |
| P1-L7 | T1.1 |
| P1-L2 | T1.2 |
| P1-M18 | T1.2 |
| P1-L1 | T1.3 |
| P1-SC8 | T1.5 |
| P1 process metrics | T1.6 |

### P1 counter manifest (for T1.7 dashboard wiring)

| Ticket | Owner | Metric | Type | Labels | Call site |
|---|---|---|---|---|---|
| L3 | T1.1 | `eta_ranking_fallback_total` | counter | `reason` | `progressive-radius-matcher.ts:213-217` |
| L7 | T1.1 | `fleet_cache_corruption_total` | counter | (none) | `fleet-cache.service.ts` (6+ sites) |
| L2 | T1.2 | `post_commit_cache_failure_total` | counter | `cache` | `order.service.ts` (2 catch branches) |
| M18 | T1.2 | `socket_emit_while_adapter_down_total` | counter | `event`, `mode` | `socket.service.ts` (emitToUser) |
| L1 | T1.3 | `booking_legacy_fallback_total` (opt) | counter | `status` | `BookingApiRepository.kt` mirror |
| SC8 | T1.5 | `server_boot_scan_ms` | histogram | (none) | `src/server.ts` Redis scan timer |
| T1.6 | T1.6 | `phase1_landed_commit_sha` | gauge | (none) | deploy script |

### Audit checklist (T1.6 owns)

- [x] Counters end in `_total`; gauges/histograms have a unit suffix.
- [x] snake_case everywhere.
- [x] Labels <= 3, values from bounded enums.
- [x] Each counter registered in `registerDefaultCounters()`.
- [x] No name collision.

Open audit note: M18 `event` label ≈ 20 events × 4 modes = 80 series. Bounded via socket event-constants. Flag: gate raw inbound strings through allow-list.

## 6. P2+ guidance (quick card)

1. Fresh header: `// === P<n>-<ticket> (<slug>) ===`.
2. Append at END of the relevant `register*` function.
3. Add a registration test.
4. Cross-link in a phase-analog manifest under `.planning/verification/`.
5. Ping phase's metrics lead for audit before merge.
6. Never rename/delete existing counters. 2-phase sunset for deprecations.

## 7. Anti-patterns

| Anti-pattern | Example | Fix |
|---|---|---|
| Dots in names | `reconciliation.orphaned_records_total` | Underscore in new code. |
| Label by raw id | `hold_release_total{orderId: ...}` | Move id to logs; count by `reason`/`stage`. |
| Counter without `_total` | `broadcast_candidates_found` | New counters MUST include `_total`. |
| Auto-create in hot path | `metrics.incrementCounter('new_thing')` | Register first. |
| Free-text error label | `db_error_total{error: err.message}` | Map to bounded `reason` enum. |
| Unnormalized path label | `http_request_total{path: req.url}` | Use `getRoutePath`. |

---

Questions: SendMessage `t1-6-metrics-infra` (or the phase's metrics lead).
