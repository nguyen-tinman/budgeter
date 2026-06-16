import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { utils, write } from "xlsx";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAmexXlsx, normalizeMerchant } from "../src/statement_parser.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "budgetkit-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Construct an XLSX matching the real Amex export layout. */
function makeAmexFixture(
  filename: string,
  rows: (string | number | null | Date)[][],
): string {
  // Rows 1-6: account metadata (anything; we skip).
  const accountInfo: (string | number | null)[][] = [
    ["Account Holder: Test Holder"],
    ["Account Number: -12345"],
    ["Statement Period: 01/01/2025 to 02/01/2025"],
    [],
    [],
    [],
  ];

  // Row 7: header row (real Amex column order).
  const header: string[] = [
    "Date",
    "Description",
    "Card Member",
    "Account #",
    "Amount",
    "Extended Details",
    "Appears On Your Statement As",
    "Address",
    "City/State",
    "Zip Code",
    "Country",
    "Reference",
    "Category",
  ];

  const all = [...accountInfo, header, ...rows];
  const ws = utils.aoa_to_sheet(all);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, "Activity");
  const buf = write(wb, { bookType: "xlsx", type: "buffer" });
  const path = join(tmpDir, filename);
  writeFileSync(path, buf);
  return path;
}

describe("normalizeMerchant", () => {
  it("lowercases and trims", () => {
    expect(normalizeMerchant("  STARBUCKS  ")).toBe("starbucks");
  });
  it("strips Amazon-style suffix IDs", () => {
    expect(normalizeMerchant("AMZN MKTP US*RT4XY3J")).toBe("amzn mktp us");
    expect(normalizeMerchant("AMAZON.COM*XYZ123")).toBe("amazon");
  });
  it("strips trailing state + zip", () => {
    expect(normalizeMerchant("CHEVRON 0098 SAN JOSE CA")).toBe("chevron san jose");
    expect(normalizeMerchant("WHOLEFDS PALOALTO CA 94301")).toBe("wholefds paloalto");
  });
  it("collapses whitespace", () => {
    expect(normalizeMerchant("DISNEY    PLUS")).toBe("disney plus");
  });
});

