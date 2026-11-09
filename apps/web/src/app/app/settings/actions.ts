'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { tables } from '@sightline/db';
import { requireUser } from '@/server/session';
import { db } from '@/server/runtime';
import { audit } from '@/server/audit';
import { deleteMyData, deleteMyPhotos, PHOTO_RETENTION_DAYS } from '@/server/privacy';
import { forgetAllMemories, forgetMemories, listMemories, updateMemory } from '@/server/memories';
import { COLOURS, MATERIALS, describeMemory, findPhrases, normaliseSize, words } from '@sightline/agent';

const Schema = z.object({
  verbosity: z.enum(['brief', 'standard', 'detailed']),
  voiceMode: z.enum(['screen-reader', 'own-voice', 'both']),
  speechRate: z.coerce.number().int().min(50).max(250),
  tops: z.string().max(8).optional(),
  bottoms: z.string().max(8).optional(),
  shoes: z.string().max(8).optional(),
  avoidColours: z.string().max(200).optional(),
  perOrderCap: z.coerce.number().min(1).max(5000),
  dailyCap: z.coerce.number().min(1).max(10000),
  payAfterCheck: z.string().optional(),
  lowVision: z.string().optional(),
  textScale: z.coerce.number().min(1).max(3),
});

export type SaveState = { ok: boolean; message: string; field?: string } | null;

const LABELS: Record<string, string> = {
  verbosity: 'how I should talk',
  voiceMode: 'whose voice',
  speechRate: 'speech rate (50 to 250)',
  tops: 'tops size',
  bottoms: 'bottoms size',
  shoes: 'shoe size',
  avoidColours: 'colours to avoid',
  perOrderCap: 'most for one order (1 to 5,000 dollars)',
  dailyCap: 'most in one day (1 to 10,000 dollars)',
  textScale: 'text size',
};

export async function saveSettings(_prev: SaveState, form: FormData): Promise<SaveState> {
  const user = await requireUser();
  const parsed = Schema.safeParse(Object.fromEntries(form.entries()));
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? '');
    return { ok: false, field, message: `Not saved. Please check ${LABELS[field] ?? 'the form'}, then press Save again. Your other changes are still here.` };
  }
  const v = parsed.data;
  if (v.dailyCap < v.perOrderCap)
    return { ok: false, field: 'dailyCap', message: 'Not saved. The most in one day must be at least the most for one order. Change one of them, then press Save again.' };
  const sizes: Record<string, string> = {};
  if (v.tops) sizes.tops = v.tops.toUpperCase();
  if (v.bottoms) sizes.bottoms = v.bottoms;
  if (v.shoes) sizes.shoes = v.shoes;
  await db()
    .update(tables.preferences)
    .set({
      verbosity: v.verbosity,
      voiceMode: v.voiceMode,
      speechRate: v.speechRate,
      sizes,
      avoidColours: (v.avoidColours ?? '')
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean),
      perOrderCapCents: Math.round(v.perOrderCap * 100),
      dailyCapCents: Math.round(v.dailyCap * 100),
      payAfterCheck: v.payAfterCheck === 'on',
      lowVision: { enabled: v.lowVision === 'on', textScale: v.textScale, highContrast: v.lowVision === 'on' },
    })
    .where(eq(tables.preferences.userId, user.id));
  await audit({ userId: user.id, actor: 'user', action: 'settings.saved', subjectId: user.id, payload: { perOrderCapCents: Math.round(v.perOrderCap * 100), dailyCapCents: Math.round(v.dailyCap * 100) } });
  revalidatePath('/app/settings');
  return { ok: true, message: 'Saved. Your new settings apply from now on.' };
}

// ---------------------------------------------------------------------------------------------
// What I remember

export type MemoryState = { ok: boolean; message: string; id?: string } | null;

/** A new value for a memory, checked by kind: a size, a budget in dollars, or a known material or colour. */
function memoryValue(kind: string, raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > 30) return null;
  if (kind === 'size') {
    const s = normaliseSize(v);
    return s && s.length <= 8 ? s : null;
  }
  if (kind === 'budget') {
    const n = Number(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && n >= 1 && n <= 5000 ? String(Math.round(n * 100)) : null;
  }
  const lex = kind.endsWith('material') ? MATERIALS : COLOURS;
  return findPhrases(words(v), lex)[0]?.canonical ?? null;
}

