import { describe, it, expect } from "vitest";
import { detectIssuer } from "../src/tools.js";

// Regression guard for the Library issuer-separation feature (GT-2).
//
// Amex Gold and Platinum exports are BOTH named "activity*.xlsx" — the only
// signal distinguishing them is the organizing directory (statements/gold/ vs
// statements/plat/). detectIssuer must therefore key off the full relative
// path, not the bare filename, otherwise every Amex file collapses into a
// single "Amex Gold" bucket and the user can no longer hide/show by issuer.
describe("detectIssuer — path-aware issuer classification", () => {
  it("classifies an Amex Platinum file by its directory, not just filename", () => {
    expect(detectIssuer("statements/plat/activity.xlsx", "xlsx")).toEqual({
      issuer: "amex_plat",
      issuerLabel: "Amex Platinum",
    });
    expect(detectIssuer("statements/plat/activity (11).xlsx", "xlsx").issuer).toBe("amex_plat");
  });

  it("classifies an Amex Gold file by its directory", () => {
    expect(detectIssuer("statements/gold/activity.xlsx", "xlsx")).toEqual({
      issuer: "amex_gold",
      issuerLabel: "Amex Gold",
    });
  });

  it("does not confuse the gold and plat directories with each other", () => {
    // The generic "activity" filename carries no issuer token; only the
    // directory disambiguates. A gold path must never resolve to plat.
    expect(detectIssuer("statements/gold/activity (3).xlsx", "xlsx").issuer).not.toBe("amex_plat");
    expect(detectIssuer("statements/plat/activity (3).xlsx", "xlsx").issuer).not.toBe("amex_gold");
  });

  it("classifies a Chase statement by its directory", () => {
    expect(detectIssuer("statements/chase/20250521-statements-2561-.pdf", "pdf").issuer).toBe("chase");
  });

  it("still honors explicit issuer tokens in the filename", () => {
    expect(detectIssuer("amex gold march.xlsx", "xlsx").issuer).toBe("amex_gold");
    expect(detectIssuer("amex platinum march.xlsx", "xlsx").issuer).toBe("amex_plat");
  });

  it("falls back by extension only when no directory/filename token is present", () => {
    expect(detectIssuer("statements/activity.xlsx", "xlsx")).toEqual({
      issuer: "amex_gold",
      issuerLabel: "Amex (assumed)",
    });
    expect(detectIssuer("statements/loose-file.pdf", "pdf")).toEqual({
      issuer: "chase",
      issuerLabel: "Chase (assumed)",
    });
    expect(detectIssuer("statements/notes.txt", "txt").issuer).toBe("unknown");
  });
});
