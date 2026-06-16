import { describe, it, expect } from "vitest";
import { defaultMerchantCategorizer } from "../src/category_resolver.js";
import { normalizeMerchant } from "../src/statement_parser.js";
import type { RawTxn } from "../src/statement_parser.js";

function mk(merchantRaw: string): RawTxn {
  return {
    postedDate: "2025-01-15",
    merchantRaw,
    // Use the real normalizer so the test exercises the same shape
    // `rollByCategory()` will hand the resolver in production.
    merchantNormalized: normalizeMerchant(merchantRaw),
    amountDollars: -1000,
    accountType: "chase",
  };
}

// The resolver targets the canonical BUDGET category set (migrations/008):
// gas → Transport, groceries/restaurants → Food, real-estate → Housing,
// catch-all → Discretionary. Names must match the budget table exactly.

describe("defaultMerchantCategorizer — Transport (gas)", () => {
  it("matches Shell gas stations", () => {
    expect(defaultMerchantCategorizer(mk("SHELL OIL 1234 SAN JOSE CA"))).toBe("Transport");
  });
  it("matches Chevron gas stations", () => {
    expect(defaultMerchantCategorizer(mk("CHEVRON #4521 LOS GATOS CA"))).toBe("Transport");
  });
  it("matches Exxon gas stations", () => {
    expect(defaultMerchantCategorizer(mk("EXXONMOBIL HOUSTON TX"))).toBe("Transport");
  });
  it("matches Arco gas stations", () => {
    expect(defaultMerchantCategorizer(mk("ARCO AM/PM #123 OAKLAND CA"))).toBe("Transport");
  });
});

describe("defaultMerchantCategorizer — Food (groceries)", () => {
  it("matches Costco Wholesale", () => {
    expect(defaultMerchantCategorizer(mk("COSTCO WHOLESALE #482"))).toBe("Food");
  });
  it("matches Trader Joe's", () => {
    expect(defaultMerchantCategorizer(mk("TRADER JOE'S #112 SAN JOSE CA"))).toBe("Food");
  });
  it("matches Whole Foods", () => {
    expect(defaultMerchantCategorizer(mk("WHOLE FOODS MKT #10481"))).toBe("Food");
  });
  it("matches Sam's Club", () => {
    expect(defaultMerchantCategorizer(mk("SAMS CLUB #4421"))).toBe("Food");
  });
});

describe("defaultMerchantCategorizer — Food (restaurants)", () => {
  it("matches In N Out", () => {
    expect(defaultMerchantCategorizer(mk("IN N OUT BURGER #234 SUNNYVALE CA"))).toBe("Food");
  });
  it("matches Chipotle", () => {
    expect(defaultMerchantCategorizer(mk("CHIPOTLE 1234 PALO ALTO CA"))).toBe("Food");
  });
  it("matches Starbucks", () => {
    expect(defaultMerchantCategorizer(mk("STARBUCKS STORE #4528 SAN JOSE CA"))).toBe("Food");
  });
  it("matches Chick Fil A", () => {
    expect(defaultMerchantCategorizer(mk("CHICK FIL A #4421 SAN JOSE CA"))).toBe("Food");
  });
});

describe("defaultMerchantCategorizer — Utilities", () => {
  it("matches Spectrum", () => {
    expect(defaultMerchantCategorizer(mk("SPECTRUM 800-867-5309 NY"))).toBe("Utilities");
  });
  it("matches PG&E", () => {
    // PG&E often shows as "PGE WEB PYMT" — the & gets stripped by the
    // normalizer, leaving "pge" in the merchant key.
    expect(defaultMerchantCategorizer(mk("PGE WEB PYMT ONLINE PMT"))).toBe("Utilities");
  });
  it("matches SoCal Gas", () => {
    expect(defaultMerchantCategorizer(mk("SOCAL GAS CO ONLINE PMT"))).toBe("Utilities");
  });
});

describe("defaultMerchantCategorizer — Housing / real estate", () => {
  it("matches a real estate management company", () => {
    expect(defaultMerchantCategorizer(mk("ACME REAL ESTATE LLC"))).toBe("Housing");
  });
  it("matches a property management firm", () => {
    expect(defaultMerchantCategorizer(mk("WESTERN PROPERTY MANAGEMENT INC"))).toBe("Housing");
  });
  it("does not over-match a 'real' substring in unrelated merchants", () => {
    // "REAL" alone is too broad — we require "real est" specifically. Unmatched
    // merchants now fall through to the "Discretionary" bucket so byCat totals
    // always sum to the full expense total.
    expect(defaultMerchantCategorizer(mk("REAL FRUIT JUICE BAR"))).toBe("Discretionary");
  });
});

describe("defaultMerchantCategorizer — Subscriptions", () => {
  it("matches Netflix", () => {
    expect(defaultMerchantCategorizer(mk("NETFLIX.COM"))).toBe("Subscriptions");
  });
  it("matches Disney Plus", () => {
    expect(defaultMerchantCategorizer(mk("DISNEY PLUS"))).toBe("Subscriptions");
  });
  it("matches Spotify", () => {
    expect(defaultMerchantCategorizer(mk("SPOTIFY USA NEW YORK NY"))).toBe("Subscriptions");
  });
  it("matches Google One", () => {
    expect(defaultMerchantCategorizer(mk("GOOGLE ONE GSUITE MOUNTAIN VIEW CA"))).toBe("Subscriptions");
  });
});

describe("defaultMerchantCategorizer — unknown / edge", () => {
  it("returns 'Discretionary' for a merchant with no matching rule", () => {
    // Category exhaustiveness: every txn must land in some category bucket so
    // byCat totals on the Dashboard sum cleanly to the full expense total.
    // Unmatched merchants get the budget "Discretionary" category.
    expect(defaultMerchantCategorizer(mk("RANDOM HARDWARE STORE #1234"))).toBe("Discretionary");
  });

  it("returns 'Discretionary' for an empty merchant", () => {
    const txn: RawTxn = {
      postedDate: "2025-01-15",
      merchantRaw: "",
      merchantNormalized: "",
      amountDollars: -100,
      accountType: "chase",
    };
    expect(defaultMerchantCategorizer(txn)).toBe("Discretionary");
  });
});
