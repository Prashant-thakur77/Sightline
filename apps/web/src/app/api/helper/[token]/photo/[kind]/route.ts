import { getBlob } from '@/server/blobs';
import { resolveHelperToken } from '@/server/helper';

/** Photos for the helper, only through a valid, unexpired helper link. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string; kind: string }> }) {
  const { token, kind } = await ctx.params;
  const r = await resolveHelperToken(decodeURIComponent(token));
  const p = r?.photos.find((x) => x.kind === kind);
  const b = p ? await getBlob(p.blobId) : null;
  if (!b) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(b.bytes), { headers: { 'content-type': b.mime, 'cache-control': 'private, no-store' } });
}
