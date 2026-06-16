import type { TaxTable, TaxSettings } from "../src/models.js";

// 2025 brackets, mirroring what the DB migration seeds.
// Values in dollars.
export const TABLES_2025: TaxTable[] = [
  {
    year: 2025,
    jurisdiction: "federal",
    filing: "single",
    // Post-OBBBA (One Big Beautiful Bill Act, signed mid-2025): the 2025
    // single standard deduction was raised from $15,000 to $15,750.
    standardDeductionDollars: 15_750,
    brackets: [
      { upTo: 11_925, rate: 0.10 },   // $0 - $11,925
      { upTo: 48_475, rate: 0.12 },   // - $48,475
      { upTo: 103_350, rate: 0.22 },  // - $103,350
      { upTo: 197_300, rate: 0.24 },  // - $197,300
      { upTo: 250_525, rate: 0.32 },  // - $250,525
      { upTo: 626_350, rate: 0.35 },  // - $626,350
      { upTo: null, rate: 0.37 },     // $626,350+
    ],
  },
  {
    year: 2025,
    jurisdiction: "federal",
    filing: "mfj",
    // Post-OBBBA: 2025 MFJ standard deduction raised from $30,000 to $31,500.
    standardDeductionDollars: 31_500,
    brackets: [
      { upTo: 23_850, rate: 0.10 },   // $0 - $23,850
      { upTo: 96_950, rate: 0.12 },   // - $96,950
      { upTo: 206_700, rate: 0.22 },  // - $206,700
      { upTo: 394_600, rate: 0.24 },  // - $394,600
      { upTo: 501_050, rate: 0.32 },  // - $501,050
      { upTo: 751_600, rate: 0.35 },  // - $751,600
      { upTo: null, rate: 0.37 },     // $751,600+
    ],
  },
  {
    year: 2025,
    jurisdiction: "ca",
    filing: "single",
    standardDeductionDollars: 5_685,
    brackets: [
      { upTo: 10_756, rate: 0.01 },
      { upTo: 25_499, rate: 0.02 },
      { upTo: 40_245, rate: 0.04 },
      { upTo: 55_866, rate: 0.06 },
      { upTo: 70_606, rate: 0.08 },
      { upTo: 360_659, rate: 0.093 },
      { upTo: 432_790, rate: 0.103 },
      { upTo: 721_315, rate: 0.113 },
      { upTo: 1_000_000, rate: 0.123 },
      { upTo: null, rate: 0.133 },
    ],
  },
  {
    year: 2025,
    jurisdiction: "ca",
    filing: "mfj",
    standardDeductionDollars: 11_370,
    brackets: [
      { upTo: 21_512, rate: 0.01 },
      { upTo: 50_998, rate: 0.02 },
      { upTo: 80_490, rate: 0.04 },
      { upTo: 111_732, rate: 0.06 },
      { upTo: 141_212, rate: 0.08 },
      { upTo: 721_318, rate: 0.093 },
      { upTo: 865_580, rate: 0.103 },
      // CA MFJ FTB 11.3% bracket runs $865,580–$1,442,628 — straddling the
      // $1M MHST split. Embedded as monotonic cutoffs:
      //   11.3% upTo $1M (regular FTB rate, no MHST yet)
      //   12.3% upTo $1,442,628 (FTB 11.3% + 1% MHST surcharge)
      //   13.3% above $1,442,628 (FTB 12.3% + 1% MHST surcharge)
      // Ordering matters: bracketTax() walks the list in order, so the
      // smaller-upTo entry MUST come first.
      { upTo: 1_000_000, rate: 0.113 },
      { upTo: 1_442_630, rate: 0.123 },
      { upTo: null, rate: 0.133 },
    ],
  },
];

export const DEFAULT_SETTINGS_SINGLE: TaxSettings = {
  filing: "single",
  taxYear: 2025,
  caSdiRate: 0.011,
  // 2025 SSA wage base: $176,100 (was $168,600 in 2024).
  ssWageBaseDollars: 176_100,
  ficaSsRate: 0.062,
  ficaMedicareRate: 0.0145,
  retirementEffectiveTaxRate: 0.12,
};

export const DEFAULT_SETTINGS_MFJ: TaxSettings = {
  ...DEFAULT_SETTINGS_SINGLE,
  filing: "mfj",
};
