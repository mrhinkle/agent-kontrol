/**
 * One events row for a tool write.
 * Pass the transaction's SqlTag so the receipt commits or rolls back with the write.
 * This module does not open its own transaction.
 *
 * The insert must return exactly one usable receipt. An empty RETURNING
 * (a BEFORE INSERT trigger that returns NULL) or a row this process cannot
 * read as the requested event throws, so the caller's transaction rolls back.
 */
import { currentActor } from "./actor";
import { activityDetail, receiptFromParts, type Receipt } from "./activity";
import type { SqlTag } from "./db";

export class ToolReceiptError extends Error {
  constructor() {
    super("tool receipt was not stored");
    this.name = "ToolReceiptError";
  }
}

export async function insertToolReceipt(
  q: SqlTag,
  input: { kind: string; title: string; extra?: Record<string, unknown> },
): Promise<Receipt> {
  const detail = JSON.stringify(activityDetail(input.kind, currentActor(), input.extra ?? {}));
  const rows = await q`
    insert into events (agent_id, session_id, kind, title, detail)
    values (null, null, ${input.kind}, ${input.title}, ${detail}::jsonb)
    returning id, kind, created_at
  `;
  const row = rows.length === 1 ? rows[0] as Record<string, unknown> : undefined;
  const receipt = row ? receiptFromParts(row.id, row.kind, row.created_at) : null;
  if (!receipt || receipt.kind !== input.kind) throw new ToolReceiptError();
  return receipt;
}
