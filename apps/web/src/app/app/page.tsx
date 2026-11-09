import { Conversation } from '@/components/conversation/conversation';
import { requireUser } from '@/server/session';

export const metadata = { title: 'Shop' };

export default async function Shop({ searchParams }: { searchParams: Promise<{ hear?: string }> }) {
  const user = await requireUser();
  const { hear } = await searchParams;
  return <Conversation firstName={user.displayName} opening={hear === 'offer' ? 'offer' : undefined} />;
}
