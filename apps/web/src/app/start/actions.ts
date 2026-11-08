'use server';

import { redirect } from 'next/navigation';
import { ensurePersona, type PersonaKey } from '@/server/personas';
import { createSession } from '@/server/session';

export async function startAs(formData: FormData) {
  const key = String(formData.get('persona') ?? 'maya') as PersonaKey;
  if (key !== 'maya' && key !== 'raj') throw new Error('Unknown persona');
  const userId = await ensurePersona(key);
  await createSession(userId);
  redirect('/app');
}
