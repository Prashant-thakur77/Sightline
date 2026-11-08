import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_FILE,
  EVIDENCE_MANIFEST,
  buildManifest,
  hashDomain,
  hashEvidenceFile,
  hashObject,
  verifyManifest,
  type BuildManifestInput,
} from '../src';
import { readback, snapshot, verdict } from './fixtures';

const front = new TextEncoder().encode('front photo bytes');
const label = new TextEncoder().encode('label photo bytes');

function input(): BuildManifestInput {
  return {
    order: {
      id: 'ord_1',
      paypalOrderId: '5O190127TN364715T',
      status: 'verified_mismatch',
      amount: { cents: 3672, currency: 'USD' },
      payee: { merchantId: 'MERCHANT1', name: 'Demo Store' },
      placedAt: '2026-11-09T10:02:00.000Z',
    },
    readback: readback(),
    snapshot: snapshot(),
    photos: [
      { name: 'front.jpg', mime: 'image/jpeg', takenAt: '2026-11-12T09:00:00.000Z', bytes: front },
      { name: 'label.jpg', mime: 'image/jpeg', takenAt: '2026-11-12T09:01:00.000Z', sha256: hashEvidenceFile(label) },
    ],
    verification: verdict,
    narrative: 'I ordered a navy shirt. A black shirt arrived.',
  };
}

const allFiles = [
  { name: 'front.jpg', bytes: front },
  { name: 'label.jpg', bytes: label },
];

describe('evidence manifest', () => {
  it('gives each file its own EVIDENCE_FILE hash and hashes the whole manifest', () => {
    const { manifest, manifestHash } = buildManifest(input());
    expect(manifest.files[0]).toEqual({
      name: 'front.jpg',
      mime: 'image/jpeg',
      takenAt: '2026-11-12T09:00:00.000Z',
      hash: hashDomain(EVIDENCE_FILE, front),
      size: front.length,
    });
    expect(manifest.files[1]!.hash).toBe(hashDomain(EVIDENCE_FILE, label));
    expect(manifestHash).toBe(hashObject(EVIDENCE_MANIFEST, manifest));
  });

  it('is deterministic', () => {
    expect(buildManifest(input()).manifestHash).toBe(buildManifest(input()).manifestHash);
  });

  it('verifies an intact pack with all its files', () => {
    expect(verifyManifest(buildManifest(input()), allFiles)).toMatchObject({ ok: true, problems: [], filesChecked: 2 });
  });

  it('detects an edited narrative, verdict or order amount', () => {
    const built = buildManifest(input());
    for (const edit of [
      { narrative: 'Everything was fine.' },
      { verification: { ...verdict, kind: 'match' } },
      { order: { ...built.manifest.order, amount: { cents: 1, currency: 'USD' } } },
    ]) {
      const tampered = { ...built, manifest: { ...built.manifest, ...edit } };
      expect(verifyManifest(tampered).problems).toContain('manifest_hash_mismatch');
    }
  });

  it('detects swapped file bytes and names the file', () => {
    const built = buildManifest(input());
    const result = verifyManifest(built, [
      { name: 'front.jpg', bytes: new TextEncoder().encode('a different photo') },
      { name: 'label.jpg', bytes: label },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['file_hash_mismatch:front.jpg']);
  });

  it('detects an edited file hash in the manifest', () => {
    const built = buildManifest(input());
    const files = built.manifest.files.map((f, i) => (i === 1 ? { ...f, hash: hashEvidenceFile(front) } : f));
    const result = verifyManifest({ ...built, manifest: { ...built.manifest, files } }, allFiles);
    expect(result.problems).toEqual(['manifest_hash_mismatch', 'file_hash_mismatch:label.jpg']);
  });

  it('detects an edited snapshot price even if the manifest hash is recomputed', () => {
    const built = buildManifest(input());
    const manifest = { ...built.manifest, snapshot: { ...built.manifest.snapshot, price: { cents: 100, currency: 'USD' } } };
    const result = verifyManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['snapshot_hash_mismatch']);
  });

  it('detects an edited readback text', () => {
    const built = buildManifest(input());
    const manifest = { ...built.manifest, readback: { ...built.manifest.readback, text: 'Total $3.67.' } };
    expect(verifyManifest(manifest).problems).toEqual(['readback_text_hash_mismatch']);
  });

  it('flags files that are not in the manifest', () => {
    expect(verifyManifest(buildManifest(input()), [{ name: 'extra.jpg', bytes: front }]).problems).toEqual([
      'unknown_file:extra.jpg',
    ]);
  });

  it('refuses to build from inconsistent inputs', () => {
    const bad = input();
    expect(() => buildManifest({ ...bad, snapshot: { ...bad.snapshot, title: 'Edited' } })).toThrow(/Snapshot hash/);
    expect(() => buildManifest({ ...bad, readback: { ...bad.readback, text: 'edited' } })).toThrow(/Readback/);
    expect(() => buildManifest({ ...bad, photos: [bad.photos[0]!, bad.photos[0]!] })).toThrow(/Duplicate/);
    expect(() =>
      buildManifest({ ...bad, photos: [{ name: 'x.jpg', mime: 'image/jpeg', takenAt: '2026-11-12T09:00:00Z' }] }),
    ).toThrow(/bytes or a hex SHA-256/);
    expect(() =>
      buildManifest({
        ...bad,
        photos: [{ name: 'x.jpg', mime: 'image/jpeg', takenAt: '2026-11-12T09:00:00Z', bytes: front, sha256: hashEvidenceFile(label) }],
      }),
    ).toThrow(/do not match/);
  });
});
