// Heuristic token estimator
// =========================
//
// Both the API server (auto-compaction) and any future MCP-style integration
// need a fast way to estimate token counts without round-tripping through
// llama-server. We use a chars/token heuristic biased slightly conservative
// so we trip compaction a hair early rather than under-counting and hitting
// the --no-context-shift brick wall.
//
// For English + numbers on Qwen3 BPE, real tokens run ~3.3–3.7 chars/token.
// 3.5 sits in the middle. This is intentionally a single shared constant —
// if it ever drifts per-model, callers should pass an explicit `charsPerToken`
// override rather than maintain two copies.

/** Default chars-per-token heuristic. Calibrated for Qwen3 BPE on English +
 *  numbers. Bias toward over-estimation so compaction triggers a touch
 *  earlier than the model would strictly require. */
export const DEFAULT_CHARS_PER_TOKEN = 3.5;

/** Estimate the token count of a single string. Same heuristic the API
 *  server's auto-compaction uses; exported here so MCP / future bridges
 *  share the contract. */
export function estimateStringTokens(
  s: string,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  return Math.ceil(s.length / charsPerToken);
}
