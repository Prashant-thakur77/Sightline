import 'server-only';
import { desc, sql } from 'drizzle-orm';
import { appendChain } from '@sightline/evidence';
import { tables } from '@sightline/db';
import { db } from './runtime';

export interface AuditInput {
  userId?: string | null;
  actor: 'user' | 'agent' | 'gate' | 'paypal' | 'merchant' | 'system' | 'helper';
  action: string;
  subjectId?: string | null;
  payload: Record<string, unknown>;
}

/**
 * Append to the hash-chained audit log. Serialised with an advisory lock so two writers can
 * never fork the chain.
 */
export async function audit(entry: AuditInput): Promise<{ seq: number; hash: string }> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4242)`);
    const prev = await tx.select({ hash: tables.auditLog.hash }).from(tables.auditLog).orderBy(desc(tables.auditLog.seq)).limit(1);
    const body = {
      userId: entry.userId ?? null,
      actor: entry.actor,
      action: entry.action,
      subjectId: entry.subjectId ?? null,
      payload: entry.payload,
      at: new Date().toISOString(),
    };
    const link = appendChain(prev[0]?.hash ?? null, body);
    const [row] = await tx
      .insert(tables.auditLog)
      .values({
        userId: body.userId,
        actor: body.actor,
        action: body.action,
        subjectId: body.subjectId,
        payload: { ...body.payload, _at: body.at },
        prevHash: link.prevHash,
        hash: link.hash,
      })
      .returning({ seq: tables.auditLog.seq });
    return { seq: row!.seq, hash: link.hash };
  });
}
