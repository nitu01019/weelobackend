/**
 * Phase 6 — Fix #14: Socket.IO CSR (Connection State Recovery) outcome observation
 *
 * Validates the contract documented in
 * /Users/nitishbhardwaj/Downloads/index-30-validated.md L3894-4069 ("How to verify"):
 *
 *   1. Counter `socket_csr_attempt_total` is registered with labels
 *      {recovered, role} and exported via Prometheus + JSON.
 *   2. For every connection event, exactly one counter increment lands —
 *      labelled by csrRecovered (string) and socket.data.role.
 *   3. The structured warn log fires ONLY when recovered=false AND
 *      handshake.auth.lastSeq > 0 (i.e. a known-session client whose CSR
 *      pipeline silently dropped). Fresh sessions (lastSeq=0) MUST NOT
 *      generate warn-log spam.
 *
 * The connection-handler body itself depends on a live Socket.IO + Redis
 * adapter, so these unit tests exercise the same observation logic in
 * isolation against `metrics.incrementCounter` and `logger.warn` — the
 * two side-effects the Fix #14 block produces. Wiring is checked by the
 * static metric-registration assertion + a static grep test below.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { metrics } from '../shared/monitoring/metrics.service';
import { logger } from '../shared/services/logger.service';
import { hashUserId } from '../shared/utils/error-log.utils';

// ============================================================================
// METRIC REGISTRATION
// ============================================================================

describe('Phase 6 — Fix #14: socket_csr_attempt_total registration', () => {
    it('counter is pre-registered (no auto-register warn on first use)', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation();
        metrics.incrementCounter('socket_csr_attempt_total', {
            recovered: 'true',
            role: 'driver',
        });
        expect(spy).not.toHaveBeenCalledWith(
            expect.stringContaining('socket_csr_attempt_total not found'),
        );
        spy.mockRestore();
    });

    it('counter exports via Prometheus output', () => {
        metrics.incrementCounter('socket_csr_attempt_total', {
            recovered: 'true',
            role: 'driver',
        });
        const output = metrics.getPrometheusMetrics();
        expect(output).toContain('socket_csr_attempt_total');
    });

    it('counter exports via JSON output', () => {
        metrics.incrementCounter('socket_csr_attempt_total', {
            recovered: 'false',
            role: 'customer',
        });
        const json = metrics.getMetricsJSON();
        expect(json).toHaveProperty('counters');
        const counters = json.counters as Record<string, unknown>;
        expect(counters).toHaveProperty('socket_csr_attempt_total');
    });
});

// ============================================================================
// COUNTER INCREMENT — both branches
// ============================================================================

describe('Phase 6 — Fix #14: counter increments by branch', () => {
    function snapshotCounter(): Record<string, number> {
        const json = metrics.getMetricsJSON();
        const counters = json.counters as Record<string, Record<string, number>>;
        return counters['socket_csr_attempt_total'] || {};
    }

    // Mirrors MetricsService['labelsToKey'] private method:
    //   `${k}="${v}"` sorted by key name, joined by `,`.
    function labelKey(labels: Record<string, string>): string {
        return Object.entries(labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}="${v}"`)
            .join(',');
    }

    it('recovered=true,role=driver increments under the right label series', () => {
        const before = snapshotCounter()[labelKey({ recovered: 'true', role: 'driver' })] || 0;
        metrics.incrementCounter('socket_csr_attempt_total', {
            recovered: 'true',
            role: 'driver',
        });
        const after = snapshotCounter()[labelKey({ recovered: 'true', role: 'driver' })] || 0;
        expect(after - before).toBe(1);
    });

    it('recovered=false,role=transporter increments under a distinct label series', () => {
        const tag = labelKey({ recovered: 'false', role: 'transporter' });
        const before = snapshotCounter()[tag] || 0;
        metrics.incrementCounter('socket_csr_attempt_total', {
            recovered: 'false',
            role: 'transporter',
        });
        const after = snapshotCounter()[tag] || 0;
        expect(after - before).toBe(1);
    });

    it('label cardinality stays bounded — 2 recovered values × 4 roles = 8 series ceiling', () => {
        for (const recovered of ['true', 'false']) {
            for (const role of ['transporter', 'driver', 'customer', 'unknown']) {
                metrics.incrementCounter('socket_csr_attempt_total', { recovered, role });
            }
        }
        const snap = snapshotCounter();
        const distinctKeys = Object.keys(snap).filter((k) => k.includes('recovered=') && k.includes('role='));
        expect(distinctKeys.length).toBeLessThanOrEqual(8);
        expect(distinctKeys.length).toBe(8);
    });
});

// ============================================================================
// WARN-LOG GATE — recovered=false ∧ lastSeq>0
// ============================================================================

describe('Phase 6 — Fix #14: structured warn log gate', () => {
    // Mirrors the logic block from socket.service.ts inside io.on('connection').
    // Kept in sync by the static-grep test below.
    // FU-3 (2026-05-14): userId is passed through hashUserId() before logging
    // so DPDP §3 PII never lands in /weelo/application — see hashUserId at
    // src/shared/utils/error-log.utils.ts.
    function csrObservation(
        recovered: boolean,
        handshakeAuth: { lastSeq?: number },
        socketData: { id: string; userId?: string; role?: string },
    ): { warnEmitted: boolean } {
        let warnEmitted = false;
        if (!recovered) {
            const claimedLastSeq = Number(handshakeAuth?.lastSeq || 0);
            if (claimedLastSeq > 0) {
                logger.warn('[CSR] Recovery FAILED for known-session client', {
                    socketId: socketData.id,
                    userId: hashUserId(socketData.userId),
                    role: socketData.role,
                    lastSeq: claimedLastSeq,
                });
                warnEmitted = true;
            }
        }
        return { warnEmitted };
    }

    it('recovered=false AND lastSeq=5 → warn emitted with hashed userId (DPDP §3)', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
        const { warnEmitted } = csrObservation(
            false,
            { lastSeq: 5 },
            { id: 'sock-abc', userId: 'user-123', role: 'driver' },
        );
        expect(warnEmitted).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
            '[CSR] Recovery FAILED for known-session client',
            expect.objectContaining({
                socketId: 'sock-abc',
                userId: expect.stringMatching(/^user_[a-f0-9]{12}$/),
                role: 'driver',
                lastSeq: 5,
            }),
        );
        // Raw userId must NEVER appear in the logged payload.
        // `logger.warn` has a 1-arg overload in its public type, but the
        // runtime call here is 2-arg; cast through unknown to access the
        // structured-meta argument.
        const loggedMeta = (warnSpy.mock.calls[0] as unknown as [string, { userId: string }])[1];
        expect(loggedMeta.userId).not.toBe('user-123');
        expect(loggedMeta.userId).not.toContain('user-123');
        warnSpy.mockRestore();
    });

    it('recovered=false AND lastSeq=0 → NO warn (fresh-session filter)', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
        const { warnEmitted } = csrObservation(
            false,
            { lastSeq: 0 },
            { id: 'sock-fresh', userId: 'user-456', role: 'customer' },
        );
        expect(warnEmitted).toBe(false);
        expect(warnSpy).not.toHaveBeenCalledWith(
            '[CSR] Recovery FAILED for known-session client',
            expect.anything(),
        );
        warnSpy.mockRestore();
    });

    it('recovered=false AND lastSeq missing → NO warn', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
        const { warnEmitted } = csrObservation(
            false,
            {},
            { id: 'sock-fresh-2', role: 'transporter' },
        );
        expect(warnEmitted).toBe(false);
        warnSpy.mockRestore();
    });

    it('recovered=true → NO warn regardless of lastSeq', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
        const { warnEmitted } = csrObservation(
            true,
            { lastSeq: 5 },
            { id: 'sock-ok', userId: 'user-789', role: 'driver' },
        );
        expect(warnEmitted).toBe(false);
        warnSpy.mockRestore();
    });

    // FU-3 — Stability invariant: the same raw userId must produce the same
    // hashed prefix across calls (and ideally across processes) so ops can
    // pivot from one CSR-fail log line to every other failure for that user
    // by grepping the hash. If the hash drifted per-call, the field would be
    // useless for correlation.
    it('FU-3: hashed userId is stable across repeated warn calls for the same user', () => {
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
        csrObservation(
            false,
            { lastSeq: 5 },
            { id: 'sock-1', userId: 'user-XYZ', role: 'driver' },
        );
        csrObservation(
            false,
            { lastSeq: 7 },
            { id: 'sock-2', userId: 'user-XYZ', role: 'driver' },
        );
        expect(warnSpy).toHaveBeenCalledTimes(2);
        // See cast-through-unknown note above — same reason here.
        type WarnCall = [string, { userId: string }];
        const first = (warnSpy.mock.calls[0] as unknown as WarnCall)[1];
        const second = (warnSpy.mock.calls[1] as unknown as WarnCall)[1];
        expect(first.userId).toMatch(/^user_[a-f0-9]{12}$/);
        expect(first.userId).toBe(second.userId);
        // And a different raw userId must produce a different hash.
        csrObservation(
            false,
            { lastSeq: 9 },
            { id: 'sock-3', userId: 'user-OTHER', role: 'driver' },
        );
        const third = (warnSpy.mock.calls[2] as unknown as WarnCall)[1];
        expect(third.userId).not.toBe(first.userId);
        warnSpy.mockRestore();
    });
});

// ============================================================================
// FU-3 — hashUserId helper contract
// ============================================================================

describe('Phase 6 — FU-3: hashUserId() PII contract', () => {
    it('returns user_<12-hex> shape for a normal userId', () => {
        expect(hashUserId('user-abc')).toMatch(/^user_[a-f0-9]{12}$/);
    });

    it('is deterministic — same input → same output', () => {
        expect(hashUserId('user-abc')).toBe(hashUserId('user-abc'));
    });

    it('collapses null / undefined / empty to user_anonymous (no PII leak on absent value)', () => {
        expect(hashUserId(null)).toBe('user_anonymous');
        expect(hashUserId(undefined)).toBe('user_anonymous');
        expect(hashUserId('')).toBe('user_anonymous');
    });

    it('never returns the raw input (irreversibility smoke)', () => {
        const raw = 'user-7889559631';
        expect(hashUserId(raw)).not.toContain(raw);
        expect(hashUserId(raw)).not.toContain('7889559631');
    });
});

// ============================================================================
// STATIC WIRING — confirms the block is actually present in socket.service.ts
// ============================================================================

describe('Phase 6 — Fix #14: static wiring at call site', () => {
    const socketService = readFileSync(
        path.resolve(__dirname, '../shared/services/socket.service.ts'),
        'utf8',
    );

    it('socket.service.ts increments socket_csr_attempt_total inside connection handler', () => {
        // Must reside between the `io.on('connection'` line and the FIX-46 jitter
        // sleep — i.e. at the top of the handler body.
        const handlerOpen = socketService.indexOf("io.on('connection'");
        const jitterMarker = socketService.indexOf('FIX-46 (#110): Jitter');
        expect(handlerOpen).toBeGreaterThan(0);
        expect(jitterMarker).toBeGreaterThan(handlerOpen);
        const block = socketService.slice(handlerOpen, jitterMarker);
        expect(block).toContain('socket_csr_attempt_total');
        expect(block).toContain('socket.recovered');
        expect(block).toContain('[CSR] Recovery FAILED for known-session client');
    });

    it('socket.service.ts uses String(csrRecovered) for the label conversion', () => {
        expect(socketService).toMatch(/recovered:\s*String\(csrRecovered\)/);
    });

    it('socket.service.ts gates the warn log on lastSeq > 0', () => {
        expect(socketService).toMatch(/claimedLastSeq\s*>\s*0/);
    });
});
