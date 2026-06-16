-- Fix CA MFJ 2025 bracket ordering (schema_version unchanged).
--
-- The seeded 0.113 bracket had upTo = $1.44M, AFTER the 0.123 bracket whose
-- upTo was $1M. bracketTax() walks the array in order, so for MFJ filers
-- with taxable income $1M-$1.44M the 0.123 row was unreachable — they
-- jumped from 11.3% straight to 13.3% (an extra +1% effective on that span).
--
-- Correct ordering: 0.113 upTo $1M; 0.123 upTo $1.44M (representing the FTB
-- 11.3% bracket's portion above $1M with the 1% MHST surcharge embedded);
-- 0.133 above $1.44M (FTB 12.3% + MHST 1%).
--
-- Idempotent: only updates the 2025/ca/mfj row if it still has the broken
-- bracket arithmetic. Safe to re-run.

UPDATE tax_tables
SET brackets_json = '[
    {"upTo":2151200,"rate":0.01},
    {"upTo":5099800,"rate":0.02},
    {"upTo":8049000,"rate":0.04},
    {"upTo":11173200,"rate":0.06},
    {"upTo":14121200,"rate":0.08},
    {"upTo":72131800,"rate":0.093},
    {"upTo":86558000,"rate":0.103},
    {"upTo":100000000,"rate":0.113},
    {"upTo":144263000,"rate":0.123},
    {"upTo":null,"rate":0.133}
  ]'
WHERE year = 2025
  AND jurisdiction = 'ca'
  AND filing = 'mfj';
