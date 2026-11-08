import type { Money } from '@sightline/core';
import type { GateCode, GuardResult } from './types';

export function pass(guard: string, message: string, details: Record<string, unknown> = {}): GuardResult {
  return { guard, ok: true, code: 'OK', message, details };
}

export function fail(
  guard: string,
  code: Exclude<GateCode, 'OK'>,
  message: string,
  details: Record<string, unknown> = {},
): GuardResult {
  return { guard, ok: false, code, message, details };
}

const CURRENCY = /^[A-Z]{3}$/;

/** A well-formed Money value: safe-integer cents and an ISO currency code. Nothing else counts. */
export function isMoney(v: unknown): v is Money {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return typeof m.cents === 'number' && Number.isSafeInteger(m.cents) && typeof m.currency === 'string' && CURRENCY.test(m.currency);
}

/** Epoch milliseconds for an ISO timestamp, or null when it is missing or unparseable. */
export function timeOf(iso: unknown): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function isValidDate(d: unknown): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

export function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
