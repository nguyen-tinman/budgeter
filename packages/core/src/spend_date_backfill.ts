// spend_date_backfill.ts — recovers the real spend date for one-time budget
// expenses by matching them back to the originating statement transaction.
//
// One-time expenses catalogued before migration 010 have no spend_date, so the
// Trends chart would otherwise place them by created_at (the IMPORT date), not
// when the money was actually spent. Here we match each such expense to a
// transaction by normalized merchant + nearest amount (only when the amounts
// match to the cent) and recover its posted_date. A merchant match whose
// closest amount is out of tolerance is left NULL so a one-off isn't mis-dated
// to a different same-merchant charge. New catalogues already store spend_date
// directly.

import { normMerchant } from "./trends_calculator.js";
import type { ExpenseRepo, TransactionRepo, WorkspaceRepo } from "./tool_registry.js";

/** A charge transaction, the minimum needed to match a one-time expense. */
export interface SpendDateMatchTxn {
  merchantRaw: string;
  merchantNormalized: string;
  /** ISO date ('YYYY-MM-DD' or datetime); the spend date we recover. */
  postedDate: string;
  /** Signed dollars — charges are negative. */
  amountDollars: number;
}

/** A one-time expense awaiting a spend date. */
export interface OneTimeExpenseLite {
  id: number;
  label: string;
  amountDollars: number;
}

/** Maximum |amount| difference (dollars) between a one-time expense and a
 *  candidate transaction for the match to be accepted. A one-off at a frequent
 *  merchant (e.g. a $512 Costco run among dozens of $40–90 grocery charges)
 *  must not be mis-dated to the nearest-but-wrong charge: we only trust a date
 *  recovered from a charge whose amount matches to the cent (half-cent slack
 *  absorbs float/rounding). Anything further leaves spend_date NULL — surfaced
 *  by computeTrends so the user can set the month manually (B1). */
const AMOUNT_MATCH_TOLERANCE_DOLLARS = 0.005;

/**
 * For each one-time expense, find the matching transaction (by normalized
 * merchant, then nearest amount, tie-broken to the most recent date) and return
 * its posted date as 'YYYY-MM-DD'. A match is accepted ONLY when the nearest
 * candidate's |amount| is within AMOUNT_MATCH_TOLERANCE_DOLLARS of the expense;
 * a merchant match whose closest amount is further off is treated as no match
 * (the date stays NULL rather than risk mis-dating). Expenses with no matching
 * transaction — or none within tolerance — are omitted (e.g. manual entries
 * with no statement source, or a one-off amongst many same-merchant charges).
 */
export function resolveOneTimeSpendDates(
  expenses: OneTimeExpenseLite[],
  txns: SpendDateMatchTxn[],
): Array<{ id: number; spendDate: string }> {
  // Index charges by normalized merchant, under BOTH the normalized and raw
  // merchant forms so a label written from either side still matches.
  const byKey = new Map<string, Array<{ postedDate: string; amount: number }>>();
  const add = (key: string, postedDate: string, amount: number): void => {
    if (!key) return;
    let arr = byKey.get(key);
    if (!arr) { arr = []; byKey.set(key, arr); }
    arr.push({ postedDate, amount });
  };
  for (const t of txns) {
    const amount = Math.abs(t.amountDollars);
    const nk = normMerchant(t.merchantNormalized);
    const rk = normMerchant(t.merchantRaw);
    add(nk, t.postedDate, amount);
    if (rk && rk !== nk) add(rk, t.postedDate, amount);
  }

  const out: Array<{ id: number; spendDate: string }> = [];
  for (const e of expenses) {
    const cands = byKey.get(normMerchant(e.label));
    if (!cands || cands.length === 0) continue;
    let best = cands[0]!;
    let bestDelta = Math.abs(best.amount - e.amountDollars);
    for (const c of cands) {
      const delta = Math.abs(c.amount - e.amountDollars);
      if (delta < bestDelta || (delta === bestDelta && c.postedDate > best.postedDate)) {
        best = c;
        bestDelta = delta;
      }
    }
    // Amount gate: a merchant match is only trustworthy if the closest charge
    // amount is within tolerance. Otherwise leave it unmatched (spend_date NULL,
    // user-fixable) rather than mis-date the row to a different same-merchant
    // charge.
    if (bestDelta > AMOUNT_MATCH_TOLERANCE_DOLLARS) continue;
    out.push({ id: e.id, spendDate: best.postedDate.slice(0, 10) });
  }
  return out;
}

/** The slice of the tool context this backfill needs. */
export interface SpendDateBackfillCtx {
  workspaces: Pick<WorkspaceRepo, "list">;
  expenses: Pick<ExpenseRepo, "list" | "update">;
  transactions: Pick<TransactionRepo, "listChargeRows">;
}

/** One row changed by a backfill pass — for the API boot log / audit trail. */
export interface BackfillChange {
  id: number;
  /** The expense label (merchant); kept out of info-level logs for privacy. */
  label?: string;
  /** The recovered spend date, 'YYYY-MM-DD'. */
  spendDate: string;
}

/** The result of a backfill pass. `changed` lists the rows actually updated so
 *  the caller can log/audit which expenses were touched (boot-time writes to
 *  the live DB were previously untraceable). `matched === changed.length`. */
export interface BackfillResult {
  scanned: number;
  matched: number;
  changed: BackfillChange[];
}

/**
 * Backfill spend_date for every one-time expense that lacks one, across all
 * workspaces, from the matching statement transaction. Idempotent: it only
 * touches rows where spend_date IS NULL and never overwrites a user-set date.
 * Skips the (potentially large) transaction fetch entirely when nothing needs
 * backfilling. Returns how many one-time rows were scanned vs. matched, plus
 * the details of each changed row ({ id, label?, spendDate }) so the caller can
 * record an audit trail of what this pass wrote.
 */
export function backfillOneTimeSpendDates(ctx: SpendDateBackfillCtx): BackfillResult {
  const pending: OneTimeExpenseLite[] = [];
  for (const ws of ctx.workspaces.list()) {
    for (const e of ctx.expenses.list(ws.id)) {
      if (e.frequency === "one_time" && e.spendDate == null) {
        pending.push({ id: e.id, label: e.label, amountDollars: e.amountDollars });
      }
    }
  }
  if (pending.length === 0) return { scanned: 0, matched: 0, changed: [] };

  const labelById = new Map(pending.map((p) => [p.id, p.label]));
  const resolved = resolveOneTimeSpendDates(pending, ctx.transactions.listChargeRows());
  const changed: BackfillChange[] = [];
  for (const r of resolved) {
    ctx.expenses.update({ id: r.id, spendDate: r.spendDate });
    changed.push({ id: r.id, label: labelById.get(r.id), spendDate: r.spendDate });
  }
  return { scanned: pending.length, matched: resolved.length, changed };
}
