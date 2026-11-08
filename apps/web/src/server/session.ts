import 'server-only';
import { cookies } from 'next/headers';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { newId } from '@sightline/core';
import { db, ENV } from './runtime';

const COOKIE = 'sl_session';
/**
 * Sessions slide: each visit pushes the end 24 hours out (over the 20 hours WCAG 2.2.1 allows
 * without a warning), so nobody is signed out mid-task. The database row decides; the cookie only
 * outlives it so a page render, which cannot set cookies, never has to refresh it.
 */
const IDLE_MS = 1000 * 60 * 60 * 24;
const COOKIE_MS = 1000 * 60 * 60 * 24 * 30;
const REFRESH_AFTER_MS = 1000 * 60 * 60;

function secret(): string {
  if (!ENV.SESSION_SECRET) throw new Error('SESSION_SECRET is not set');
  return ENV.SESSION_SECRET;
}

function sign(id: string): string {
  const mac = createHmac('sha256', secret()).update(id).digest('base64url');
  return `${id}.${mac}`;
}

function unsign(value: string | undefined): string | null {
  if (!value) return null;
  const i = value.lastIndexOf('.');
  if (i < 1) return null;
  const id = value.slice(0, i);
  const expected = Buffer.from(sign(id));
  const got = Buffer.from(value);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return id;
}

export async function createSession(userId: string): Promise<void> {
  const id = newId('ses') + randomBytes(8).toString('hex');
  const expiresAt = new Date(Date.now() + IDLE_MS).toISOString();
  await db().insert(tables.sessions).values({ id, userId, expiresAt });
  const jar = await cookies();
  jar.set(COOKIE, sign(id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: ENV.APP_URL.startsWith('https://'),
    path: '/',
    expires: new Date(Date.now() + COOKIE_MS),
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const id = unsign(jar.get(COOKIE)?.value);
  if (id) await db().delete(tables.sessions).where(eq(tables.sessions.id, id));
  jar.delete(COOKIE);
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isDemo: boolean;
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const id = unsign(jar.get(COOKIE)?.value);
  if (!id) return null;
  const now = Date.now();
  const rows = await db()
    .select({
      id: tables.users.id,
      email: tables.users.email,
      displayName: tables.users.displayName,
      isDemo: tables.users.isDemo,
      expiresAt: tables.sessions.expiresAt,
    })
    .from(tables.sessions)
    .innerJoin(tables.users, eq(tables.users.id, tables.sessions.userId))
    .where(and(eq(tables.sessions.id, id), gt(tables.sessions.expiresAt, new Date(now).toISOString())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Slide the end forward, at most once an hour.
  if (Date.parse(row.expiresAt) - now < IDLE_MS - REFRESH_AFTER_MS)
    await db().update(tables.sessions).set({ expiresAt: new Date(now + IDLE_MS).toISOString() }).where(eq(tables.sessions.id, id));
  const { expiresAt: _end, ...user } = row;
  return user;
}

export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) throw new HttpError(401, 'Please sign in first.');
  return u;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
