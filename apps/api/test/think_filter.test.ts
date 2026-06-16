// think_filter — hides inline <think>…</think> chain-of-thought from the
// user-facing answer, on both the whole-string (non-streaming) and the
// chunked (SSE streaming) paths, including tags split across chunk boundaries.

import { describe, it, expect } from "vitest";
import {
  stripThinkBlocks,
  createThinkStreamFilter,
} from "../src/services/think_filter.js";

/** Drive a list of chunks through a fresh stream filter and return the full
 *  visible text (push outputs concatenated, then flush). */
function runStream(chunks: string[]): string {
  const f = createThinkStreamFilter();
  let out = "";
  for (const c of chunks) out += f.push(c);
  out += f.flush();
  return out;
}

describe("stripThinkBlocks (non-streaming)", () => {
  it("removes a complete <think> block and trims the leading blank lines", () => {
    expect(
      stripThinkBlocks("<think>\nLet me reason about this.\n</think>\n\nThe answer is 42."),
    ).toBe("The answer is 42.");
  });

  it("is a no-op when there is no <think> (separated reasoning_content case)", () => {
    expect(stripThinkBlocks("Your monthly remaining is $1,236.")).toBe(
      "Your monthly remaining is $1,236.",
    );
  });

  it("drops an unterminated <think> (truncated reasoning)", () => {
    // The space that bordered the (now-removed) block is preserved — only
    // LEADING whitespace is trimmed. A trailing space renders invisibly.
    expect(stripThinkBlocks("Before. <think>still thinking and then cut off")).toBe(
      "Before. ",
    );
  });

  it("removes multiple think blocks but keeps text between them", () => {
    // Non-greedy matching strips each block independently, leaving the visible
    // text (and the single space that bordered each removed block) intact.
    expect(
      stripThinkBlocks("<think>a</think>Visible one. <think>b</think> Visible two."),
    ).toBe("Visible one.  Visible two.");
  });

  it("preserves content that merely mentions the word think", () => {
    expect(stripThinkBlocks("I think you should save more.")).toBe(
      "I think you should save more.",
    );
  });

  it("handles empty / falsy input", () => {
    expect(stripThinkBlocks("")).toBe("");
  });
});

describe("createThinkStreamFilter (streaming)", () => {
  it("suppresses a think block delivered in one chunk", () => {
    expect(runStream(["<think>reasoning</think>\n\nFinal answer."])).toBe("Final answer.");
  });

  it("suppresses a block when the OPEN tag is split across chunks", () => {
    expect(runStream(["<thi", "nk>secret reasoning</think>Answer."])).toBe("Answer.");
  });

  it("suppresses a block when the CLOSE tag is split across chunks", () => {
    expect(runStream(["<think>secret</thi", "nk>Answer."])).toBe("Answer.");
  });

  it("suppresses reasoning streamed token-by-token", () => {
    const chunks = [
      "<th",
      "ink",
      ">",
      "I ",
      "should ",
      "check.",
      "</th",
      "ink>",
      "\n\n",
      "You ",
      "have ",
      "$500 ",
      "left.",
    ];
    expect(runStream(chunks)).toBe("You have $500 left.");
  });

  it("passes through plain text with no think tags (no token loss)", () => {
    expect(runStream(["Hello ", "there, ", "world."])).toBe("Hello there, world.");
  });

  it("flushes a trailing '<' that turned out NOT to be a tag", () => {
    // "5 < 10" — the lone '<' is held back, then released by flush.
    expect(runStream(["5 ", "<", " 10 is true"])).toBe("5 < 10 is true");
  });

  it("preserves internal whitespace after the first visible character", () => {
    expect(runStream(["<think>x</think>", "  line one\n\n  line two"])).toBe(
      "line one\n\n  line two",
    );
  });

  it("drops an unterminated think block at end of stream", () => {
    // The trailing space was already forwarded in the first chunk (before the
    // <think> tag appeared), so streaming can't retract it — and it's invisible
    // in the rendered bubble. The reasoning itself is dropped on flush.
    expect(runStream(["Answer first. ", "<think>then it gets cut o"])).toBe("Answer first. ");
  });

  it("does not emit the '<think>' tag itself even when alone in a chunk", () => {
    expect(runStream(["pre ", "<think>", "mid", "</think>", " post"])).toBe("pre  post");
  });
});

describe("inThinkBlock (drives the 'Thinking…' indicator for inline mode)", () => {
  it("is true while inside a block and false once it closes", () => {
    const f = createThinkStreamFilter();
    expect(f.inThinkBlock()).toBe(false);
    f.push("<think>reason");
    expect(f.inThinkBlock()).toBe(true);
    f.push("ing</think>answer");
    expect(f.inThinkBlock()).toBe(false);
  });

  it("stays false for plain answer text with no reasoning", () => {
    const f = createThinkStreamFilter();
    f.push("just the answer");
    expect(f.inThinkBlock()).toBe(false);
  });

  it("becomes true even when the open tag is split across chunks", () => {
    const f = createThinkStreamFilter();
    f.push("<thi");
    // The partial open tag is held back; not yet confirmed inside.
    expect(f.inThinkBlock()).toBe(false);
    f.push("nk>reasoning");
    expect(f.inThinkBlock()).toBe(true);
  });
});
