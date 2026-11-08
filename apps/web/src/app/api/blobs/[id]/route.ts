import { getBlob } from '@/server/blobs';
import { currentUser } from '@/server/session';

/** Photos are only served to the buyer who took them (helpers use a signed helper link instead). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  const b = user ? await getBlob(id) : null;
  if (!b || b.ownerId !== user!.id) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(b.bytes), { headers: { 'content-type': b.mime, 'cache-control': 'private, max-age=3600' } });
}
