import type { Verdict, VerdictRetake } from '@sightline/core';

type Photo = { kind: string; blobId: string; sha256: string; source?: string };

export type RetakeAllowed =
  | { ok: true; verificationId: string; retake: VerdictRetake; modules: Record<string, unknown>; photos: Photo[] }
  | { ok: false; say: string };

const NOTHING_TO_TAKE = 'There’s no extra photo to take for this check. Your answer stays as it is.';

/**
 * Whether the latest check may get its ONE extra photo: it must be "not sure", have asked for a
 * photo, not be a check that already had one, and have its module outputs stored on this server.
 */
export function retakeAllowed(
  ver: { id: string; verdict: Verdict | null; moduleOutputs: unknown; photos: Photo[] } | null | undefined,
): RetakeAllowed {
  if (!ver?.verdict) return { ok: false, say: 'There’s no check to add a photo to yet. Check the parcel first.' };
  const v = ver.verdict;
  if (v.kind !== 'unsure' || !v.retake || (v.looks ?? 1) >= 2) return { ok: false, say: NOTHING_TO_TAKE };
  const modules = (ver.moduleOutputs as { modules?: Record<string, unknown> } | null)?.modules;
  if (!modules || typeof modules !== 'object') return { ok: false, say: NOTHING_TO_TAKE };
  const keep = ['quality', 'colour', 'size', 'identity', 'damage'];
  return {
    ok: true,
    verificationId: ver.id,
    retake: v.retake,
    modules: Object.fromEntries(Object.entries(modules).filter(([k]) => keep.includes(k))),
    photos: ver.photos,
  };
}
