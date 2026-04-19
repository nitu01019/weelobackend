/**
 * =============================================================================
 * QA STATE MACHINE E2E — Canonical Assignment State Machine Tests
 * =============================================================================
 *
 * Tests the canonical ASSIGNMENT_VALID_TRANSITIONS map defined in
 * src/core/state-machines.ts. Verifies:
 *
 *  1. Every valid transition is accepted
 *  2. Every invalid transition is rejected
 *  3. Terminal states have no outgoing transitions
 *  4. validateAssignmentTransition() helper works correctly
 *  5. All 3 services import from the canonical source (not local maps)
 *  6. Full lifecycle: pending -> accepted -> en_route -> at_pickup ->
 *     in_transit -> arrived_at_drop -> completed
 *  7. M-20 enforcement: in_transit CANNOT go directly to completed
 *  8. L-17 enforcement: partial_delivery is terminal
 *
 * =============================================================================
 */

import {
  ASSIGNMENT_VALID_TRANSITIONS,
  TERMINAL_ASSIGNMENT_STATUSES,
  isValidTransition,
  assertValidTransition,
  validateAssignmentTransition,
} from '../core/state-machines';

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// HELPERS
// =============================================================================

const ALL_ASSIGNMENT_STATUSES = Object.keys(ASSIGNMENT_VALID_TRANSITIONS);

const TERMINAL_SET = new Set<string>(TERMINAL_ASSIGNMENT_STATUSES);

const NON_TERMINAL_STATUSES = ALL_ASSIGNMENT_STATUSES.filter(
  (s) => !TERMINAL_SET.has(s)
);

// =============================================================================
// 1. EVERY VALID TRANSITION IS ACCEPTED
// =============================================================================

describe('Valid assignment transitions', () => {
  // Dynamically test every allowed transition in the map
  for (const [from, targets] of Object.entries(ASSIGNMENT_VALID_TRANSITIONS)) {
    for (const to of targets) {
      test(`${from} -> ${to} is VALID`, () => {
        expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, from, to)).toBe(true);
      });
    }
  }

  test('total valid transitions count matches map', () => {
    let count = 0;
    for (const targets of Object.values(ASSIGNMENT_VALID_TRANSITIONS)) {
      count += targets.length;
    }
    // pending(3) + driver_accepted(2) + en_route_pickup(2) + at_pickup(2)
    // + in_transit(2) + arrived_at_drop(3) + completed(0) + partial_delivery(0)
    // + driver_declined(0) + cancelled(0) = 14
    expect(count).toBe(14);
  });
});

// =============================================================================
// 2. EVERY INVALID TRANSITION IS REJECTED
// =============================================================================

describe('Invalid assignment transitions', () => {
  // For each status, test all statuses that are NOT in its allowed list
  for (const from of ALL_ASSIGNMENT_STATUSES) {
    const allowed = new Set(ASSIGNMENT_VALID_TRANSITIONS[from]);
    const invalid = ALL_ASSIGNMENT_STATUSES.filter(
      (s) => !allowed.has(s) && s !== from
    );
    for (const to of invalid) {
      test(`${from} -> ${to} is INVALID`, () => {
        expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, from, to)).toBe(false);
      });
    }
  }

  test('self-transitions are rejected for all statuses', () => {
    for (const status of ALL_ASSIGNMENT_STATUSES) {
      expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, status, status)).toBe(false);
    }
  });

  test('unknown source state returns false', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'nonexistent', 'pending')).toBe(false);
  });

  test('null source returns false', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, null as any, 'pending')).toBe(false);
  });

  test('undefined source returns false', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, undefined as any, 'pending')).toBe(false);
  });

  test('unknown target returns false', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'pending', 'nonexistent_target')).toBe(false);
  });
});

// =============================================================================
// 3. M-20 FIX: in_transit CANNOT go directly to completed
// =============================================================================