const MEMORY_RULE: Record<string, string> = {
  size: 'Use a size such as M, XL or 9.',
  budget: 'Use an amount from 1 to 5,000 dollars.',
  avoid_material: 'Use a material such as wool or polyester.',
  like_material: 'Use a material such as cotton or linen.',
  avoid_colour: 'Use a colour such as orange or navy.',
  like_colour: 'Use a colour such as orange or navy.',
};

export async function updateMemoryAction(_prev: MemoryState, form: FormData): Promise<MemoryState> {
  const user = await requireUser();
  const id = String(form.get('id') ?? '');
  const mine = (await listMemories(user.id)).find((m) => m.id === id);
  if (!mine) return { ok: false, message: "That memory isn't here any more, so nothing changed." };
  const value = memoryValue(mine.kind, String(form.get('value') ?? ''));
  if (!value) return { ok: false, id, message: `Not changed. ${MEMORY_RULE[mine.kind] ?? 'Check the value.'} Then press Save again.` };
  await updateMemory(user.id, id, value);
  revalidatePath('/app/settings');
  return { ok: true, id, message: `Changed. Now I remember that ${describeMemory({ ...mine, value })}.` };
}

export async function forgetMemoryAction(_prev: MemoryState, form: FormData): Promise<MemoryState> {
  const user = await requireUser();
  const [gone] = await forgetMemories(user.id, [String(form.get('id') ?? '')], 'settings');
  revalidatePath('/app/settings');
  if (!gone) return { ok: true, message: "That memory was already gone, so nothing changed." };
  return { ok: true, message: `Forgotten: ${describeMemory(gone)}. To set it again, tell me in the conversation.` };
}

export async function forgetAllMemoriesAction(_prev: MemoryState, _form: FormData): Promise<MemoryState> {
  const user = await requireUser();
  const n = await forgetAllMemories(user.id, 'settings');
  revalidatePath('/app/settings');
  return { ok: true, message: n ? `Done. I forgot ${n === 1 ? 'the one thing' : `all ${n} things`} I remembered. Your other settings are unchanged.` : 'There was nothing to forget.' };
}

export type DeleteState = { ok: boolean; message: string } | null;

const photos = (n: number) => `${n} parcel photo${n === 1 ? '' : 's'}`;
const keptNote = (kept: number) =>
  kept
    ? ` I kept ${photos(kept)}, because your money-back case is still open. ${kept === 1 ? 'It goes' : 'They go'} when the case is resolved, or after ${PHOTO_RETENTION_DAYS} days.`
    : '';

export async function deletePhotosAction(_prev: DeleteState, _form: FormData): Promise<DeleteState> {
  const user = await requireUser();
  try {
    const r = await deleteMyPhotos(user.id);
    revalidatePath('/app/settings');
    if (!r.deleted && !r.kept) return { ok: true, message: 'There were no parcel photos to delete.' };
    const done = r.deleted ? `Done. I deleted ${photos(r.deleted)}. This can't be undone. Your receipts still check out, because they keep each photo's fingerprint, not the photo.` : 'Nothing was deleted.';
    return { ok: true, message: done + keptNote(r.kept) };
  } catch {
    return { ok: false, message: 'Something went wrong part way, so some photos may still be here. Press Delete my photos again to finish.' };
  }
}

export async function deleteDataAction(_prev: DeleteState, _form: FormData): Promise<DeleteState> {
  const user = await requireUser();
  try {
    const r = await deleteMyData(user.id);
    revalidatePath('/app/settings');
    return {
      ok: true,
      message:
        `Done. I deleted your conversations, saved sizes and colours, what I remembered about you, helper contact, notifications and ${photos(r.photos.deleted)}. This can't be undone. ` +
        `Your orders, payments and receipts are kept, because refunds need them.` +
        keptNote(r.photos.kept),
    };
  } catch {
    return { ok: false, message: 'Something went wrong part way, so some of your data may still be here. Press Delete everything again to finish.' };
  }
}
