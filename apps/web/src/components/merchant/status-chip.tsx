import type { StatusWord } from '@sightline/core';

/**
 * A status as a word and a shape, from the shared vocabulary. The shape is decorative and the
 * word carries the meaning, so nothing depends on colour. Kept apart from the grid so pages that
 * only show statuses never load the grid library.
 */
export function StatusChip({ s }: { s: Pick<StatusWord, 'word' | 'glyph' | 'tone'> }) {
  return (
    <span className="mx-status" data-tone={s.tone}>
      <span className="mx-glyph" aria-hidden="true">
        {s.glyph}
      </span>
      <span>{s.word}</span>
    </span>
  );
}
