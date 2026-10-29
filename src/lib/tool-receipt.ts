/**
 * One events row for a tool write.
 * Pass the transaction's SqlTag so the receipt commits or rolls back with the write.
 * This module does not open its own transaction.
 */
import { currentActor } from "./actor";
import { activityDetail, receiptFromParts, type Receipt } from "./activity";
import type { SqlTag } from "./db";

export async function insertToolReceipt(
  q: SqlTag,
  input: { kind: string; title: string; extra?: Record<string, unknown> },
): Promise<Receipt | null> {
  const detail = JSON.stringify(activityDetail(input.kind, currentActor(), input.extra ?? {}));
  const rows = await q`
    insert into events (agent_id, session_id, kind, title, detail)
    values (null, null, ${input.kind}, ${input.title}, ${detail}::jsonb)
    returning id, kind, created_at
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? receiptFromParts(row.id, row.kind, row.created_at) : null;
}
