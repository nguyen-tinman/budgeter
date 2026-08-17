export const PACKAGE_NAME = "@budgetkit/core";
/**
 * Compat re-export. The authoritative value lives in packages/db/src/migrate.ts
 * (derived from the migration file count). A cross-package test in
 * apps/api/test/schema_version.test.ts asserts this literal equals the
 * migration count so drift is caught at test time. Do NOT hardcode a new
 * number here — add a migration file and run that test.
 */
export const SCHEMA_VERSION = 12; // 012_chat_log.sql (chat transcript persistence)

export * from "./money.js";
export * from "./models.js";
export * from "./tax_calculator.js";
export * from "./retirement_projector.js";
export * from "./account_tax.js";
export * from "./statement_parser.js";
export * from "./chase_parser.js";
export * from "./csv_parser.js";
export * from "./expense_dedup.js";
export * from "./recurring_detector.js";
export * from "./baseline_roller.js";
export * from "./category_resolver.js";
export * from "./expense_cataloguer.js";
export * from "./tool_registry.js";
export * from "./custom_page.js";
export * from "./tax_table_validation.js";
export * from "./tools.js";
export * from "./token_estimator.js";
export * from "./spend_date_backfill.js";
