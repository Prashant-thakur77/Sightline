import { Conversation } from '@/components/conversation/conversation';
import { requireUser } from '@/server/session';

export const metadata = { title: 'Shop' };

export default async function Shop() {
  const user = await requireUser();
  return <Conversation firstName={user.displayName} />;
}
