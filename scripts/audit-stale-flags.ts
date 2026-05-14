// scripts/audit-stale-flags.ts — weekly stale-flag audit
// Imports FLAGS directly from feature-flags.ts (single source of truth, no JSON drift).
// Slack-only notification per Indira R4-A SHIP-REDUCED — no auto-PR (92-flag-scale noise risk).
import * as fs from 'fs';
import * as path from 'path';
import { FLAGS } from '../src/shared/config/feature-flags';

interface StaleEntry {
  name: string;
  env: string;
  sunsetAt: string;
  callsites: number;
  owner: string;
}

// Pandora R6-C #28 (Set VALIDATED 2026-05-12): scan src/ for BOTH env string AND `FLAGS.${key}`.
// Env-only scan undercounts because canonical caller pattern is `isEnabled(FLAGS.X)`,
// e.g. DURABLE_EMIT_ENABLED env-only=0 production hits vs combined=8 at
// socket.service.ts:2318/2368/2394/2470/2512/2541/2566/2594.
// Implementation: pure-Node directory walk. Replaces a prior `grep | wc -l` shell-out
// (Semgrep child_process taint via envName/flagKey args). Stack-based to avoid the
// taint-via-recursive-arg pattern on path.join.
function callsiteCount(envName: string, flagKey: string): number {
  const flagPattern = `FLAGS.${flagKey}`;
  let count = 0;
  const stack: string[] = ['src'];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf8');
        } catch {
          continue;
        }
        if (content.includes(envName) || content.includes(flagPattern)) {
          count++;
        }
      }
    }
  }
  return count;
}

async function main(): Promise<void> {
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
    // Native fetch (Node 18+). Webhook failure is non-fatal — preserves the prior `|| true` semantics.
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      // ignore — webhook delivery is best-effort; audit data is still written to the report file
    });
  }
}

main().catch((err) => {
  console.error('audit-stale-flags failed:', err);
  process.exitCode = 1;
});
