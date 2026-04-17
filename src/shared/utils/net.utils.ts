/**
 * =============================================================================
 * NETWORK UTILITIES — client IP chain + CIDR membership (F-A-08)
 * =============================================================================
 *
 * Helpers used by the edge layer after trust-proxy migrates from a spoofable
 * numeric hop-count to a CIDR-based trusted-proxy list.
 *
 * - getClientIpChain(req): exposes the raw X-Forwarded-For sources and the
 *   final IP that Express resolved (req.ip). Used by rate-limiter / logging /
 *   metrics to tell the difference between a real client IP and a spoofed
 *   XFF entry. See adam-p.ca "Perils of the real client IP".
 *
 * - isInCidrList(ip, cidrs): returns whether the given IP falls inside any
 *   CIDR in the list. Tolerant of IPv4-mapped IPv6 addresses ("::ffff:x.x.x.x")
 *   and malformed input (returns false instead of throwing).
 *
 * Rationale: the rate-limiter's keyGenerator must distinguish "request came
 * through our ALB" from "request came straight off the internet". A wrapper
 * around ipaddr.js keeps that logic out of middleware hot paths.
 * =============================================================================
 */

import type { Request } from 'express';
import ipaddr from 'ipaddr.js';

export interface ClientIpChain {
  /** Raw X-Forwarded-For values (empty when no XFF header was sent). */
  readonly sources: string[];
  /**
   * The IP Express resolved via `trust proxy` — either the left-most trusted
   * XFF hop or the socket address when XFF was ignored. Falls back to
   * 'unknown' only if neither Express nor the socket could resolve an IP.
   */
  readonly final: string;
}

export function getClientIpChain(req: Request): ClientIpChain {
  const xffHeader = req.headers['x-forwarded-for'];
  const xffRaw = Array.isArray(xffHeader) ? xffHeader.join(',') : (xffHeader ?? '');
  const sources = xffRaw
    .toString()
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  const final = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  return { sources, final };
}

function stripIpv4Mapped(ip: string): string {
  // '::ffff:10.0.0.1' -> '10.0.0.1'
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

export function isInCidrList(ip: string, cidrs: readonly string[]): boolean {
  if (!ip || !cidrs || cidrs.length === 0) return false;

  const normalised = stripIpv4Mapped(ip);
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(normalised);
  } catch {
    return false;
  }

  for (const cidr of cidrs) {
    if (!cidr) continue;
    try {
      const range = ipaddr.parseCIDR(cidr);
      // Protocol versions must match — ipaddr.match throws on mismatch.
      if (parsed.kind() !== range[0].kind()) continue;
      if ((parsed as any).match(range)) return true;
    } catch {
      // Malformed CIDR entry — skip it, do not throw.
      continue;
    }
  }
  return false;
}