describe('M-20: in_transit -> completed is blocked', () => {
  test('in_transit -> completed is INVALID', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'in_transit', 'completed')).toBe(false);
  });

  test('in_transit -> arrived_at_drop is the required intermediate step', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'in_transit', 'arrived_at_drop')).toBe(true);
  });

  test('arrived_at_drop -> completed is VALID (correct path)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'arrived_at_drop', 'completed')).toBe(true);
  });

  test('in_transit allowed list does NOT contain completed', () => {
    const allowed = ASSIGNMENT_VALID_TRANSITIONS['in_transit'];
    expect(allowed).not.toContain('completed');
  });

  test('in_transit allowed list contains only arrived_at_drop and cancelled', () => {
    const allowed = [...ASSIGNMENT_VALID_TRANSITIONS['in_transit']];
    expect(allowed).toEqual(expect.arrayContaining(['arrived_at_drop', 'cancelled']));
    expect(allowed).toHaveLength(2);
  });

  test('validateAssignmentTransition throws for in_transit -> completed', () => {
    expect(() => validateAssignmentTransition('in_transit', 'completed')).toThrow(
      /Invalid assignment transition: in_transit → completed/
    );
  });

  test('assertValidTransition throws for in_transit -> completed', () => {
    expect(() =>
      assertValidTransition('Assignment', ASSIGNMENT_VALID_TRANSITIONS, 'in_transit', 'completed')
    ).toThrow(/Invalid Assignment transition: in_transit → completed/);
  });
});

// =============================================================================
// 4. TERMINAL STATE ENFORCEMENT
// =============================================================================

describe('Terminal state enforcement', () => {
  test('TERMINAL_ASSIGNMENT_STATUSES contains exactly 4 statuses', () => {
    expect(TERMINAL_ASSIGNMENT_STATUSES).toHaveLength(4);
  });

  test('completed is terminal', () => {
    expect(TERMINAL_ASSIGNMENT_STATUSES).toContain('completed');
    expect(ASSIGNMENT_VALID_TRANSITIONS['completed']).toEqual([]);
  });

  test('cancelled is terminal', () => {
    expect(TERMINAL_ASSIGNMENT_STATUSES).toContain('cancelled');
    expect(ASSIGNMENT_VALID_TRANSITIONS['cancelled']).toEqual([]);
  });

  test('driver_declined is terminal', () => {
    expect(TERMINAL_ASSIGNMENT_STATUSES).toContain('driver_declined');
    expect(ASSIGNMENT_VALID_TRANSITIONS['driver_declined']).toEqual([]);
  });

  test('partial_delivery is terminal (L-17)', () => {
    expect(TERMINAL_ASSIGNMENT_STATUSES).toContain('partial_delivery');
    expect(ASSIGNMENT_VALID_TRANSITIONS['partial_delivery']).toEqual([]);
  });

  test('no transitions leave any terminal state', () => {
    for (const terminal of TERMINAL_ASSIGNMENT_STATUSES) {
      const allowed = ASSIGNMENT_VALID_TRANSITIONS[terminal];
      expect(allowed).toEqual([]);
      // Also verify against every possible target
      for (const target of ALL_ASSIGNMENT_STATUSES) {
        expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, terminal, target)).toBe(false);
      }
    }
  });

  test('non-terminal statuses all have at least one outgoing transition', () => {
    for (const status of NON_TERMINAL_STATUSES) {
      const allowed = ASSIGNMENT_VALID_TRANSITIONS[status];
      expect(allowed.length).toBeGreaterThan(0);
    }
  });

  test('every non-terminal status can reach cancelled', () => {
    for (const status of NON_TERMINAL_STATUSES) {
      expect(ASSIGNMENT_VALID_TRANSITIONS[status]).toContain('cancelled');
    }
  });
});

// =============================================================================
// 5. validateAssignmentTransition() HELPER
// =============================================================================

describe('validateAssignmentTransition() helper', () => {
  test('does not throw for valid transition pending -> driver_accepted', () => {
    expect(() => validateAssignmentTransition('pending', 'driver_accepted')).not.toThrow();
  });

  test('does not throw for valid transition at_pickup -> in_transit', () => {
    expect(() => validateAssignmentTransition('at_pickup', 'in_transit')).not.toThrow();
  });

  test('throws for invalid transition pending -> completed', () => {
    expect(() => validateAssignmentTransition('pending', 'completed')).toThrow(
      /Invalid assignment transition/
    );
  });

  test('throws for invalid transition completed -> pending', () => {
    expect(() => validateAssignmentTransition('completed', 'pending')).toThrow(
      /Invalid assignment transition/
    );
  });

  test('error message includes current status', () => {
    try {
      validateAssignmentTransition('pending', 'completed');
    } catch (e: any) {
      expect(e.message).toContain('pending');
    }
  });

  test('error message includes target status', () => {
    try {
      validateAssignmentTransition('pending', 'completed');
    } catch (e: any) {
      expect(e.message).toContain('completed');
    }
  });

  test('error message includes allowed transitions list', () => {
    try {
      validateAssignmentTransition('pending', 'completed');
    } catch (e: any) {
      expect(e.message).toContain('driver_accepted');
      expect(e.message).toContain('driver_declined');
      expect(e.message).toContain('cancelled');
    }
  });

  test('throws for unknown source status', () => {
    expect(() => validateAssignmentTransition('bogus_status', 'pending')).toThrow(
      /Invalid assignment transition/
    );
  });

  test('error message for unknown source shows empty allowed list', () => {
    try {
      validateAssignmentTransition('bogus_status', 'pending');
    } catch (e: any) {
      expect(e.message).toContain('Allowed: []');
    }
  });
});

