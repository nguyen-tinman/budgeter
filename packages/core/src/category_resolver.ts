// Rule-based merchant→category resolver for Chase transactions.
//
// Background: Amex statements include a `Category` column per row, so its
// transactions arrive with `categoryHint` already populated. Chase PDFs do
// NOT — every Chase txn lands with no category and gets collapsed into the
// "Uncategorized" baseline bucket by `rollByCategory()`. That makes the
// per-category baselines under-report real spend whenever Chase is the
// dominant card.
//
// This resolver is the cheapest meaningful fix: a small lowercase-substring
// rule table keyed by merchant. Pass it as `categoryResolver` to
// `rollByCategory()` and any Chase txn whose normalized merchant contains
// one of the known tokens gets bucketed into the matching category.
//
// Rules deliberately use substring matching against `merchantNormalized` (which
// is already lowercase and has store IDs / state suffixes stripped). The
// ordering matters: the first matching rule wins, so put more-specific rules
// before broader fallbacks (e.g. "amex" → Subscriptions before "ex" matches
// anything else).
//
// Every returned category NAME must exist in the canonical budget
// `categories` table (migrations/008) because the cataloguer and add_expense
// look the id up BY NAME — exact case matters. The catch-all is
// "Discretionary" (the budget set has no "Other").

import type { RawTxn } from "./statement_parser.js";

/** A category name and the substring tokens that route a merchant to it. */
interface CategoryRule {
  category: string;
  tokens: string[];
}

// Rule order = priority. Earlier rules win on a tie. Tokens are matched as
// case-insensitive substrings of `merchantNormalized` (which is itself
// already lowercase). Use single-word tokens unless a phrase is needed to
// disambiguate (e.g. "in n out", "raising canes").
const RULES: CategoryRule[] = [
  {
    // Gas stations → Transport (budget set has no separate "Gas").
    category: "Transport",
    tokens: ["shell", "chevron", " 76 ", "exxon", "mobil", "arco"],
  },
  {
    // Groceries + restaurants both roll up to the budget "Food" category.
    category: "Food",
    tokens: [
      "sams club",
      "costco wholesale",
      "vons",
      "ralphs",
      "trader joe",
      "whole foods",
      "sprouts",
      "h mart",
      "kroger",
      "in n out",
      "mcdonald",
      "chipotle",
      "starbucks",
      "panda express",
      "kfc",
      "taco bell",
      "wendy",
      "jack in the box",
      "popeyes",
      "raising canes",
      "chick fil a",
    ],
  },
  {
    category: "Utilities",
    tokens: ["spectrum", "pge", "sce", "socal gas"],
  },
  {
    // Real-estate / property management → Housing.
    category: "Housing",
    tokens: ["real est", "property management"],
  },
  {
    category: "Subscriptions",
    tokens: [
      "netflix",
      "hulu",
      "disney plus",
      "spotify",
      "youtube",
      "apple",
      "google one",
    ],
  },
];

/**
 * Categorize a transaction by its normalized merchant. Returns the matched
 * category name or `undefined` if no rule fits.
 *
 * Implementation notes:
 *   - " 76 " (with leading + trailing spaces) is used for the "76" gas
 *     station to avoid matching tokens that happen to contain "76" as a
 *     digit run inside other merchant names. The merchant is normalized
 *     before checking; we also probe the leading/trailing-edge cases by
 *     wrapping in spaces.
 *   - "apple" matches all of "apple.com/bill", "apple music", etc — these
 *     are nearly always subscriptions in the personal-finance domain. If
 *     the user wants to disambiguate Apple Store hardware from subs, they
 *     can override the category in the review queue.
 */
/**
 * Resolves a merchant to a category. ALWAYS returns a non-empty string —
 * either a known rule-matched category or the catch-all "Discretionary". The
 * caller can then look up the corresponding category_id via the seeded
 * `categories` table, which is guaranteed to contain a "Discretionary" row
 * (migrations/008_categories_budget_set.sql). This makes the byCat totals on
 * the Dashboard sum cleanly to the full expense total: every expense lands
 * in exactly one bucket.
 */
export function defaultMerchantCategorizer(txn: RawTxn): string {
  const m = txn.merchantNormalized;
  if (!m) return "Discretionary";
  // Add boundary padding so single-word rules like "shell" don't have to be
  // anchored manually. For tokens containing leading/trailing spaces (e.g.
  // " 76 ") the boundary check happens naturally.
  const padded = ` ${m} `;
  for (const rule of RULES) {
    for (const t of rule.tokens) {
      if (t.startsWith(" ") || t.endsWith(" ")) {
        // Phrase / boundary-sensitive token: match against the padded form.
        if (padded.includes(t)) return rule.category;
      } else if (m.includes(t)) {
        return rule.category;
      }
    }
  }
  // Fallback: every expense gets a category, even if no rule matched.
  // "Discretionary" exists in the canonical budget categories table.
  return "Discretionary";
}
