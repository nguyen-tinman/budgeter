# Build findings — running log

Brief log of non-obvious things caught during the build. Each entry: what, why it matters, what was done.

## Tax math

### Stale 2025 federal standard deductions (caught by Codex AHS review, BLOCK)
Seeded $15,000 / $30,000 (single / MFJ) from memory; OBBBA (signed mid-2025) retroactively raised them to **$15,750 / $31,500**. Test goldens were computed against the wrong fixture, so the unit tests passed silently. Every user's annual take-home would have been ~$200 off. Fixed in `fixtures.ts` + `001_init.sql` + 4 affected goldens.

### CA Mental Health 1% surcharge threshold (caught by Codex, BLOCK)
Doubled the MFJ threshold to $2M (assumption: "MFJ doubles every threshold"). MHST is on **individual taxable income at $1M regardless of filing status**. Corrected the MFJ CA bracket split to $1M, matching the single filing.

### FICA Social Security wage base (caught by Codex, STRONG-RECOMMEND)
Was 2024's $168,600; should be **2025's $176,100**. Affects only earners above the cap. Corrected.

### Roth/Traditional cent drift (caught by Codex, STRONG-RECOMMEND)
Both retirement lanes rounded independently → `traditional + roth` could differ from `total` by 1c. Switched to round-one-lane-then-residual so the invariant always holds. Added a property test that exercises it every year for 45 years on a deliberately non-clean split (37% Roth, odd contribution).

### Float math inside the "integer-cent" engine (caught by Grok, STRONG-RECOMMEND, partial)
`bracketTax` accumulates `span * b.rate` in IEEE-754 float then rounds once at the end. Sub-cent for tested ranges, but accumulates over chained operations. Fixed in retirement compounding (rounds per year per lane). Deferred in bracket walk — would invalidate every existing golden and isn't a real bug at current scales. Documented for v2.

### Tautological tests (caught by Codex + Grok, STRONG-RECOMMEND)
Test goldens were computed against the same fixture used to seed the DB → a wrong fixture passed silently. Mitigated by adding 14 property tests (monotonicity, cutoff vs cutoff+1 jump ≤ 1c, MFJ filing-symmetric, traditional+roth=total, etc.) that don't depend on specific bracket values. Still flagged: the "single source of truth" between TypeScript fixtures and SQL migration could drift in the future.

## Build / infrastructure

### Path-resolution off-by-one in DB location (caught by direct filesystem inspection)
`defaultDbConfig` resolved repo root as `../../..` from `apps/api/src/db/`; actually 4 levels up. Migration reported success while writing the DB to `apps/data/budgetkit.db` instead of `data/budgetkit.db`. Silent — the migrate command's exit code was 0. Found only because `Get-ChildItem` showed 0 bytes at the expected location. Fixed and committed.

### Gemini AHS subprocess returned non-substantive output
Of the three AHS reviewers on M3, only Codex and Grok returned actual reviews. Gemini's wrapper completed but produced a meta-status message instead of findings. **Implication**: single-reviewer patterns would have missed the BLOCK if I had picked Gemini. The triple-review redundancy is insurance against agent failure, not just blind spots. Worth keeping the fan-out pattern.

### node:sqlite chosen over better-sqlite3
Node 25.x has stable `node:sqlite` built in (since 23). Avoids native-compile complexity on Windows. Synchronous API matches the simpler usage pattern. No deps installed for SQLite; just open and exec.

## Statement parsing

### Chase PDFs parse cleanly (pleasantly surprising)
5 real Chase PDFs → **0 warnings, 0 unparsed lines**, ~30 transactions total. Chase statements are notoriously messy across years; this user's format yields to a simple `MM/DD ... $amount` regex. Caveats: txn counts per statement are modest (3-10/month), so there may be transaction types I haven't seen. M6b ground-truth review will specifically check what the parser silently drops.

### Amex XLSX header row is robust to position drift
Real Amex exports put headers at row 7, but the parser locates the header row by searching the first 30 rows for both "Date" and "Amount" cells. Smoke-test against real Gold (37 txns) and Platinum (50 txns): 0 warnings each.

### Merchant normalization caught my own regex hole
Initial regex `[*#]\d+` stripped numeric suffixes like `*1234`, but missed alphanumeric IDs like `*RT4XY3J` (common in `AMZN MKTP US*RT4XY3J`). Unit test failed on first run; widened to `[*#][a-z0-9]+`. Without this, two appearances of the same merchant would normalize to different strings and the recurring detector would fail to cluster them.

## Process / planning lessons

### Verification-driven framework choice was load-bearing
The original plan picked Flutter desktop. After confirming I can't directly screenshot Flutter desktop windows, switched to localhost web (SvelteKit + Hono). I can now drive every UI screen via Chrome MCP and observe the rendered result without an intermediate. This shifted the whole architecture, but is the only reason "show me a screenshot of the working app" is something I can answer with evidence rather than a promise. Captured in the `planning-around-testability` skill.

### Continuous AHS review > end-of-project review
Running the triple-review at the end of M3 (the math layer) caught real defects before any code that depends on the math was written. Doing this at end of project would have meant rewriting tests + revalidating downstream features that depended on wrong math. Per-milestone cadence is worth its ~2-minute overhead per milestone.

### Personal data discipline held
All statement parsing test output uses counts and aggregates only — no merchant strings, no amounts, no dates with day-precision when the date span could correlate to user identity. `./data/` is git-ignored and the migration anchors there explicitly. Verified by `Get-ChildItem -Recurse "budgetkit.db*"` returning only the expected path.

---

## Items deferred (not bugs, just scope-limited for v1)

- Additional Medicare Tax (0.9% over $200k single / $250k MFJ) — documented omission in `tax_calculator.ts`.
- CA pre-tax health premium uses the federal pre-tax bucket — documented; correct fix needs separate FICA-wages vs income-tax-wages accounting.
- CA Mental Health surcharge modeled as a merged 13.3% bracket vs the statute's parallel 1% surcharge — functionally equivalent for the expected use case.
- $0.01–$0.03 CA cutoff drift from published FTB values — will be overwritten by the `fetch_tax_source` MCP tool (task #21) when the LLM pulls authoritative values.
- Fixture↔migration dual source of truth — long-term, derive fixtures from migration SQL or vice versa.
