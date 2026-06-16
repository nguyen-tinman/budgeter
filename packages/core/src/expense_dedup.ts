// expense_dedup.ts — duplicate identity for budget items (expenses).
//
// Two consumers:
//  1. catalogue_expenses (commit path) — an accepted candidate whose
//     (label, amount, frequency, spend date) already exists in the target
//     workspace is SKIPPED and reported, so re-importing an overlapping
//     statement can't double-book the budget.
//  2. dedupe_expenses — finds groups of identical rows already in the DB
//     and (outside dry-run) removes all but the oldest of each group.
//
// Identity = normalized label + amount (2dp) + frequency + spend date.
// Label matching is whitespace-collapsed and case-insensitive — enough to
// catch the same import twice without merging genuinely distinct items.
// spendDate participates so two one-time purchases at the same merchant on
// DIFFERENT dates are NOT duplicates; null matches null (recurring rows).

export interface DedupableExpense {
  id: number;
  label: string;
  amountDollars: number;
  frequency: string;
  spendDate?: string | null;
}

export function expenseDupKey(e: {
  label: string;
  amountDollars: number;
  frequency: string;
  spendDate?: string | null;
}): string {
  const label = e.label.trim().replace(/\s+/g, " ").toLowerCase();
  return [label, e.amountDollars.toFixed(2), e.frequency, e.spendDate ?? ""].join("|");
}

export interface DuplicateGroup {
  /** Representative fields of the duplicated item (from the kept row). */
  label: string;
  amountDollars: number;
  frequency: string;
  spendDate: string | null;
  /** The row that survives (lowest id = oldest). */
  keepId: number;
  /** The redundant rows (everything else in the group). */
  removeIds: number[];
}

/** Group identical expenses; only groups with 2+ members are returned. */
export function findDuplicateGroups(expenses: DedupableExpense[]): DuplicateGroup[] {
  const byKey = new Map<string, DedupableExpense[]>();
  for (const e of expenses) {
    const k = expenseDupKey(e);
    const arr = byKey.get(k);
    if (arr) arr.push(e);
    else byKey.set(k, [e]);
  }
  const groups: DuplicateGroup[] = [];
  for (const members of byKey.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => a.id - b.id);
    const keep = sorted[0]!;
    groups.push({
      label: keep.label,
      amountDollars: keep.amountDollars,
      frequency: keep.frequency,
      spendDate: keep.spendDate ?? null,
      keepId: keep.id,
      removeIds: sorted.slice(1).map((e) => e.id),
    });
  }
  // Stable order for UI/tests: by label then amount.
  return groups.sort(
    (a, b) => a.label.localeCompare(b.label) || a.amountDollars - b.amountDollars,
  );
}
