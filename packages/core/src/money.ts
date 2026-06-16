// Money helpers.
// ==============
//
// Monetary values throughout BudgetKit are floating-point DOLLARS (JS numbers),
// NOT integer cents. The product owner explicitly chose float dollars over a
// decimal library, accepting the rounding tradeoff. To keep float drift bounded
// we round to 2 decimal places at every storage + computation boundary:
//   - every monetary value written to the DB,
//   - every computed monetary result returned from a calculator/tool,
//   - every aggregation/sum that could accumulate drift.
//
// `round2` rounds to the nearest cent, breaking ties HALF-AWAY-FROM-ZERO: a
// magnitude-*.xx5 value rounds to the larger magnitude (1.005 → 1.01,
// -1.005 → -1.01). This is symmetric in sign, so negating an amount negates its
// rounded result (round2(-n) === -round2(n)) — the property a money library
// must have, since charges are stored as negative dollars and a charge and its
// equal-and-opposite credit must round to mirror values.
//
// Why not plain Math.round? JS Math.round breaks ties toward +Infinity, so it
// rounds *positive* halves away from zero (0.5 → 1) but *negative* halves
// TOWARD zero (-0.5 → -0, -1.005 → -1.00). That asymmetry would make a $1.005
// charge round to -1.00 while the matching $1.005 credit rounds to +1.01.
//
// Implementation: round the MAGNITUDE half-up, then restore the sign. The
// `+ Number.EPSILON` nudge is applied to the magnitude BEFORE scaling by 100
// (i.e. (|n| + EPSILON) * 100, mirroring the original positive-only formula) so
// it corrects the classic 1.005 → 1.00 binary-representation surprise in BOTH
// sign directions. Applying EPSILON after the *100 scale is too small to matter
// at typical dollar magnitudes and would NOT fix 1.005, so the nudge must stay
// on the unscaled magnitude.

/**
 * Round a dollar amount to 2 decimal places (nearest cent), ties broken
 * half-away-from-zero and symmetric in sign (round2(-n) === -round2(n)).
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return n; // pass NaN/±Infinity through unchanged
  const sign = n < 0 ? -1 : 1;
  const cents = Math.round((Math.abs(n) + Number.EPSILON) * 100);
  // `+ 0` collapses a negative-tiny input's -0 result to canonical +0.
  return (sign * cents) / 100 + 0;
}
