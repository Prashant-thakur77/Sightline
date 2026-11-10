import type { Verdict, VerdictRetake } from '@sightline/core';
import type { Shot } from './camera-check';

/** The one extra shot, in the camera's terms: a tag close-up is guided like the size tag, the rest like the whole item. */
export function retakeShot(r: VerdictRetake): Shot {
  return { kind: r.kind === 'tag' ? 'label' : 'item', title: r.title, prompt: r.prompt };
}

/** What the buyer hears before the extra photo: what to do, what happens next, and how to leave it. */
export function retakeIntro(r: VerdictRetake): string {
  return `${r.prompt} I’ll check again with both photos. If you go back, your first answer stays as it is.`;
}

/** The extra photo is offered once: only for a "not sure" check that asked for one and hasn't had it. */
export function canAskForRetake(v: Verdict): v is Verdict & { retake: VerdictRetake } {
  return v.kind === 'unsure' && Boolean(v.retake) && (v.looks ?? 1) < 2;
}
