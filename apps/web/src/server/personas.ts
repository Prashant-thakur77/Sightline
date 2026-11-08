import 'server-only';
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

/**
 * Create a fresh, isolated demo shopper for each visit, with the persona's preferences and
 * helper, so visitors never see each other's orders. When DEMO_VAULT_ID is configured (a sandbox
 * buyer's saved PayPal, created once with the vault spike), it is attached so the visitor can pay
 * by voice without a PayPal popup.
 */
export async function ensurePersona(key: PersonaKey): Promise<string> {
  const p = PERSONAS[key];
  const userId = newId('usr');
  const email = p.email.replace('@', `+${userId.slice(4, 14)}@`);
  await db().transaction(async (tx) => {
    await tx.insert(tables.users).values({ id: userId, email, displayName: p.displayName, isDemo: true });
    await tx.insert(tables.preferences).values({ userId, ...p.prefs, onboardedAt: new Date().toISOString() });
    if (p.helper)
      await tx
        .insert(tables.helpers)
        .values({ id: newId('hlp'), userId, name: p.helper.name, contact: p.helper.contact, verifiedAt: new Date().toISOString() });
    const vaultId = process.env.DEMO_VAULT_ID?.trim();
    if (vaultId)
      await tx.insert(tables.vaultTokens).values({ id: newId('vlt'), userId, vaultId, status: 'ACTIVE', label: 'your saved PayPal (sandbox demo buyer)' });
  });
  return userId;
}
