# FIXES_APPLIED

Append-only log of landed critical-fix commits for review-2026-04-21.

Format: `| Finding | Task | Commit | Owner | Summary |`

| Finding | Task | Commit | Owner | Summary |
|---------|------|--------|-------|---------|
| A03-003 | W3-T01 | 9be33c0b | clock-anchor-owner | withSocketMeta + durableEmit carry serverNowMs + optional deadlineMs (backward-compat additive) |
| A03-003 | W3-T02 | abf34cd8 | clock-anchor-owner | flex-hold emit sites (flex_hold_started:380 + flex_hold_extended:603) pass deadlineMs |
| A03-003 | W3-T03 | 3d712c59 | clock-anchor-owner | reassign-driver + cascade-dispatch trip_assigned socket emits pass deadlineMs |
| A03-003 | W3-T04 | 13e1da5c | clock-anchor-owner | confirmed-hold per-driver trip_assigned socket emit passes deadlineMs (pre-computed anchor reused by expiresAtIso) |
