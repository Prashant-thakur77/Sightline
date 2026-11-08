import type { StatusWord } from '@sightline/core';

/**
 * A status from the shared vocabulary on buyer pages: the word is read, the glyph is a shape for
 * the eye only, and the tone only tints the glyph, so nothing depends on colour.
 */
export function StatusChip({ s }: { s: Pick<StatusWord, 'word' | 'glyph' | 'tone'> }) {
  return (
    <span className="status-chip" data-tone={s.tone}>
      <span className="status-chip-glyph" aria-hidden="true">
        {s.glyph}
      </span>
      <span>{s.word}</span>
    </span>
  );
}
