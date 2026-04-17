#!/usr/bin/env node
/**
 * F-C-52 + F-C-78 codegen
 *
 * Reads events.asyncapi.yaml and schemas/enums.proto (source of truth) and
 * regenerates:
 *   - events.generated.ts   (SocketEvent const + SocketEventName union type)
 *   - enums.generated.ts    (HoldPhase/VehicleStatus/BookingStatus/AssignmentStatus
 *                            with fromBackendString companions)
 *
 * Zero runtime deps (no yaml/proto parsers pulled in). The parsers here are
 * deliberately minimal — they match the stylized grammar of the source files
 * in this repo. If you extend the source grammar, extend the parsers.
 *
 * Usage:   node packages/contracts/codegen.mjs
 * CI:      npm run contracts:verify (invokes verify.mjs; regen drift fails)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// AsyncAPI events parser — extracts `address: <name>` from `channels:` block,
// plus `x-event-aliases` for legacy TS member names that map to an existing wire value.
// ---------------------------------------------------------------------------
function parseEventAddresses(yamlText) {
  const lines = yamlText.split('\n');
  let inChannels = false;
  let inAliases = false;
  const addresses = [];
  const aliases = []; // { memberName, wireValue }
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^channels:\s*$/.test(line)) {
      inChannels = true;
      inAliases = false;
      continue;
    }
    if (/^x-event-aliases:\s*$/.test(line)) {
      inAliases = true;
      inChannels = false;
      continue;
    }
    if (/^\S/.test(line) && !/^\s/.test(line) && !/^#/.test(line)) {
      // Left-margin key starts a new top-level block → leave current block.
      inChannels = false;
      inAliases = false;
    }
    if (inChannels) {
      const m = line.match(/^\s+address:\s*([a-z0-9_]+)\s*$/);
      if (m) addresses.push(m[1]);
    } else if (inAliases) {
      const m = line.match(/^\s+([A-Z][A-Z0-9_]*):\s*([a-z0-9_]+)\s*$/);
      if (m) aliases.push({ memberName: m[1], wireValue: m[2] });
    }
  }
  // De-dup while preserving order (yaml is authoritative on ordering).
  return { addresses: [...new Set(addresses)], aliases };
}

// ---------------------------------------------------------------------------
// Protobuf enum parser — extracts each `enum <Name> { ... }` body
// ---------------------------------------------------------------------------
function parseProtoEnums(protoText) {
  const enums = [];
  const re = /enum\s+(\w+)\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(protoText)) !== null) {
    const name = m[1];
    const body = m[2];
    const members = [];
    for (const rawLine of body.split('\n')) {
      // Strip trailing comments
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      const mm = line.match(/^([A-Z0-9_]+)\s*=\s*(\d+)\s*;/);
      if (!mm) continue;
      members.push({ protoName: mm[1], ordinal: Number(mm[2]) });
    }
    enums.push({ name, members });
  }
  return enums;
}

// ---------------------------------------------------------------------------
// Wire-value conventions per enum
// ---------------------------------------------------------------------------
// HoldPhase wire values are UPPERCASE (prisma/schema.prisma:118-123).
// VehicleStatus/BookingStatus/AssignmentStatus wire values are lowercase.
const UPPERCASE_ENUMS = new Set(['HoldPhase']);

/**
 * Proto constant (e.g. `HOLD_PHASE_FLEX`, `VEHICLE_STATUS_AVAILABLE`) →
 * wire value exactly as Prisma writes it.
 */
function protoToWire(enumName, protoName) {
  // Strip the `<ENUM_NAME_UPPER>_` prefix.
  const prefix = enumName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() + '_';
  let suffix = protoName.startsWith(prefix) ? protoName.slice(prefix.length) : protoName;
  if (suffix === 'UNKNOWN') return 'UNKNOWN';
  return UPPERCASE_ENUMS.has(enumName) ? suffix : suffix.toLowerCase();
}

/** Proto constant → TS member name (TitleCase variant kept as-is for callers). */
function protoToMember(enumName, protoName) {
  const prefix = enumName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() + '_';
  return protoName.startsWith(prefix) ? protoName.slice(prefix.length) : protoName;
}

// ---------------------------------------------------------------------------
// TS emitters
// ---------------------------------------------------------------------------
const GENERATED_HEADER = `/**
 * ⚠ AUTO-GENERATED — do not edit.
 *
 * Source of truth: packages/contracts/events.asyncapi.yaml,
 * packages/contracts/schemas/enums.proto.
 *
 * Regenerate via: \`node packages/contracts/codegen.mjs\`.
 * Governed by F-C-52 (events) and F-C-78 (enums) — see .planning/phase4/INDEX.md.
 */
`;

function tsMemberNameFromAddress(address) {
  return address.toUpperCase();
}

