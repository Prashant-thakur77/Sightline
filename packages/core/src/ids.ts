import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Sortable, URL-safe ids: prefix + 10 chars of time + 12 chars of randomness. */
export function newId(prefix: string): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(12);
  let r = '';
  for (const b of rnd) r += ALPHABET[b % 32];
  return `${prefix}_${time}${r}`;
}
