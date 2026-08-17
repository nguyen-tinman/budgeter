// Reactive UI state shared across the editorial shell — theme, density, mono,
// font scale, chat-open, and the modal stack. Persisted to localStorage so
// page reloads keep the user's preferences.

const STORAGE_KEY = "budgetkit.editorial.prefs.v1";

interface Prefs {
  theme: "dark" | "light";
  density: "compact" | "comfortable" | "spacious";
  mono: boolean;
  fontScale: number;
  chatOpen: boolean;
  /** Whether the assistant panel should open on initial app load. */
  chatOpenOnLoad: boolean;
}

const DEFAULTS: Prefs = {
  theme: "dark",
  density: "comfortable",
  mono: true,
  fontScale: 1,
  chatOpen: true,
  chatOpenOnLoad: true,
};

function loadPrefs(): Prefs {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

interface ShellState {
  // Prefs
  theme: "dark" | "light";
  density: "compact" | "comfortable" | "spacious";
  mono: boolean;
  fontScale: number;
  chatOpen: boolean;
  /** Persisted default: should the assistant panel be open when the app first loads? */
  chatOpenOnLoad: boolean;
  // Modal stack — current modal id, or null.
  modal: string | null;
}

const state = $state<ShellState>({
  ...DEFAULTS,
  modal: null,
});
// Note: chatOpenOnLoad is spread in from DEFAULTS above; chatOpen is set from
// chatOpenOnLoad at hydration time so the live session value reflects the pref.

let hydrated = false;

export function hydrateShellState(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const loaded = loadPrefs();
  state.theme = loaded.theme;
  state.density = loaded.density;
  state.mono = loaded.mono;
  state.fontScale = loaded.fontScale;
  state.chatOpenOnLoad = loaded.chatOpenOnLoad;
  // Initialize the live panel state from the persisted load-time default.
  state.chatOpen = loaded.chatOpenOnLoad;
}

export function shellState(): ShellState {
  return state;
}

export function setShellPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  (state[key] as Prefs[K]) = value;
  if (typeof localStorage !== "undefined") {
    try {
      const toSave: Prefs = {
        theme: state.theme,
        density: state.density,
        mono: state.mono,
        fontScale: state.fontScale,
        chatOpen: state.chatOpen,
        chatOpenOnLoad: state.chatOpenOnLoad,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch {
      // ignore storage errors (quota, sandboxing, etc.)
    }
  }
}

export function setModal(id: string | null): void {
  state.modal = id;
}

// ---------------------------------------------------------------------------
// Resource invalidation bus
// ---------------------------------------------------------------------------
//
// When an LLM tool call mutates server state (add_expense, add_savings, etc.)
// the chat response carries `affectedResources: string[]`. ChatPanel routes
// those names through `invalidateResources` and each page subscribes via
// `onInvalidate` to re-run only the matching per-resource refresher — no
// full-page reload, no stale tables.
//
// Resource names are stable strings the server and clients agree on:
//   "incomes", "expenses", "savings", "takeHome", "workspaces", "retirement",
//   "statements", "customPage"
//
// Plain Set of listeners — no library, no lifecycle magic. Pages must call
// the disposer returned from `onInvalidate` on teardown (Svelte 5: return it
// from a `$effect`).

export type ResourceName =
  | "incomes"
  | "expenses"
  | "savings"
  | "takeHome"
  | "workspaces"
  | "retirement"
  | "statements"
  /** The assistant-authored /custom page definition itself (not the data it
   *  queries) — fired by set_custom_page so /custom reloads the document. */
  | "customPage";

type InvalidateListener = (resource: ResourceName) => void;

const invalidateListeners = new Set<InvalidateListener>();

export function invalidateResources(resources: readonly string[]): void {
  for (const r of resources) {
    // Defensive cast: server may send unknown names if the contract drifts.
    // Listeners filter their own resource set, so unknown names are no-ops.
    for (const l of invalidateListeners) l(r as ResourceName);
  }
}

export function onInvalidate(listener: InvalidateListener): () => void {
  invalidateListeners.add(listener);
  return () => {
    invalidateListeners.delete(listener);
  };
}
