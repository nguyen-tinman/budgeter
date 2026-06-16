// Strict HTTP fetcher for the LLM-driven tax-source ingest path.
//
// Allowlist: only the authoritative tax-bracket origins. The LLM cannot
// be coerced (via prompt injection from a page) to hit arbitrary endpoints
// because the allowlist is enforced server-side, BEFORE the request fires.
//
// Caps:
//   - HTTPS only
//   - GET only
//   - 10s timeout
//   - Max 200KB body (truncated with `truncated: true` if larger)
//   - Redirects followed only when the target host is also on the allowlist

import type { WebRepo } from "@budgetkit/core";

const ALLOWED_HOSTS = new Set<string>([
  "www.irs.gov",
  "www.ftb.ca.gov",
]);

const MAX_BYTES = 200 * 1024; // 200KB raw read cap
const TIMEOUT_MS = 10_000;
/** After HTML stripping, return at most this many text chars to the LLM.
 *  A 100KB IRS page strips to ~15-20KB of text; we keep a safety ceiling
 *  so a worst-case page can't blow past a small context window. */
const MAX_TEXT_CHARS = 40_000;

/** Strip HTML tags + script/style blocks + comments and collapse whitespace.
 *  This is a coarse extractor — sufficient for tax-bracket pages where the
 *  bracket data renders as readable inline text. */
export function htmlToText(html: string): string {
  // Drop everything inside <script>…</script>, <style>…</style>, and HTML
  // comments — these account for most of the byte count and contain no
  // user-facing text.
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // Convert <br>, </p>, </div>, </tr>, </li> to newlines so the table
  // structure survives in a useful way for the LLM.
  s = s.replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, "\n");
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode the handful of common entities.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
  // Collapse runs of whitespace; preserve paragraph breaks as a single \n\n.
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function isAllowedUrl(url: string): { ok: true; parsed: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `Only https:// allowed (got ${parsed.protocol})` };
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return {
      ok: false,
      reason: `Host ${parsed.hostname} not on allowlist. Allowed: ${[...ALLOWED_HOSTS].join(", ")}`,
    };
  }
  return { ok: true, parsed };
}

export function defaultWebFetcher(): WebRepo {
  return {
    async fetch(url: string) {
      const check = isAllowedUrl(url);
      if (!check.ok) {
        throw new Error(check.reason);
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        // `redirect: "manual"` so we can re-check the target host before
        // following. Node's default `redirect: "follow"` would happily
        // chase a 302 to an attacker-controlled host.
        let currentUrl = check.parsed.toString();
        let response: Response;
        const maxRedirects = 5;
        for (let i = 0; i <= maxRedirects; i++) {
          response = await fetch(currentUrl, {
            method: "GET",
            signal: controller.signal,
            redirect: "manual",
            headers: {
              "user-agent": "BudgetKit/0.1 (+local-only personal finance app)",
              accept: "text/html, application/xhtml+xml",
            },
          });
          if (response.status >= 300 && response.status < 400) {
            const next = response.headers.get("location");
            if (!next) break;
            const nextUrl = new URL(next, currentUrl).toString();
            const nextCheck = isAllowedUrl(nextUrl);
            if (!nextCheck.ok) {
              throw new Error(`Redirect to disallowed URL: ${nextCheck.reason}`);
            }
            currentUrl = nextUrl;
            if (i === maxRedirects) {
              throw new Error(`Too many redirects (>${maxRedirects})`);
            }
            continue;
          }
          break;
        }
        // Stream up to MAX_BYTES so a 100MB page can't OOM us.
        const reader = response!.body?.getReader();
        if (!reader) {
          return { status: response!.status, body: "", truncated: false, finalUrl: currentUrl };
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        let truncated = false;
        while (total < MAX_BYTES) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            const remaining = MAX_BYTES - total;
            if (value.byteLength > remaining) {
              chunks.push(value.subarray(0, remaining));
              total += remaining;
              truncated = true;
              break;
            }
            chunks.push(value);
            total += value.byteLength;
          }
        }
        // Drain any remaining bytes silently so the connection releases.
        if (truncated) {
          try {
            while (!(await reader.read()).done) {
              // discard
            }
          } catch {
            // ignore — we already have our cap
          }
        }
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        const rawBody = new TextDecoder("utf-8", { fatal: false }).decode(merged);
        // Reduce raw HTML to readable text so the LLM can fit the page in a
        // small context window. Apply MAX_TEXT_CHARS cap on the text form.
        const looksLikeHtml = /^\s*</.test(rawBody);
        let text = looksLikeHtml ? htmlToText(rawBody) : rawBody;
        let textTruncated = false;
        if (text.length > MAX_TEXT_CHARS) {
          text = text.slice(0, MAX_TEXT_CHARS);
          textTruncated = true;
        }
        return {
          status: response!.status,
          body: text,
          truncated: truncated || textTruncated,
          finalUrl: currentUrl,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

/** Exported only for tests so they can assert the policy. */
export const _webFetcherInternals = {
  ALLOWED_HOSTS,
  MAX_BYTES,
  MAX_TEXT_CHARS,
  TIMEOUT_MS,
  isAllowedUrl,
};
