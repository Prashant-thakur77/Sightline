import { Conversation } from '@/components/conversation/conversation';
import { requireUser } from '@/server/session';
import { resumeTurn } from '@/server/conductor';

export const metadata = { title: 'Shop' };

export default async function Shop({ searchParams }: { searchParams: Promise<{ hear?: string }> }) {
  const user = await requireUser();
  const { hear } = await searchParams;
  // A reload, or a trip to Orders and back, finds the conversation where it was: the messages, and
  // a readback or options still waiting. Nothing changes here; the greeting turn does that.
  const initial = await resumeTurn(user.id);
  return <Conversation firstName={user.displayName} initial={initial} opening={hear === 'offer' ? 'offer' : undefined} />;
}
