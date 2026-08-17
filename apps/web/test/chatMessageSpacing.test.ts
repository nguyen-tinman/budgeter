// Guards the fix for empty chat bubbles and the gaps between tool-chip rows.
//
// Svelte emits a literal space between adjacent {#if} blocks — the compiled
// bubble is `<div class="bk-msg"><!> <!></div>`. While `.bk-msg` carried
// `white-space: pre-wrap`, that space could not collapse: every message painted
// a line box for it, so a chip-only step showed a phantom blank line above its
// chip and a step with neither text nor chips rendered as an empty bordered box.
//
// The invariant is therefore: pre-wrap belongs to the text span, never to the
// bubble container. That is a property of the stylesheet, so it is asserted
// against the stylesheet rather than through a DOM render.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../src/lib/styles/editorial.css"), "utf8");
const panel = readFileSync(join(here, "../src/lib/components/ChatPanel.svelte"), "utf8");

/** The declarations inside a rule, given its exact selector. */
function ruleBody(selector: string): string {
  const i = css.indexOf(`\n${selector} {`);
  expect(i, `rule not found: ${selector}`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("}", i));
}

describe("chat bubble whitespace", () => {
  it("does not put white-space on the bubble container", () => {
    expect(ruleBody(".bk-msg")).not.toMatch(/white-space/);
  });

  it("puts pre-wrap on the text span, so real replies keep their line breaks", () => {
    expect(ruleBody(".bk-msg-text")).toMatch(/white-space:\s*pre-wrap/);
  });

  it("renders message text inside that span, and only when there is text", () => {
    // `{:else}{m.text}` would emit a bare text node in the bubble again.
    expect(panel).toMatch(/\{:else if m\.text\}/);
    expect(panel).toMatch(/<span class="bk-msg-text">\{m\.text\}<\/span>/);
  });

  it("does not append an assistant bubble with neither text nor tools", () => {
    // The guard in applyDone. Kept as a source assertion because the component
    // needs a live API to render; the server-side half is covered by
    // apps/api/test/chat.test.ts ("silent final turn").
    expect(panel).toMatch(/if \(text\.length > 0 \|\| tools\)/);
  });
});