describe("parseAmexXlsx", () => {
  it("parses a 3-row gold-style fixture", () => {
    const path = makeAmexFixture("amex-gold-test.xlsx", [
      [
        "01/15/2025",
        "DISNEY PLUS",
        "TEST HOLDER",
        "-12345",
        16.20,
        "Subscription",
        "DISNEY PLUS",
        "",
        "",
        "",
        "US",
        "ref-1",
        "Entertainment",
      ],
      [
        "01/18/2025",
        "CHEVRON 0098 SAN JOSE CA",
        "TEST HOLDER",
        "-12345",
        42.55,
        "",
        "CHEVRON 0098",
        "",
        "SAN JOSE/CA",
        "95110",
        "US",
        "ref-2",
        "Gas",
      ],
      [
        "01/22/2025",
        "AMERICAN EXPRESS PAYMENT - THANK YOU",
        "TEST HOLDER",
        "-12345",
        -250.00, // payment credit (positive on the card from issuer's POV)
        "",
        "",
        "",
        "",
        "",
        "",
        "ref-3",
        "",
      ],
    ]);
    const r = parseAmexXlsx(path);
    expect(r.warnings).toEqual([]);
    expect(r.txns).toHaveLength(3);

    // Disney charge: $16.20 -> -16.20 dollars (charge convention)
    expect(r.txns[0]).toMatchObject({
      postedDate: "2025-01-15",
      merchantRaw: "DISNEY PLUS",
      merchantNormalized: "disney plus",
      amountDollars: -16.2,
      accountType: "amex_gold",
      categoryHint: "Entertainment",
    });

    // Chevron: -42.55 dollars
    expect(r.txns[1]?.amountDollars).toBe(-42.55);
    expect(r.txns[1]?.merchantNormalized).toBe("chevron san jose");

    // Payment credit: input was -250 (negative in source), should be +250 dollars (credit/refund)
    expect(r.txns[2]?.amountDollars).toBe(250);
  });

  it("infers amex_plat from filename", () => {
    const path = makeAmexFixture("amex-platinum-jan.xlsx", [
      [
        "01/15/2025",
        "TEST MERCHANT",
        "TEST",
        "-1",
        10.0,
        "",
        "",
        "",
        "",
        "",
        "US",
        "x",
        "",
      ],
    ]);
    const r = parseAmexXlsx(path);
    expect(r.txns[0]?.accountType).toBe("amex_plat");
  });

  it("skips blank rows and surfaces malformed rows as warnings (not silent drops)", () => {
    const path = makeAmexFixture("amex-warnings.xlsx", [
      // a clean row
      [
        "01/15/2025",
        "GOOD TXN",
        "T",
        "-1",
        5.5,
        "",
        "",
        "",
        "",
        "",
        "",
        "ref",
        "",
      ],
      // a fully blank row (should be silently skipped)
      [null, null, null, null, null, null, null, null, null, null, null, null, null],
      // a row missing amount (should warn, not silently drop)
      [
        "01/16/2025",
        "MISSING AMOUNT",
        "T",
        "-1",
        null,
        "",
        "",
        "",
        "",
        "",
        "",
        "ref",
        "",
      ],
      // a row missing date (should warn)
      [
        null,
        "MISSING DATE",
        "T",
        "-1",
        9.99,
        "",
        "",
        "",
        "",
        "",
        "",
        "ref",
        "",
      ],
    ]);
    const r = parseAmexXlsx(path);
    expect(r.txns).toHaveLength(1);
    expect(r.txns[0]?.merchantRaw).toBe("GOOD TXN");
    expect(r.warnings.length).toBe(2);
  });

  it("tolerates lowercased / 'Transaction Date' / 'Amount ($)' header variants", () => {
    const ws = utils.aoa_to_sheet([
      ["meta"],
      ["transaction date", "details", "amount ($)", "category"],
      ["01/15/2025", "FOO", 9.99, "Misc"],
    ]);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Activity");
    const buf = write(wb, { bookType: "xlsx", type: "buffer" });
    const path = join(tmpDir, "amex-variant-headers.xlsx");
    writeFileSync(path, buf);

    const r = parseAmexXlsx(path);
    expect(r.warnings).toEqual([]);
    expect(r.txns).toHaveLength(1);
    expect(r.txns[0]?.amountDollars).toBe(-9.99);
    expect(r.txns[0]?.categoryHint).toBe("Misc");
  });

  it("Y2K boundary: 2-digit year 69 → 2069, 70 → 1970", () => {
    const ws = utils.aoa_to_sheet([
      ["Date", "Description", "Amount"],
      ["01/15/69", "FUTURE TXN", 1.0],
      ["01/15/70", "PAST TXN", 1.0],
    ]);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Activity");
    const buf = write(wb, { bookType: "xlsx", type: "buffer" });
    const path = join(tmpDir, "amex-y2k.xlsx");
    writeFileSync(path, buf);

    const r = parseAmexXlsx(path);
    expect(r.txns).toHaveLength(2);
    expect(r.txns[0]?.postedDate).toBe("2069-01-15");
    expect(r.txns[1]?.postedDate).toBe("1970-01-15");
  });

  it("warnings do not leak raw cell values (PII-safe)", () => {
    // A row missing amount — warning should NOT contain "12345.67" or merchant text
    const ws = utils.aoa_to_sheet([
      ["Date", "Description", "Amount"],
      ["01/15/2025", "SECRET MERCHANT XYZ", null],
    ]);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Activity");
    const buf = write(wb, { bookType: "xlsx", type: "buffer" });
    const path = join(tmpDir, "amex-pii-warning.xlsx");
    writeFileSync(path, buf);

    const r = parseAmexXlsx(path);
    expect(r.txns).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    const w = r.warnings[0]!;
    expect(w).not.toMatch(/SECRET MERCHANT/i);
    expect(w).toMatch(/Row \d+/);
  });

  it("handles a header row at a different position (defensive)", () => {
    // Some exports include an extra summary block.
    const ws = utils.aoa_to_sheet([
      ["Hello"],
      ["World"],
      ["Extra"],
      ["Padding"],
      ["Row"],
      ["Six"],
      ["Seven"],
      ["Eight"],
      ["Date", "Description", "Card Member", "Account #", "Amount", "Category"],
      ["01/15/2025", "FOO", "T", "-1", 1.23, "Misc"],
    ]);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Activity");
    const buf = write(wb, { bookType: "xlsx", type: "buffer" });
    const path = join(tmpDir, "amex-shifted.xlsx");
    writeFileSync(path, buf);

    const r = parseAmexXlsx(path);
    expect(r.txns).toHaveLength(1);
    expect(r.txns[0]?.amountDollars).toBe(-1.23);
  });

  it("returns a warning when header row cannot be located", () => {
    const ws = utils.aoa_to_sheet([["a", "b"], ["c", "d"]]);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Activity");
    const buf = write(wb, { bookType: "xlsx", type: "buffer" });
    const path = join(tmpDir, "amex-no-header.xlsx");
    writeFileSync(path, buf);

    const r = parseAmexXlsx(path);
    expect(r.txns).toEqual([]);
    expect(r.warnings[0]).toMatch(/Header row/);
  });
});
