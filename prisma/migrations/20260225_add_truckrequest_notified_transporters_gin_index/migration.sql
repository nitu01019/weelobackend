-- Fast transporter feed membership lookup:
-- WHERE status='searching' AND notifiedTransporters @> ARRAY[transporterId]
CREATE INDEX IF NOT EXISTS "TruckRequest_notifiedTransporters_gin_idx"
ON "TruckRequest"
USING GIN ("notifiedTransporters");
