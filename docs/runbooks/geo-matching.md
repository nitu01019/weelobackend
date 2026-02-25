# Geo Matching Runtime Behavior (Authoritative)

## Source of Truth
- Runtime candidate matching uses Redis GEO indices via `GEORADIUS`/`geoRadius`.
- Geohash helpers in `availability.service.ts` are utility helpers and are not the primary online matching path.

## Matching Sources
- `matching.source=redis_geo`: normal hot path (expected in production).
- `matching.source=fallback_db`: Redis geo path unavailable/throttled and DB fallback engaged.

## Troubleshooting Checklist
1. Verify heartbeat freshness for affected transporter IDs.
2. Verify Redis detail hash TTL has not expired unexpectedly.
3. Verify Redis GEO member still exists for the transporter and vehicle key.
4. Check `GEO_FALLBACK_MIN_INTERVAL_MS` and `GEO_FALLBACK_MAX_CANDIDATES` tuning.
5. Confirm progressive radius expansion timers are advancing per configured step windows.

## Operational Expectations
- If heartbeat updates are healthy and Redis is available, `matching.source=redis_geo` should dominate.
- Sustained `fallback_db` indicates Redis/indexing health or heartbeat pipeline issues.
