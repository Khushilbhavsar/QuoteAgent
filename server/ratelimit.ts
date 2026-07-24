/**
 * Tiny in-memory rate-limit helpers, kept in their own side-effect-free module
 * so both the HTTP server and the smoke test can use (and unit-test) them
 * without importing server.ts (which would start the web server on import).
 *
 * Production note: this is per-instance and in-memory — a real deployment
 * would use a shared store (Redis) or an edge/WAF rate limiter.
 */
export const HOUR_MS = 60 * 60 * 1000;

/** Keep only the timestamps from within the last hour. */
export function withinLastHour(times: number[], now: number): number[] {
  return times.filter((t) => now - t < HOUR_MS);
}

/** True if there are already `max` (or more) events within the last hour. */
export function isOverLimit(times: number[], max: number, now: number): boolean {
  return withinLastHour(times, now).length >= max;
}
