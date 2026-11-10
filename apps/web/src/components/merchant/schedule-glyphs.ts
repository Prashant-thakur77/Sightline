import type { ScheduleTone } from '@/server/schedule';

/** A shape for each kind of entry, shown beside its word, so the kind never rests on colour. */
export const TONE_GLYPH: Record<ScheduleTone, string> = { hold: '▬', deadline: '◆', done: '✓' };
