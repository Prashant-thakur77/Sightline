import { describe, expect, it } from 'vitest';
import { AUDIT, appendChain, hashObject, verifyChain, type ChainLink } from '../src';

type Entry = { seq: number; action: string };

function build(n: number): ChainLink<Entry>[] {
  const links: ChainLink<Entry>[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const link: ChainLink<Entry> = appendChain(prev, { seq: i, action: `step ${i}` });
    links.push(link);
    prev = link.hash;
  }
  return links;
}

describe('hash chain', () => {
  it('links each entry to the previous hash', () => {
    const links = build(3);
    expect(links[0]!.prevHash).toBeNull();
    expect(links[1]!.prevHash).toBe(links[0]!.hash);
    expect(links[0]!.hash).toBe(hashObject(AUDIT, { prevHash: null, entry: links[0]!.entry }));
  });

  it('verifies an intact chain and reports its head', () => {
    const links = build(5);
    expect(verifyChain(links)).toEqual({ ok: true, head: links[4]!.hash, length: 5 });
    expect(verifyChain([])).toEqual({ ok: true, head: null, length: 0 });
  });

  it('detects an edited entry at the right index', () => {
    const links = build(5);
    links[2] = { ...links[2]!, entry: { seq: 2, action: 'edited' } };
    expect(verifyChain(links)).toEqual({ ok: false, brokenAt: 2, reason: 'hash_mismatch' });
  });

  it('detects an edited entry that was re-hashed, one link later', () => {
    const links = build(5);
    links[2] = appendChain(links[1]!.hash, { seq: 2, action: 'edited and rehashed' });
    expect(verifyChain(links)).toEqual({ ok: false, brokenAt: 3, reason: 'prev_hash_mismatch' });
  });

  it('detects a deleted link', () => {
    const links = build(5);
    links.splice(1, 1);
    expect(verifyChain(links)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it('detects reordering', () => {
    const links = build(4);
    [links[1], links[2]] = [links[2]!, links[1]!];
    expect(verifyChain(links)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it('detects a forged genesis and verifies a later segment against an anchor', () => {
    const links = build(6);
    expect(verifyChain(links.slice(3))).toMatchObject({ ok: false, brokenAt: 0, reason: 'prev_hash_mismatch' });
    expect(verifyChain(links.slice(3), { anchor: links[2]!.hash })).toMatchObject({ ok: true, length: 3 });
  });

  it('reports malformed links instead of throwing', () => {
    const links = build(2) as ChainLink<unknown>[];
    links[1] = { ...links[1]!, hash: 'not-a-hash' };
    expect(verifyChain(links)).toEqual({ ok: false, brokenAt: 1, reason: 'malformed' });
  });
});