// =============================================================================
// 6. ALL 3 SERVICES IMPORT FROM CANONICAL SOURCE
// =============================================================================

describe('Services import from canonical state-machines.ts', () => {
  const rootDir = path.resolve(__dirname, '..');

  const servicePaths = [
    'modules/assignment/assignment.service.ts',
    'modules/assignment/assignment-lifecycle.service.ts',
    'modules/tracking/tracking-trip.service.ts',
  ];

  for (const relPath of servicePaths) {
    test(`${relPath} imports ASSIGNMENT_VALID_TRANSITIONS from state-machines.ts`, () => {
      const fullPath = path.join(rootDir, relPath);
      const source = fs.readFileSync(fullPath, 'utf-8');
      expect(source).toContain("from '../../core/state-machines'");
      expect(source).toContain('ASSIGNMENT_VALID_TRANSITIONS');
    });
  }

  test('assignment.service.ts does NOT define its own local transition map', () => {
    const fullPath = path.join(rootDir, 'modules/assignment/assignment.service.ts');
    const source = fs.readFileSync(fullPath, 'utf-8');
    // Should not have a local const ASSIGNMENT_VALID_TRANSITIONS = { ... }
    expect(source).not.toMatch(/const\s+ASSIGNMENT_VALID_TRANSITIONS\s*[:=]/);
  });

  test('assignment-lifecycle.service.ts does NOT define its own local transition map', () => {
    const fullPath = path.join(rootDir, 'modules/assignment/assignment-lifecycle.service.ts');
    const source = fs.readFileSync(fullPath, 'utf-8');
    expect(source).not.toMatch(/const\s+ASSIGNMENT_VALID_TRANSITIONS\s*[:=]/);
  });

  test('tracking-trip.service.ts does NOT define its own local transition map', () => {
    const fullPath = path.join(rootDir, 'modules/tracking/tracking-trip.service.ts');
    const source = fs.readFileSync(fullPath, 'utf-8');
    expect(source).not.toMatch(/const\s+ASSIGNMENT_VALID_TRANSITIONS\s*[:=]/);
  });
});

// =============================================================================
// 7. FULL LIFECYCLE: pending -> ... -> completed
// =============================================================================

describe('Full assignment lifecycle', () => {
  const HAPPY_PATH = [
    'pending',
    'driver_accepted',
    'en_route_pickup',
    'at_pickup',
    'in_transit',
    'arrived_at_drop',
    'completed',
  ] as const;

  test('happy path: each step is a valid transition', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      const from = HAPPY_PATH[i];
      const to = HAPPY_PATH[i + 1];
      expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, from, to)).toBe(true);
    }
  });

  test('happy path ends at terminal state completed', () => {
    const last = HAPPY_PATH[HAPPY_PATH.length - 1];
    expect(TERMINAL_SET.has(last)).toBe(true);
  });

  test('validateAssignmentTransition accepts every step of the happy path', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      expect(() =>
        validateAssignmentTransition(HAPPY_PATH[i], HAPPY_PATH[i + 1])
      ).not.toThrow();
    }
  });

  test('partial delivery lifecycle: pending -> ... -> arrived_at_drop -> partial_delivery', () => {
    const partialPath = [
      'pending',
      'driver_accepted',
      'en_route_pickup',
      'at_pickup',
      'in_transit',
      'arrived_at_drop',
      'partial_delivery',
    ] as const;
    for (let i = 0; i < partialPath.length - 1; i++) {
      expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, partialPath[i], partialPath[i + 1])).toBe(true);
    }
    expect(TERMINAL_SET.has('partial_delivery')).toBe(true);
  });

  test('decline lifecycle: pending -> driver_declined', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'pending', 'driver_declined')).toBe(true);
    expect(TERMINAL_SET.has('driver_declined')).toBe(true);
  });

  test('early cancel from pending', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'pending', 'cancelled')).toBe(true);
  });

  test('cancel from driver_accepted', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'driver_accepted', 'cancelled')).toBe(true);
  });

  test('cancel from en_route_pickup', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'en_route_pickup', 'cancelled')).toBe(true);
  });

  test('cancel from at_pickup', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'at_pickup', 'cancelled')).toBe(true);
  });

  test('cancel from in_transit', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'in_transit', 'cancelled')).toBe(true);
  });

  test('cancel from arrived_at_drop', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'arrived_at_drop', 'cancelled')).toBe(true);
  });
});

