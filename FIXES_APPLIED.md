# FIXES_APPLIED — Wave 1 (critical broadcast reliability 2026-04-21)

Rolling ledger of fix-finding pairs landed on branch `fix/critical-broadcast-reliability-2026-04-21`.
One row per finding × hunk. Owners append as they land.

| Finding | Hunk | Owner | Commit | File(s) | Verified |
|---------|------|-------|--------|---------|----------|
| A10-005 | confirmed-hold accept + decline tx → withDbTimeout | hot-path-tx-owner | 560c221a | src/modules/truck-hold/confirmed-hold.service.ts | grep: 0 bare $transaction, 2 site labels; tsc clean |
| A10-005 | transitionToConfirmed tx → withDbTimeout (Serializable, 8s, maxWait 5s) | hot-path-tx-owner | 229cc49a | src/modules/truck-hold/flex-hold.service.ts | grep: 0 bare $transaction, site 'flex_transition_to_confirmed'; tsc clean |
| A02-001 | transitionToConfirmed FOR UPDATE + guardedConfirmFlexToConfirmed CAS (double-confirm race fix) | hot-path-tx-owner | 229cc49a | src/modules/truck-hold/flex-hold.service.ts | grep: ≥1 FOR UPDATE, ≥1 guardedConfirmFlexToConfirmed; tsc clean |
| A03-005 | trip_assigned socket + driverNotification include farePerTruck via truckRequest.pricePerTruck select | socket-key-owner | 58459176 | src/modules/truck-hold/confirmed-hold.service.ts | grep: 4 pricePerTruck/farePerTruck hits (select, tx-type, destructure, payload); tsc clean |
| A13-013 | trip_assigned socket payload exposes pickup/drop lat+lng aliases (socketPickup / socketDrop) | socket-key-owner | 7990ea77 | src/modules/truck-hold/confirmed-hold.service.ts | grep: socketPickup/socketDrop used in driverNotification; FCM block untouched (latitude??lat preserved); tsc clean |
