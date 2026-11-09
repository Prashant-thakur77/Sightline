import { describe, expect, it } from 'vitest';
import { checkFreeText } from '../src/grounding';
import { snapshot, usd } from './helpers';

const harbor = snapshot({
  attributes: { colour: 'Navy', size: 'M', material: '70% cotton, 30% recycled polyester', fit: 'regular' },
  reviews: [{ quote: 'Soft and not itchy at all.', rating: 5 }],
});

describe('checkFreeText: the agent’s own lines are checked against the listings', () => {
  it('passes facts the listing gives', () => {
    expect(checkFreeText({ text: 'Soft cotton, in navy, size M.', snapshots: [harbor] }).supported).toBe(true);
    expect(checkFreeText({ text: 'Reviewers call it “soft and not itchy”.', snapshots: [harbor] }).supported).toBe(true);
    expect(checkFreeText({ text: 'Free returns for 30 days.', snapshots: [harbor] }).supported).toBe(true);
    expect(checkFreeText({ text: 'Warm and easy to layer for hikes.', snapshots: [harbor] }).supported).toBe(true);
  });

  it('flags facts the listing does not give', () => {
    const wool = checkFreeText({ text: 'Warm merino wool.', snapshots: [harbor] });
    expect(wool.supported).toBe(false);
    expect(wool.unsupportedTokens.map((t) => t.value)).toEqual(['merino']);
    expect(checkFreeText({ text: 'Only $25 today.', snapshots: [harbor] }).supported).toBe(false);
    expect(checkFreeText({ text: 'It comes in black too.', snapshots: [harbor] }).supported).toBe(false);
    expect(checkFreeText({ text: 'Reviewers say “the best sweater ever”.', snapshots: [harbor] }).supported).toBe(false);
    expect(checkFreeText({ text: 'Arrives by Friday.', snapshots: [harbor] }).supported).toBe(false);
  });

  it('holds feature claims to the listing’s own words', () => {
    const shell = snapshot({ title: 'Trail shell jacket', description: 'A light shell.', keyFeatures: ['Waterproof membrane', 'Packable hood'] });
    expect(checkFreeText({ text: 'Waterproof and packable for wet trails.', snapshots: [shell] }).supported).toBe(true);
    const r = checkFreeText({ text: 'Waterproof Gore-Tex, machine washable.', snapshots: [harbor] });
    expect(r.unsupportedTokens.filter((t) => t.kind === 'feature').map((t) => t.value)).toEqual(['waterproof', 'gore tex', 'machine washable']);
    // A feature the buyer asked for may be named in a lead, from the buyer's words.
    expect(checkFreeText({ text: 'Here are waterproof picks.', snapshots: [shell], facts: { 'buyer.words': 'something waterproof' } }).supported).toBe(true);
  });

  it('accepts "no wool" only when every listing names its material and none of it is wool', () => {
    const cotton = snapshot({ id: 'c', attributes: { colour: 'Navy', material: '100% cotton' } });
    const merino = snapshot({ id: 'm', attributes: { colour: 'Navy', material: '100% merino wool' } });
    const unknown = snapshot({ id: 'u', attributes: { colour: 'Navy' }, title: 'Crew sweater' });
    expect(checkFreeText({ text: 'All cotton, no wool, in a relaxed fit.', snapshots: [cotton] }).supported).toBe(true);
    expect(checkFreeText({ text: 'Wool-free and soft.', snapshots: [cotton] }).supported).toBe(true);
    // Merino is wool: "no wool" is false for it.
    expect(checkFreeText({ text: 'No wool here.', snapshots: [merino] }).supported).toBe(false);
    // The listing doesn't name a material: absence can't be claimed.
    expect(checkFreeText({ text: 'Without wool.', snapshots: [unknown] }).supported).toBe(false);
    // A lead about several picks holds only if it holds for each.
    expect(checkFreeText({ text: 'Warm picks with no wool.', snapshots: [cotton, merino] }).supported).toBe(false);
    // A positive claim is still a claim.
    expect(checkFreeText({ text: 'Soft wool.', snapshots: [cotton] }).supported).toBe(false);
  });

  it('accepts the buyer’s own budget as a fact', () => {
    expect(checkFreeText({ text: 'Under your $40 budget.', snapshots: [harbor], facts: { 'query.maxPrice': usd(4000) } }).supported).toBe(true);
    expect(checkFreeText({ text: 'Under your $40 budget.', snapshots: [harbor] }).supported).toBe(false);
  });
});