function emitEventsModule(addresses, aliases) {
  // Preserve legacy SocketEvent member names expected by existing call sites:
  // e.g. `FLEX_HOLD_STARTED`, `JOIN_TRANSPORTER`. Because addresses are already
  // lower_snake_case and callers reference UPPER_SNAKE_CASE, a simple .toUpperCase()
  // round-trips the whole surface — verified against socket.service.ts:137-237.
  const lines = [];
  lines.push(GENERATED_HEADER);
  lines.push(`// Canonical registry of ${addresses.length} socket event names + ${aliases.length} legacy alias(es).`);
  lines.push('// Legacy hand-rolled map in socket.service.ts:137-237 now re-exports from here.');
  lines.push('');
  lines.push('export const SocketEvent = {');
  for (const addr of addresses) {
    lines.push(`  ${tsMemberNameFromAddress(addr)}: '${addr}',`);
  }
  if (aliases.length) {
    lines.push('  // ----- Legacy aliases (same wire value, additional TS member) -----');
    for (const a of aliases) {
      lines.push(`  ${a.memberName}: '${a.wireValue}',`);
    }
  }
  lines.push('} as const;');
  lines.push('');
  lines.push('export type SocketEventName = typeof SocketEvent[keyof typeof SocketEvent];');
  lines.push('');
  lines.push('// De-duplicated set of wire values (aliases collapse to their target).');
  lines.push('export const ALL_SOCKET_EVENTS: readonly SocketEventName[] = Object.freeze(');
  lines.push('  Array.from(new Set(Object.values(SocketEvent))) as SocketEventName[]');
  lines.push(');');
  lines.push('');
  return lines.join('\n');
}

function emitEnumsModule(enums) {
  const lines = [];
  lines.push(GENERATED_HEADER);
  lines.push('// Canonical enum registry — mirrors prisma/schema.prisma exactly.');
  lines.push('// Use the `*.fromBackendString(raw)` companions when decoding wire data:');
  lines.push("// returns 'UNKNOWN' on schema drift so consumers can log + alert without throwing.");
  lines.push('');

  for (const e of enums) {
    const memberLines = [];
    const valueLines = [];
    for (const m of e.members) {
      const member = protoToMember(e.name, m.protoName);
      const wire = protoToWire(e.name, m.protoName);
      memberLines.push(`  ${member}: '${wire}',`);
      if (wire !== 'UNKNOWN') valueLines.push(`'${wire}'`);
    }

    lines.push(`export const ${e.name} = {`);
    lines.push(...memberLines);
    lines.push('} as const;');
    lines.push(`export type ${e.name} = typeof ${e.name}[keyof typeof ${e.name}];`);
    lines.push('');
    lines.push(`const ${e.name}_VALUES: ReadonlySet<string> = new Set([${valueLines.join(', ')}]);`);
    lines.push('');
    lines.push(`/**`);
    lines.push(` * Decode a backend-origin wire string into a canonical ${e.name} value.`);
    lines.push(` * Returns 'UNKNOWN' on drift so the caller can log + alert without throwing.`);
    lines.push(` */`);
    lines.push(`export function ${e.name}_fromBackendString(raw: string | null | undefined): ${e.name} {`);
    lines.push(`  if (raw != null && ${e.name}_VALUES.has(raw)) return raw as ${e.name};`);
    lines.push(`  return ${e.name}.UNKNOWN;`);
    lines.push('}');
    lines.push('');
  }

  // Shared helper alias so callers can use a single import name.
  lines.push('/**');
  lines.push(' * Convenience namespace grouping every enum\'s `fromBackendString` companion.');
  lines.push(' * Usage: `fromBackendString.HoldPhase(raw)`.');
  lines.push(' */');
  lines.push('export const fromBackendString = {');
  for (const e of enums) {
    lines.push(`  ${e.name}: ${e.name}_fromBackendString,`);
  }
  lines.push('} as const;');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const yamlPath = join(__dirname, 'events.asyncapi.yaml');
  const protoPath = join(__dirname, 'schemas', 'enums.proto');
  const eventsOut = join(__dirname, 'events.generated.ts');
  const enumsOut = join(__dirname, 'enums.generated.ts');

  const { addresses, aliases } = parseEventAddresses(readFileSync(yamlPath, 'utf8'));
  if (addresses.length < 40) {
    throw new Error(
      `[contracts/codegen] parsed only ${addresses.length} addresses from events.asyncapi.yaml — expected ≥40. Grammar drift?`
    );
  }
  // Validate aliases only reference existing wire values.
  const addressSet = new Set(addresses);
  for (const a of aliases) {
    if (!addressSet.has(a.wireValue)) {
      throw new Error(
        `[contracts/codegen] alias '${a.memberName}' → '${a.wireValue}' references unknown wire value. Declare the channel first.`
      );
    }
  }

  const enums = parseProtoEnums(readFileSync(protoPath, 'utf8'));
  const expectedEnums = ['HoldPhase', 'VehicleStatus', 'BookingStatus', 'AssignmentStatus'];
  const missing = expectedEnums.filter((n) => !enums.find((e) => e.name === n));
  if (missing.length) {
    throw new Error(`[contracts/codegen] missing enums in proto: ${missing.join(', ')}`);
  }

  writeFileSync(eventsOut, emitEventsModule(addresses, aliases), 'utf8');
  writeFileSync(enumsOut, emitEnumsModule(enums), 'utf8');

  process.stdout.write(
    `[contracts/codegen] wrote ${addresses.length} events + ${aliases.length} alias(es) + ${enums.length} enums\n`
  );
}

main();
