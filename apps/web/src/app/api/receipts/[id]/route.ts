import { NextResponse } from 'next/server';
import { loadReceipt } from '@/server/receipts';

/** The receipt as portable JSON, for offline verification with the public key. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await loadReceipt(id);
  if (!r) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(
    { id: r.receipt.id, kind: r.receipt.kind, body: r.receipt.body, hash: r.receipt.hash, ed25519: r.receipt.ed25519, publicKey: r.check.publicKey },
    { headers: { 'content-disposition': `attachment; filename="receipt-${id}.json"` } },
  );
}
