import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { db } from '@/server/runtime';
import { receiptKeyPair } from '@/server/keys';

/** The evidence manifest as portable JSON, for offline verification with the public key. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const [pack] = await db().select().from(tables.evidencePacks).where(eq(tables.evidencePacks.id, id)).limit(1);
  if (!pack) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { ed25519, ...manifest } = pack.manifest as Record<string, unknown> & { ed25519?: string };
  return NextResponse.json(
    { id: pack.id, manifest, manifestHash: pack.manifestHash, ed25519, publicKey: receiptKeyPair().publicKeyHex },
    { headers: { 'content-disposition': `attachment; filename="evidence-${id}.json"` } },
  );
}
