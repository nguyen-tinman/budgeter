// Train F — tax data pipeline (F4).
//
// Covers the three new tools end to end against a REAL temp DB (the same
// harness pattern as tools.test.ts) with a MOCKED web fetcher (no live IRS /
// FTB calls — every fetch returns a canned page):
//   - list_tax_tables: reflects the seeded rows; reflects a freshly-imported row.
//   - predictTaxSourceUrl: the shipped URL patterns + failure modes.
//   - fetch_tax_source_by_year: prediction → mocked fetch → excerpt; the
//     year-sanity guard; urlOverride.
//   - end-to-end: mocked page → assistant-shaped payload → import_tax_table
//     (dryRun preview, then live write) → list_tax_tables shows the new row
//     with its source_url written through ctx.tax.upsertTable.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ToolRegistry,
  ALL_TOOLS,
  predictTaxSourceUrl,
  reduceTaxPageText,
  type ToolCtx,
  type WebRepo,
} from "@budgetkit/core";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-taxpipe-test-"));
  process.env.BUDGETKIT_DB = join(tmpRoot, "test.db");
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(async () => {
  const { closeDb, defaultDbConfig } = await import("@budgetkit/db");
  closeDb();
  const cfg = defaultDbConfig();
  rmSync(cfg.path, { force: true });
  for (const side of ["-wal", "-shm"]) rmSync(`${cfg.path}${side}`, { force: true });
});

const registry = new ToolRegistry(ALL_TOOLS);

/** Build a real-DB ctx with a caller-supplied mock web fetcher. */
async function freshCtx(web?: WebRepo): Promise<ToolCtx> {
  const { openDb, migrate, buildToolCtx } = await import("@budgetkit/db");
  const db = openDb();
  migrate(db);
  return buildToolCtx(db, "api_direct", web ? { web } : {});
}

/** A canned IRS-style page mentioning the given year + a bracket schedule. */
function fakeIrsPage(year: number): string {
  return `
    <html><body>
    <h1>IRS provides tax inflation adjustments for tax year ${year}</h1>
    <p>For tax year ${year}, the standard deduction for single filers is $15,750.</p>
    <table>
      <tr><td>10%</td><td>Up to $11,925</td></tr>
      <tr><td>12%</td><td>$11,926 to $48,475</td></tr>
      <tr><td>37%</td><td>Over $626,350</td></tr>
    </table>
    <nav>Home About Contact Privacy</nav>
    </body></html>`;
}

// ---------------------------------------------------------------------------
// F2 — URL prediction (pure function; documents the shipped patterns).
// ---------------------------------------------------------------------------

describe("F2 predictTaxSourceUrl", () => {
  it("predicts the IRS newsroom slug for a given year", () => {
    expect(predictTaxSourceUrl("irs", 2025)).toBe(
      "https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-2025",
    );
    // Future years are PREDICTED on the same pattern.
    expect(predictTaxSourceUrl("irs", 2027)).toBe(
      "https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-2027",
    );
  });

  it("predicts the stable (non-year-suffixed) FTB tax-rates page", () => {
    expect(predictTaxSourceUrl("ca_ftb", 2025)).toBe(
      "https://www.ftb.ca.gov/file/personal/tax-rates.html",
    );
    // Year does not appear in the FTB URL (validated against page text instead).
    expect(predictTaxSourceUrl("ca_ftb", 2030)).toBe(
      "https://www.ftb.ca.gov/file/personal/tax-rates.html",
    );
  });

  it("only emits allowlisted hosts (www.irs.gov / www.ftb.ca.gov)", () => {
    expect(new URL(predictTaxSourceUrl("irs", 2025)).hostname).toBe("www.irs.gov");
    expect(new URL(predictTaxSourceUrl("ca_ftb", 2025)).hostname).toBe("www.ftb.ca.gov");
  });
});

