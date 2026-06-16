// csv_parser — statement CSV imports (Chase activity + indicator-column bank
// exports). Fixtures are synthetic; shapes mirror the real headers.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatementCsv, parseCsvText } from "../src/csv_parser.js";

const dir = mkdtempSync(join(tmpdir(), "bk-csv-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("parseCsvText", () => {
  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const rows = parseCsvText('a,"b, c","say ""hi"""\r\nd,e,f\n');
    expect(rows[0]).toEqual(["a", "b, c", 'say "hi"']);
    expect(rows[1]).toEqual(["d", "e", "f"]);
  });
});

describe("parseStatementCsv — Chase activity shape", () => {
  const HEADER = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo";

  it("passes signed amounts through, converts dates to ISO, keeps category hints", () => {
    const p = fixture(
      "Chase9552_Activity_test.csv",
      `${HEADER}\n06/03/2026,06/04/2026,"ACME MART, INC #42",Groceries,Sale,-52.10,\n06/05/2026,06/05/2026,Payment Thank You-Mobile,,Payment,250.00,\n`,
    );
    const r = parseStatementCsv(p);
    expect(r.warnings).toEqual([]);
    expect(r.txns).toHaveLength(2);
    const charge = r.txns[0]!;
    expect(charge.postedDate).toBe("2026-06-04"); // Post Date wins
    expect(charge.merchantRaw).toBe("ACME MART, INC #42");
    expect(charge.amountDollars).toBe(-52.1); // sign preserved (charge)
    expect(charge.categoryHint).toBe("Groceries");
    expect(charge.accountType).toBe("chase"); // filename contains "chase"
    expect(r.txns[1]!.amountDollars).toBe(250); // payment stays positive
  });

  it("skips unparseable rows with a warning instead of failing the file", () => {
    const p = fixture(
      "chase_bad_row.csv",
      `${HEADER}\nnot-a-date,also-not,Thing,,Sale,-1.00,\n06/05/2026,06/05/2026,Good Row,,Sale,-2.00,\n`,
    );
    const r = parseStatementCsv(p);
    expect(r.txns).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/row 2/);
  });
});

describe("parseStatementCsv — Credit Debit Indicator shape", () => {
  const HEADER =
    "Posting Date,Transaction Date,Amount,Credit Debit Indicator,type,Type Group,Reference,Instructed Currency,Currency Exchange Rate,Instructed Amount,Description,Category,Check Serial Number,Card Ending,Rewards Total,Rewards Type";

  it("signs magnitudes from the indicator and uses Posting Date", () => {
    const p = fixture(
      "transactions_test.csv",
      `${HEADER}\n06/09/2026,06/09/2026,2.02,Debit,Purchase,,,,,,COFFEE PLACE,Dining,,1234,,\n06/10/2026,06/10/2026,15.00,Credit,Refund,,,,,,COFFEE PLACE,Dining,,1234,,\n`,
    );
    const r = parseStatementCsv(p);
    expect(r.warnings).toEqual([]);
    expect(r.txns).toHaveLength(2);
    expect(r.txns[0]!.amountDollars).toBe(-2.02); // Debit → charge → negative
    expect(r.txns[0]!.postedDate).toBe("2026-06-09");
    expect(r.txns[0]!.accountType).toBe("unknown"); // no "chase" in filename
    expect(r.txns[1]!.amountDollars).toBe(15); // Credit → positive
  });
});

describe("parseStatementCsv — rejection paths", () => {
  it("rejects an unrecognized header loudly (no silent garbage import)", () => {
    const p = fixture("weird.csv", "Foo,Bar,Baz\n1,2,3\n");
    const r = parseStatementCsv(p);
    expect(r.txns).toEqual([]);
    expect(r.warnings[0]).toMatch(/Unrecognized CSV header/);
  });

  it("handles an empty file without throwing", () => {
    const p = fixture("empty.csv", "");
    const r = parseStatementCsv(p);
    expect(r.txns).toEqual([]);
    expect(r.warnings[0]).toMatch(/No data rows/);
  });
});
