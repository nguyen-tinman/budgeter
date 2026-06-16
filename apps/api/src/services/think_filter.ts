// Hide model "thinking" (chain-of-thought) from the user-facing answer.
//
// With thinking ENABLED, Qwen3.5 emits its reasoning one of two ways:
//   (a) in a separate `reasoning_content` field — which the chat bridge simply
//       never forwards (it only reads `content` / `delta.content`); or
//   (b) inline in `content`, wrapped in <think>…</think> — depending on the
//       server's --reasoning-format. This module strips the inline form so
//       only the final answer reaches the user, covering BOTH the non-streaming
//       response (stripThinkBlocks) and the SSE token stream
//       (createThinkStreamFilter), where an open/close tag can split across
//       chunk boundaries (e.g. "<thi" then "nk>").
//
// The model still THINKS (we pass enable_thinking:true) — we only suppress the
// reasoning from the user's view, never from the model's own generation.

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * Strip complete (and any dangling unterminated) <think> blocks from a whole
 * string. Used on the non-streaming path where the full content is in hand.
 * A no-op (returns input unchanged) when there's no <think> — so the separated
 * `reasoning_content` case, where `content` is already clean, costs nothing.
 */
export function stripThinkBlocks(text: string): string {
  if (!text || !/<think>/i.test(text)) return text;
  // Remove every complete block, then any unterminated trailing block (a
  // truncated turn can leave "<think>…EOF" with no close).
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<think>[\s\S]*$/i, "");
  // Drop the blank lines Qwen emits after </think> so the answer doesn't begin
  // with leading whitespace.
  return s.replace(/^\s+/, "");
}

/**
 * Length of the longest PROPER suffix of `buf` that is a prefix of `tag`.
 * Used to hold back a tag that may be split across the next chunk: if a chunk
 * ends with "<thi", we keep those 4 chars instead of emitting them, in case
 * the next chunk completes "<think>".
 */
function partialTagSuffix(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (buf.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

export interface ThinkStreamFilter {
  /** Feed one content delta; returns the visible text to forward (may be ""). */
  push(chunk: string): string;
  /** Call once at end of stream; returns any held-back trailing text. */
  flush(): string;
  /** True while the filter is currently INSIDE an inline <think>…</think>
   *  block (i.e. suppressing reasoning). Lets the chat bridge surface a
   *  "Thinking…" indicator for the inline case, mirroring the separated
   *  `reasoning_content` case. */
  inThinkBlock(): boolean;
}

/**
 * Stateful, streaming-safe stripper for inline <think>…</think>. Forwards only
 * text OUTSIDE think blocks; buffers across chunks so a tag split between two
 * SSE deltas is recognized and suppressed. Leading whitespace before the first
 * visible character is trimmed so the answer doesn't begin with the blank lines
 * Qwen emits after </think>.
 *
 * Create ONE instance per llama call — each turn is a fresh generation with its
 * own think block.
 */
export function createThinkStreamFilter(): ThinkStreamFilter {
  let inside = false;
  let buf = "";
  let emittedVisible = false;

  // Trim leading whitespace until the first real visible character, then pass
  // text through verbatim (internal whitespace is preserved).
  const emit = (text: string): string => {
    if (!text) return "";
    let out = text;
    if (!emittedVisible) {
      out = out.replace(/^\s+/, "");
      if (out.length === 0) return "";
    }
    emittedVisible = true;
    return out;
  };

  return {
    push(chunk: string): string {
      buf += chunk;
      let out = "";
      for (;;) {
        if (!inside) {
          const i = buf.indexOf(OPEN);
          if (i === -1) {
            // No open tag yet. Emit everything except a trailing fragment that
            // could be the start of "<think>" arriving in the next chunk.
            const hold = partialTagSuffix(buf, OPEN);
            out += emit(buf.slice(0, buf.length - hold));
            buf = buf.slice(buf.length - hold);
            break;
          }
          out += emit(buf.slice(0, i));
          buf = buf.slice(i + OPEN.length);
          inside = true;
        } else {
          const i = buf.indexOf(CLOSE);
          if (i === -1) {
            // Inside a think block: drop content, but keep a possible partial
            // close tag for the next chunk.
            const hold = partialTagSuffix(buf, CLOSE);
            buf = buf.slice(buf.length - hold);
            break;
          }
          buf = buf.slice(i + CLOSE.length);
          inside = false;
        }
      }
      return out;
    },
    flush(): string {
      // End of stream. Outside a block, any held buffer was a false partial
      // (e.g. text legitimately ending in "<") — emit it. Inside an
      // unterminated block, drop it (truncated reasoning, never user-facing).
      if (inside) {
        buf = "";
        return "";
      }
      const tail = emit(buf);
      buf = "";
      return tail;
    },
    inThinkBlock(): boolean {
      return inside;
    },
  };
}
