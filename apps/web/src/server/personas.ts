import 'server-only';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { newId } from '@sightline/core';
import { db } from './runtime';

export type PersonaKey = 'maya' | 'raj';

interface Persona {
  email: string;
  displayName: string;
  summary: string;
  prefs: Partial<typeof tables.preferences.$inferInsert>;
  helper?: { name: string; contact: string };
}

export const PERSONAS: Record<PersonaKey, Persona> = {
  maya: {
    email: 'maya@demo.sightline.app',
    displayName: 'Maya',
    summary: 'Totally blind since birth. Uses a screen reader. Has been charged twice before and gave up on returns.',
    prefs: {
      verbosity: 'standard',
      voiceMode: 'screen-reader',
      sizes: { tops: 'M', bottoms: '30', shoes: '9' },
      perOrderCapCents: 10000,
      dailyCapCents: 25000,
      payAfterCheck: true,
    },
    helper: { name: 'Asha', contact: 'asha@demo.sightline.app' },
  },
  raj: {
    email: 'raj@demo.sightline.app',
    displayName: 'Raj',
    summary: 'Low vision from macular degeneration. Uses zoom and high contrast. Wants big text and no surprises.',
    prefs: {
      verbosity: 'detailed',
      voiceMode: 'both',
      sizes: { tops: 'L', shoes: '10' },
      perOrderCapCents: 15000,
      dailyCapCents: 30000,
      lowVision: { enabled: true, textScale: 1.5, highContrast: true },
      payAfterCheck: true,
    },
  },
};

/** Idempotently create a demo persona with preferences and (for Maya) a trusted helper. */
export async function ensurePersona(key: PersonaKey): Promise<string> {
  const p = PERSONAS[key];
  const existing = await db().select({ id: tables.users.id }).from(tables.users).where(eq(tables.users.email, p.email)).limit(1);
  if (existing[0]) return existing[0].id;
  const userId = newId('usr');
  await db().transaction(async (tx) => {
    await tx.insert(tables.users).values({ id: userId, email: p.email, displayName: p.displayName, isDemo: true });
    await tx.insert(tables.preferences).values({ userId, ...p.prefs, onboardedAt: new Date().toISOString() });
    if (p.helper)
      await tx
        .insert(tables.helpers)
        .values({ id: newId('hlp'), userId, name: p.helper.name, contact: p.helper.contact, verifiedAt: new Date().toISOString() });
  });
  return userId;
}
