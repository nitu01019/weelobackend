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
                    userId: socketData.userId,
                    role: socketData.role,
                    lastSeq: claimedLastSeq,
                });
                warnEmitted = true;
            }
        }
        return { warnEmitted };
    }

    it('recovered=false AND lastSeq=5 → warn emitted with structured fields', () => {
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
                userId: 'user-123',
                role: 'driver',
                lastSeq: 5,
            }),
        );
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
