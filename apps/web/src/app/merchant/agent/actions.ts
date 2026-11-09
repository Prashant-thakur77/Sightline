'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { describePolicy, POLICY_MAX_CENTS, type StorePolicy } from '@sightline/agent';
import { requireMerchantScope } from '@/server/merchant';
import { saveStorePolicy } from '@/server/store-policy';
import { audit } from '@/server/audit';

const dollars = z.coerce.number().min(0).max(POLICY_MAX_CENTS / 100);
const Schema = z.object({
  agentOn: z.string().optional(),
  autoSend: z.string().optional(),
  autoReplaceMax: dollars,
  askStaffAbove: dollars,
  partialRefunds: z.enum(['none', 'up_to_20', 'up_to_50']),
});

export type PolicyState = { ok: boolean; message: string; field?: string } | null;

const LABELS: Record<string, string> = {
  autoReplaceMax: 'the replacement limit (0 to 5,000 dollars)',
  askStaffAbove: 'the staff limit (0 to 5,000 dollars)',
  partialRefunds: 'which part refunds are allowed',
};

/** Save the store's case policy. Amounts arrive in dollars and are stored as whole cents. */
export async function savePolicyAction(_prev: PolicyState, form: FormData): Promise<PolicyState> {
  let scope: string;
  try {
    scope = await requireMerchantScope();
  } catch {
    return { ok: false, message: 'Start a demo first. Nothing was saved.' };
  }
  const parsed = Schema.safeParse(Object.fromEntries(form.entries()));
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? '');
    return { ok: false, field, message: `Not saved. Please check ${LABELS[field] ?? 'the form'}, then press Save again. Your other changes are still here.` };
  }
  const v = parsed.data;
  const policy: StorePolicy = {
    agentOn: v.agentOn === 'on',
    autoSend: v.autoSend === 'on',
    autoReplaceMaxCents: Math.round(v.autoReplaceMax * 100),
    askStaffAboveCents: Math.round(v.askStaffAbove * 100),
    partialRefunds: v.partialRefunds,
  };
  await saveStorePolicy(scope, policy);
  await audit({ userId: scope, actor: 'merchant', action: 'store_policy.saved', subjectId: scope, payload: { ...policy } });
  revalidatePath('/merchant/agent');
  revalidatePath('/merchant/disputes');
  return { ok: true, message: `Saved. From the next case: ${describePolicy(policy)}` };
}
