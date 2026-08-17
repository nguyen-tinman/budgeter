// The custom page's real state lives in the BROWSER: whether its queries
// resolved, whether the render body threw, whether the sandbox came up at all.
// None of that is visible server-side, so before the assistant can be told
// about a broken page, the page has to say so.
//
// This route is that channel. The /custom page reports after every render
// cycle; chat.ts reads the last report back and injects it into the system
// message on every turn (see CUSTOM_PAGE_STATUS there). Without it the model
// writes a definition, is told the write succeeded, and never learns that the
// page it produced throws on load — which is exactly how a definition
// declaring query id `retirement_plot` while reading `data.retirement` survived
// in storage.

import { Hono } from "hono";
import { appSettingsRepo, openDb, type AppSettingsRepo } from "@budgetkit/db";

export const CUSTOM_PAGE_STATUS_KEY = "customPage.status";

/** What the page can report. `ok` and `blank` are healthy; the rest are
 *  failures the assistant is expected to repair. */
export const CUSTOM_PAGE_STATES = [
  "ok",
  "blank",
  "query_error",
  "render_error",
  "sandbox_failed",
] as const;
export type CustomPageState = (typeof CUSTOM_PAGE_STATES)[number];

export interface CustomPageStatus {
  state: CustomPageState;
  /** Verbatim error text from the browser, when there is one. */
  message?: string;
  /** Title of the definition that produced this state, for context. */
  title?: string;
  reportedAt: string;
}

/** Cap the stored message: it is browser-supplied and lands in the model's
 *  context every turn, so an enormous stack trace would eat the budget. */
const MAX_MESSAGE_CHARS = 600;
const MAX_TITLE_CHARS = 120;

export interface CustomPageStatusRouterOptions {
  settings?: AppSettingsRepo;
}

function getSettings(opts: CustomPageStatusRouterOptions): AppSettingsRepo {
  return opts.settings ?? appSettingsRepo(openDb());
}

/** Read the last report. Returns null when the page has never reported —
 *  distinct from a report of `blank`, which means the page ran and found no
 *  definition. */
export function readCustomPageStatus(settings: AppSettingsRepo): CustomPageStatus | null {
  const raw = settings.get(CUSTOM_PAGE_STATUS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CustomPageStatus;
    if (!CUSTOM_PAGE_STATES.includes(parsed.state)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function customPageStatusRouter(opts: CustomPageStatusRouterOptions = {}): Hono {
  const router = new Hono();

  router.get("/", (c) => c.json({ status: readCustomPageStatus(getSettings(opts)) }));

  router.post("/", async (c) => {
    let body: { state?: unknown; message?: unknown; title?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }
    const state = body.state;
    if (typeof state !== "string" || !CUSTOM_PAGE_STATES.includes(state as CustomPageState)) {
      return c.json(
        { ok: false, error: "invalid_state", allowed: CUSTOM_PAGE_STATES },
        400,
      );
    }
    const status: CustomPageStatus = {
      state: state as CustomPageState,
      ...(typeof body.message === "string" && body.message !== ""
        ? { message: body.message.slice(0, MAX_MESSAGE_CHARS) }
        : {}),
      ...(typeof body.title === "string" && body.title !== ""
        ? { title: body.title.slice(0, MAX_TITLE_CHARS) }
        : {}),
      reportedAt: new Date().toISOString(),
    };
    getSettings(opts).set(CUSTOM_PAGE_STATUS_KEY, JSON.stringify(status));
    return c.json({ ok: true, status });
  });

  return router;
}