describe("F2 reduceTaxPageText", () => {
  it("keeps bracket/deduction-relevant lines and caps length", () => {
    // Enough keyword-bearing content (> 200 chars) that the filtered excerpt
    // stands on its own and the raw-head fallback does not engage — so we can
    // assert that pure-boilerplate lines are actually dropped.
    const text =
      "Welcome to our official site and thank you for visiting our newsroom page today\n" +
      "The standard deduction for single filers is $15,750 for the current tax year\n" +
      "The 10% marginal tax rate applies to taxable income up to $11,925 for single filers\n" +
      "The 12% marginal tax rate applies to taxable income from $11,926 to $48,475\n" +
      "Site map | Privacy policy | Careers at our agency | Newsroom archive index here\n" +
      "The 37% marginal tax rate applies to taxable income over $626,350 for single filers";
    const out = reduceTaxPageText(text, 25_000);
    expect(out).toMatch(/standard deduction/);
    expect(out).toMatch(/10%/);
    expect(out).toMatch(/37%/);
    // Pure boilerplate nav line (no tax-schedule keywords) is dropped.
    expect(out).not.toMatch(/Careers/);
  });

  it("falls back to raw head when keyword filtering finds nothing", () => {
    const text = "alpha beta gamma delta ".repeat(50);
    const out = reduceTaxPageText(text, 25_000);
    expect(out.length).toBeGreaterThan(0);
  });

  it("caps the excerpt to the requested maximum", () => {
    const text = Array.from({ length: 5000 }, () => "10% rate $1,000 bracket").join("\n");
    const out = reduceTaxPageText(text, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
  });
});

// ---------------------------------------------------------------------------
// F1 — list_tax_tables reflects real DB rows.
// ---------------------------------------------------------------------------

describe("F1 list_tax_tables", () => {
  it("returns exactly the seeded (2025 × {federal,ca} × {single,mfj}) combos", async () => {
    const ctx = await freshCtx();
    const out = (await registry.invoke("list_tax_tables", {}, ctx)) as {
      tables: Array<{ year: number; jurisdiction: string; filing: string; brackets: unknown[] }>;
      years: number[];
    };
    expect(out.years).toEqual([2025]);
    expect(out.tables).toHaveLength(4);
    const combos = out.tables.map((t) => `${t.year}/${t.jurisdiction}/${t.filing}`).sort();
    expect(combos).toEqual([
      "2025/ca/mfj",
      "2025/ca/single",
      "2025/federal/mfj",
      "2025/federal/single",
    ]);
    // Brackets render from the DB row (not a hardcoded copy).
    const fedSingle = out.tables.find((t) => t.jurisdiction === "federal" && t.filing === "single")!;
    expect(fedSingle.brackets.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// F2 — fetch_tax_source_by_year against a mocked fetcher.
// ---------------------------------------------------------------------------

describe("F2 fetch_tax_source_by_year", () => {
  it("predicts the URL, fetches it, and returns a reduced excerpt mentioning the year", async () => {
    let fetchedUrl = "";
    const web: WebRepo = {
      fetch: async (url) => {
        fetchedUrl = url;
        return { status: 200, body: fakeIrsPage(2025), truncated: false, finalUrl: url };
      },
    };
    const ctx = await freshCtx(web);
    const out = (await registry.invoke(
      "fetch_tax_source_by_year",
      { source: "irs", year: 2025 },
      ctx,
    )) as { url: string; fetchedAt: string; textExcerpt?: string; error?: string };
    expect(fetchedUrl).toBe(
      "https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-2025",
    );
    expect(out.error).toBeUndefined();
    expect(out.textExcerpt).toBeDefined();
    expect(out.textExcerpt).toMatch(/standard deduction/i);
    expect(out.textExcerpt).toMatch(/2025/);
    expect(out.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns a structured error (not a throw) when the page does not mention the requested year", async () => {
    const web: WebRepo = {
      // Page is for 2024 but we ask for 2025 — the year-sanity guard trips.
      fetch: async (url) => ({ status: 200, body: fakeIrsPage(2024), truncated: false, finalUrl: url }),
    };
    const ctx = await freshCtx(web);
    const out = (await registry.invoke(
      "fetch_tax_source_by_year",
      { source: "irs", year: 2025 },
      ctx,
    )) as { error?: string; hint?: string; textExcerpt?: string };
    expect(out.error).toMatch(/does not mention the year 2025/);
    expect(out.hint).toMatch(/urlOverride/);
    expect(out.textExcerpt).toBeUndefined();
  });

  it("returns a structured error on an HTTP 4xx, inviting urlOverride", async () => {
    const web: WebRepo = {
      fetch: async (url) => ({ status: 404, body: "Not found", truncated: false, finalUrl: url }),
    };
    const ctx = await freshCtx(web);
    const out = (await registry.invoke(
      "fetch_tax_source_by_year",
      { source: "irs", year: 2026 },
      ctx,
    )) as { error?: string; hint?: string };
    expect(out.error).toMatch(/HTTP 404/);
    expect(out.hint).toMatch(/urlOverride|releases/i);
  });

  it("honors urlOverride instead of the predicted URL", async () => {
    let fetchedUrl = "";
    const override = "https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2025";
    const web: WebRepo = {
      fetch: async (url) => {
        fetchedUrl = url;
        return { status: 200, body: fakeIrsPage(2025), truncated: false, finalUrl: url };
      },
    };
    const ctx = await freshCtx(web);
    await registry.invoke(
      "fetch_tax_source_by_year",
      { source: "irs", year: 2025, urlOverride: override },
      ctx,
    );
    expect(fetchedUrl).toBe(override);
  });

  it("FIX 3: rejects a page whose ONLY mention of the year is a footer (guard runs on the excerpt)", async () => {
    // Bracket/deduction keyword lines (none containing "2025") plus a footer
    // line that DOES contain 2025 but no tax-schedule keywords. The reducer
    // drops the footer, so the excerpt lacks the year while the raw body has
    // it — the old raw-body check false-accepted this page; the excerpt-based
    // guard must reject it with the recoverable "outside the rate-table
    // content" error.
    const footerOnlyYearPage =
      "The standard deduction for joint filers in the relevant period is $31,500\n" +
      "The 10% marginal rate applies to taxable income up to $23,850\n" +
      "The 22% marginal rate applies to taxable income between $96,951 and $206,700\n" +
      "The 35% marginal rate applies to taxable income between $501,051 and $751,600\n" +
      "The 37% marginal rate applies to taxable income over $751,600\n" +
      "© 2025 Internal Revenue Service. All rights reserved.";
    const web: WebRepo = {
      fetch: async (url) => ({ status: 200, body: footerOnlyYearPage, truncated: false, finalUrl: url }),
    };
    const ctx = await freshCtx(web);
    const out = (await registry.invoke(
      "fetch_tax_source_by_year",
      { source: "irs", year: 2025 },
      ctx,
    )) as { error?: string; hint?: string; textExcerpt?: string };
    expect(out.textExcerpt).toBeUndefined();
    expect(out.error).toMatch(/outside the rate-table content/);
    expect(out.hint).toMatch(/urlOverride/);
  });

  it("FIX 3: still accepts when the year appears inside the rate-table content", async () => {
    // Same shape as the footer page but the year ALSO appears in a
    // keyword-bearing line — the excerpt carries it, so the fetch succeeds.
    const yearInContentPage =
      "For tax year 2025 the standard deduction for joint filers is $31,500\n" +
      "The 10% marginal rate applies to taxable income up to $23,850\n" +
      "The 22% marginal rate applies to taxable income between $96,951 and $206,700\n" +
      "The 37% marginal rate applies to taxable income over $751,600\n" +
      "© 2025 Internal Revenue Service. All rights reserved.";
    const web: WebRepo = {
      fetch: async (url) => ({ status: 200, body: yearInContentPage, truncated: false, finalUrl: url }),
    };
    const ctx = await freshCtx(web);
    const out = (await registry.invoke(
      "fetch_tax_source_by_year",
      { source: "irs", year: 2025 },
      ctx,
    )) as { error?: string; textExcerpt?: string };
    expect(out.error).toBeUndefined();
    expect(out.textExcerpt).toMatch(/2025/);
    expect(out.textExcerpt).toMatch(/standard deduction/);
  });

  it("surfaces a fetcher allowlist rejection as a structured error", async () => {
    const web: WebRepo = {
      fetch: async () => {
        throw new Error("Host evil.example.com not on allowlist");
      },
    };
    const ctx = await freshCtx(web);
    const out = (await registry.invoke(
      "fetch_tax_source_by_year",
      { source: "irs", year: 2025, urlOverride: "https://evil.example.com/x" },
      ctx,
    )) as { error?: string; hint?: string };
    expect(out.error).toMatch(/fetch failed/);
    expect(out.hint).toMatch(/urlOverride/);
  });
});

// ---------------------------------------------------------------------------
// F3/F4 — end-to-end: mocked page → assistant-shaped payload → import_tax_table.
// ---------------------------------------------------------------------------

describe("F3/F4 import_tax_table end-to-end", () => {
  /** The assistant-shaped payload it would produce from the fetched page. */
  const payload = {
    year: 2026,
    jurisdiction: "federal" as const,
    filing: "single" as const,
    standardDeductionDollars: 16100,
    brackets: [
      { upTo: 12000, rate: 0.1 },
      { upTo: 49000, rate: 0.12 },
      { rate: 0.37 }, // top bracket: upTo omitted
    ],
    sourceUrl: "https://www.irs.gov/newsroom/irs-provides-tax-inflation-adjustments-for-tax-year-2026",
  };

  it("dryRun previews WITHOUT writing; live write persists and list_tax_tables reflects it", async () => {
    const ctx = await freshCtx();

    // 1. Preview (dryRun) — validates + echoes, does NOT write.
    const preview = (await registry.invoke(
      "import_tax_table",
      { ...payload, dryRun: true },
      ctx,
    )) as { saved: boolean; dryRun: boolean; brackets: Array<{ upTo: number | null }> };
    expect(preview.saved).toBe(false);
    expect(preview.dryRun).toBe(true);
    expect(preview.brackets[preview.brackets.length - 1]!.upTo).toBeNull(); // normalized

    // Not yet in the DB.
    let listed = (await registry.invoke("list_tax_tables", {}, ctx)) as {
      tables: Array<{ year: number }>;
    };
    expect(listed.tables.some((t) => t.year === 2026)).toBe(false);

    // 2. Live write.
    const written = (await registry.invoke("import_tax_table", payload, ctx)) as {
      saved: boolean;
      dryRun: boolean;
    };
    expect(written.saved).toBe(true);
    expect(written.dryRun).toBe(false);

    // 3. list_tax_tables now shows the new row; the row read back from the DB
    //    has the brackets we wrote.
    listed = (await registry.invoke("list_tax_tables", {}, ctx)) as {
      tables: Array<{ year: number; jurisdiction: string; filing: string; brackets: unknown[] }>;
      years: number[];
    };
    expect(listed.years).toContain(2026);
    const row = listed.tables.find(
      (t) => t.year === 2026 && t.jurisdiction === "federal" && t.filing === "single",
    );
    expect(row).toBeDefined();
    expect(row!.brackets).toHaveLength(3);

    // 4. The source_url we passed is stored (read directly via the repo since
    //    list_tax_tables can't surface it through the current accessor).
    const dbRows = ctx.tax.tables(2026);
    expect(dbRows.some((r) => r.jurisdiction === "federal" && r.filing === "single")).toBe(true);
  });

  it("rejects an implausibly high marginal rate via the domain validator (rate >= 0.5)", async () => {
    // A rate of 0.6 passes the registry's coarse schema check (rate <= 1) but
    // trips the domain rule rate ∈ (0, 0.5) inside import_tax_table — proving
    // the validateTaxTablePayload gate runs, not just the schema layer. (A
    // gross "37 not 0.37" error is caught even earlier by the schema's
    // maximum:1 bound; this asserts the tighter domain bound.)
    const ctx = await freshCtx();
    await expect(
      registry.invoke(
        "import_tax_table",
        {
          year: 2026,
          jurisdiction: "federal",
          filing: "single",
          standardDeductionDollars: 16000,
          brackets: [
            { upTo: 12000, rate: 0.1 },
            { rate: 0.6 },
          ],
          sourceUrl: "https://www.irs.gov/",
        },
        ctx,
      ),
    ).rejects.toThrow(/validation failed.*0, 0\.5/);
  });

  it("rejects a negative standard deduction", async () => {
    const ctx = await freshCtx();
    await expect(
      registry.invoke(
        "import_tax_table",
        { ...payload, standardDeductionDollars: -1 },
        ctx,
      ),
    ).rejects.toThrow(/standardDeductionDollars|validation failed/);
  });

  it("rejects non-monotone bracket cutoffs", async () => {
    const ctx = await freshCtx();
    await expect(
      registry.invoke(
        "import_tax_table",
        {
          year: 2026,
          jurisdiction: "federal",
          filing: "single",
          standardDeductionDollars: 16000,
          brackets: [
            { upTo: 49000, rate: 0.1 },
            { upTo: 12000, rate: 0.12 }, // out of order
            { rate: 0.37 },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/ascending|validation failed/);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — the LEGACY set_tax_table tool now runs validateTaxTablePayload too,
// so garbage that slipped past its looser inline checks is rejected.
// ---------------------------------------------------------------------------

describe("FIX 2 legacy set_tax_table hardened with the domain validator", () => {
  const base = {
    year: 2026,
    jurisdiction: "federal" as const,
    filing: "single" as const,
    standardDeductionDollars: 16000,
    sourceUrl: "https://www.irs.gov/",
  };

  it("rejects an implausibly high rate (0.6) through the LEGACY tool", async () => {
    // rate 0.6 passes set_tax_table's schema (max 1) AND its inline
    // non-decreasing check — only the routed-in domain validator catches it.
    const ctx = await freshCtx();
    await expect(
      registry.invoke(
        "set_tax_table",
        {
          ...base,
          brackets: [
            { upTo: 12000, rate: 0.1 },
            { rate: 0.6 },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/validation failed.*0, 0\.5/);
  });

  it("rejects a zero standard deduction through the LEGACY tool", async () => {
    // 0 passes the schema's minimum:0 bound; the domain validator requires > 0.
    const ctx = await freshCtx();
    await expect(
      registry.invoke(
        "set_tax_table",
        {
          ...base,
          standardDeductionDollars: 0,
          brackets: [
            { upTo: 12000, rate: 0.1 },
            { rate: 0.37 },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/validation failed.*standardDeductionDollars/);
  });

  it("still accepts a well-formed payload through the LEGACY tool (no regression)", async () => {
    const ctx = await freshCtx();
    const out = (await registry.invoke(
      "set_tax_table",
      {
        ...base,
        brackets: [
          { upTo: 12000, rate: 0.1 },
          { upTo: 49000, rate: 0.12 },
          { rate: 0.37 },
        ],
      },
      ctx,
    )) as { saved: boolean; dryRun: boolean };
    expect(out.saved).toBe(true);
    expect(out.dryRun).toBe(false);
    // And the write actually landed.
    const rows = ctx.tax.tables(2026);
    expect(rows.some((r) => r.jurisdiction === "federal" && r.filing === "single")).toBe(true);
  });
});
