import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { newId } from '@sightline/core';
import { describeMemory, type Memory, type MemoryDraft, type MemoryKind } from '@sightline/agent';
import { db } from './runtime';
import { audit } from './audit';

/**
 * The buyer's remembered preferences. Saved only after the buyer said yes (or asked to be
 * remembered); one size and one budget per scope; liking and avoiding the same colour or material
 * can't both stand, so the newer one replaces the older.
 */

type Row = typeof tables.memories.$inferSelect;

function toMemory(r: Row): Memory {
  return { id: r.id, kind: r.kind as MemoryKind, value: r.value, ...(r.scope ? { scope: r.scope } : {}), said: r.said, createdAt: r.createdAt };
}

export async function listMemories(userId: string): Promise<Memory[]> {
  const rows = await db().select().from(tables.memories).where(eq(tables.memories.userId, userId)).orderBy(asc(tables.memories.createdAt));
  return rows.map(toMemory);
}

const OPPOSITE: Partial<Record<MemoryKind, MemoryKind>> = {
  like_colour: 'avoid_colour',
  avoid_colour: 'like_colour',
  like_material: 'avoid_material',
  avoid_material: 'like_material',
};

/** Store one memory, replacing what it supersedes. Returns the stored memory. */
export async function saveMemory(userId: string, draft: MemoryDraft, source: 'voice' | 'settings' = 'voice'): Promise<Memory> {
  const id = newId('mem');
  const now = new Date().toISOString();
  await db().transaction(async (tx) => {
    const mine = await tx.select().from(tables.memories).where(eq(tables.memories.userId, userId));
    const replaced = mine.filter((m) => {
      if (draft.kind === 'size' || draft.kind === 'budget') return m.kind === draft.kind && (m.scope ?? null) === (draft.scope ?? null);
      return (m.kind === draft.kind || m.kind === OPPOSITE[draft.kind]) && m.value === draft.value;
    });
    if (replaced.length) await tx.delete(tables.memories).where(inArray(tables.memories.id, replaced.map((m) => m.id)));
    await tx.insert(tables.memories).values({ id, userId, kind: draft.kind, value: draft.value, scope: draft.scope ?? null, said: draft.said.slice(0, 500), source, createdAt: now, updatedAt: now });
  });
  await audit({ userId, actor: 'user', action: 'memory.saved', subjectId: userId, payload: { id, kind: draft.kind, scope: draft.scope ?? null, by: source } });
  return { ...draft, id, createdAt: now };
}

/** Change a memory's value (from Settings). False when it isn't this buyer's. */
export async function updateMemory(userId: string, id: string, value: string): Promise<boolean> {
  const rows = await db()
    .update(tables.memories)
    .set({ value, source: 'settings', updatedAt: new Date().toISOString() })
    .where(and(eq(tables.memories.id, id), eq(tables.memories.userId, userId)))
    .returning({ id: tables.memories.id, kind: tables.memories.kind });
  if (!rows.length) return false;
  await audit({ userId, actor: 'user', action: 'memory.changed', subjectId: userId, payload: { id, kind: rows[0]!.kind, by: 'settings' } });
  return true;
}

/** Forget these memories (only the buyer's own). Returns what was forgotten. */
export async function forgetMemories(userId: string, ids: string[], by: 'voice' | 'settings'): Promise<Memory[]> {
  if (!ids.length) return [];
  const rows = await db()
    .delete(tables.memories)
    .where(and(eq(tables.memories.userId, userId), inArray(tables.memories.id, ids)))
    .returning();
  if (rows.length) await audit({ userId, actor: 'user', action: 'memory.forgotten', subjectId: userId, payload: { count: rows.length, kinds: rows.map((r) => r.kind), by } });
  return rows.map(toMemory);
}

export async function forgetAllMemories(userId: string, by: 'voice' | 'settings'): Promise<number> {
  const rows = await db().delete(tables.memories).where(eq(tables.memories.userId, userId)).returning({ id: tables.memories.id });
  if (rows.length) await audit({ userId, actor: 'user', action: 'memory.forgotten', subjectId: userId, payload: { count: rows.length, all: true, by } });
  return rows.length;
}

/** A memory in words, for the Settings list and spoken confirmations. */
export function memorySentence(m: Pick<MemoryDraft, 'kind' | 'value' | 'scope'>): string {
  const d = describeMemory(m);
  return d.replace(/^you're /, "You're ").replace(/^you /, 'You ');
}
