import type { UsageFact } from "./usage-types";

/** Stable idempotency key — must match collector + unique(idempotency_key). */
export function usageIdempotentKey(f: Pick<
  UsageFact,
  | "source"
  | "account_id"
  | "profile"
  | "session_id"
  | "model"
  | "billing_provider"
  | "billing_mode"
  | "task"
>): string {
  return [
    f.source,
    f.account_id,
    f.profile ?? "",
    f.session_id ?? "",
    f.model,
    f.billing_provider ?? "",
    f.billing_mode ?? "",
    f.task ?? "",
  ].join("|");
}
