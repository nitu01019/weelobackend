// scripts/audit-stale-flags.ts — weekly stale-flag audit
// Imports FLAGS directly from feature-flags.ts (single source of truth, no JSON drift).
// Slack-only notification per Indira R4-A SHIP-REDUCED — no auto-PR (92-flag-scale noise risk).
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { FLAGS } from '../src/shared/config/feature-flags';

interface StaleEntry {
  name: string;
  env: string;
  sunsetAt: string;
  callsites: number;
  owner: string;
}

// Pandora R6-C #28 (Set VALIDATED 2026-05-12): grep BOTH env string AND `FLAGS.${key}`.
// Env-only grep undercounts because canonical caller pattern is `isEnabled(FLAGS.X)`,
// e.g. DURABLE_EMIT_ENABLED env-grep=0 production hits vs combined=8 at
// socket.service.ts:2318/2368/2394/2470/2512/2541/2566/2594.
function callsiteCount(envName: string, flagKey: string): number {
  try {
    const grep = execSync(
      `grep -rln -e "${envName}" -e "FLAGS\\.${flagKey}" src/ 2>/dev/null | wc -l`,
      { encoding: 'utf8' }
    ).trim();
    return parseInt(grep, 10) || 0;
  } catch {
    return 0;
  }
}

function main(): void {
  const now = new Date();
  const stale: StaleEntry[] = [];
  const missing: string[] = [];

  for (const [name, def] of Object.entries(FLAGS) as [string, any][]) {
    if (!def.meta) {
      missing.push(`${name} (env=${def.env})`);
      continue;
    }
    const sunset = new Date(def.meta.sunsetAt);
    if (Number.isNaN(sunset.getTime())) {
      console.error(`INVALID sunsetAt for ${name}: ${def.meta.sunsetAt}`);
      process.exitCode = 1;
      continue;
    }
    if (sunset < now) {
      stale.push({
        name,
        env: def.env,
        sunsetAt: def.meta.sunsetAt,
        callsites: callsiteCount(def.env, name),
        owner: def.meta.owner,
      });
    }
  }

  const report = {
    runAt: now.toISOString(),
    stale,
    missingMetadata: missing,
    summary: `${stale.length} stale, ${missing.length} missing-meta out of ${Object.keys(FLAGS).length}`,
  };
  fs.writeFileSync(
    path.join(__dirname, '..', 'stale-flags-report.json'),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify(report, null, 2));

  const webhook = process.env.SLACK_FLAG_AUDIT_WEBHOOK;
  if (webhook && (stale.length > 0 || missing.length > 0)) {
    const body = {
      text: `Weelo stale-flag audit: ${stale.length} past sunset, ${missing.length} missing metadata.`,
      attachments: [{
        color: stale.length > 0 ? 'danger' : 'warning',
        fields: stale.slice(0, 10).map((s) => ({
          title: s.name,
          value: `Sunset: ${s.sunsetAt} · Owner: ${s.owner} · ${s.callsites} callsites`,
          short: false,
        })),
      }],
    };
    execSync(
      `curl -fsS -X POST -H 'Content-Type: application/json' -d '${JSON.stringify(body).replace(/'/g, "'\\''")}' '${webhook}' || true`
    );
  }
}

main();