// =============================================================================
// 8. SPECIFIC INVALID TRANSITIONS (explicit regression guards)
// =============================================================================

describe('Specific invalid transitions (regression guards)', () => {
  test('pending -> completed is blocked (must go through lifecycle)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'pending', 'completed')).toBe(false);
  });

  test('pending -> in_transit is blocked (must accept first)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'pending', 'in_transit')).toBe(false);
  });

  test('pending -> at_pickup is blocked (must accept and go en_route first)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'pending', 'at_pickup')).toBe(false);
  });

  test('pending -> arrived_at_drop is blocked', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'pending', 'arrived_at_drop')).toBe(false);
  });

  test('pending -> en_route_pickup is blocked (must accept first)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'pending', 'en_route_pickup')).toBe(false);
  });

  test('pending -> partial_delivery is blocked', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'pending', 'partial_delivery')).toBe(false);
  });

  test('driver_accepted -> completed is blocked (skip not allowed)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'driver_accepted', 'completed')).toBe(false);
  });

  test('driver_accepted -> in_transit is blocked (must go en_route first)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'driver_accepted', 'in_transit')).toBe(false);
  });

  test('driver_accepted -> at_pickup is blocked (must go en_route first)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'driver_accepted', 'at_pickup')).toBe(false);
  });

  test('en_route_pickup -> completed is blocked', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'en_route_pickup', 'completed')).toBe(false);
  });

  test('en_route_pickup -> in_transit is blocked (must arrive at pickup first)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'en_route_pickup', 'in_transit')).toBe(false);
  });

  test('at_pickup -> completed is blocked (must go in_transit first)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'at_pickup', 'completed')).toBe(false);
  });

  test('in_transit -> completed is blocked (M-20, must arrive at drop first)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'in_transit', 'completed')).toBe(false);
  });

  test('completed -> pending is blocked (terminal cannot restart)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'completed', 'pending')).toBe(false);
  });

  test('cancelled -> pending is blocked (terminal cannot restart)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'cancelled', 'pending')).toBe(false);
  });

  test('driver_declined -> pending is blocked (terminal cannot restart)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'driver_declined', 'pending')).toBe(false);
  });

  test('partial_delivery -> completed is blocked (terminal)', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'partial_delivery', 'completed')).toBe(false);
  });

  test('backward transition: in_transit -> at_pickup is blocked', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'in_transit', 'at_pickup')).toBe(false);
  });

  test('backward transition: at_pickup -> en_route_pickup is blocked', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'at_pickup', 'en_route_pickup')).toBe(false);
  });

  test('backward transition: arrived_at_drop -> in_transit is blocked', () => {
    expect(isValidTransition(ASSIGNMENT_VALID_TRANSITIONS, 'arrived_at_drop', 'in_transit')).toBe(false);
  });
});

// =============================================================================
// 9. MAP STRUCTURE INTEGRITY
// =============================================================================

describe('State machine map structure integrity', () => {
  test('map has exactly 10 statuses', () => {
    expect(ALL_ASSIGNMENT_STATUSES).toHaveLength(10);
  });

  test('map contains all expected statuses', () => {
    const expected = [
      'pending',
      'driver_accepted',
      'en_route_pickup',
      'at_pickup',
      'in_transit',
      'arrived_at_drop',
      'completed',
      'partial_delivery',
      'driver_declined',
      'cancelled',
    ];
    for (const s of expected) {
      expect(ALL_ASSIGNMENT_STATUSES).toContain(s);
    }
  });

  test('all target statuses exist as keys in the map', () => {
    for (const targets of Object.values(ASSIGNMENT_VALID_TRANSITIONS)) {
      for (const target of targets) {
        expect(ASSIGNMENT_VALID_TRANSITIONS).toHaveProperty(target);
      }
    }
  });

  test('no duplicate targets in any status allowed list', () => {
    for (const [status, targets] of Object.entries(ASSIGNMENT_VALID_TRANSITIONS)) {
      const unique = new Set(targets);
      expect(unique.size).toBe(targets.length);
    }
  });

  test('pending has exactly 3 valid next states', () => {
    expect(ASSIGNMENT_VALID_TRANSITIONS['pending']).toHaveLength(3);
  });

  test('arrived_at_drop has exactly 3 valid next states', () => {
    expect(ASSIGNMENT_VALID_TRANSITIONS['arrived_at_drop']).toHaveLength(3);
  });
});
