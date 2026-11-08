'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { tables } from '@sightline/db';
import { requireUser } from '@/server/session';
import { db } from '@/server/runtime';
import { audit } from '@/server/audit';

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

export type SaveState = { ok: boolean; message: string } | null;

export async function saveSettings(_prev: SaveState, form: FormData): Promise<SaveState> {
  const user = await requireUser();
  const parsed = Schema.safeParse(Object.fromEntries(form.entries()));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, message: `Not saved. Please check ${first?.path.join(' ') ?? 'the form'}.` };
  }
  const v = parsed.data;
  if (v.dailyCap < v.perOrderCap) return { ok: false, message: 'Not saved. The daily limit must be at least the limit for one order.' };
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
  return { ok: true, message: 'Saved. Your new settings apply from your next request.' };
}
