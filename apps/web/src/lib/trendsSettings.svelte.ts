// Persisted Trends plot settings (window, mode, selected categories/overlays).
// localStorage only; mirrors appShellState's prefs pattern. Category keys are
// workspace-specific — the page intersects saved cats with the current
// workspace on load (see routes/trends/+page.svelte).

const STORAGE_KEY = "budgetkit.trends.settings.v1";

export interface TrendsSettings {
  windowMonths: number;
  mode: "absolute" | "percent" | "stacked";
  activeCats: string[];
  activeOverlays: string[];
}

const DEFAULTS: TrendsSettings = {
  windowMonths: 3,
  mode: "absolute",
  activeCats: [],
  activeOverlays: ["takeHome"],
};

export function loadTrendsSettings(): TrendsSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<TrendsSettings>;
    return {
      windowMonths: typeof p.windowMonths === "number" ? p.windowMonths : DEFAULTS.windowMonths,
      mode: p.mode === "percent" || p.mode === "stacked" ? p.mode : "absolute",
      activeCats: Array.isArray(p.activeCats) ? p.activeCats.map(String) : [],
      activeOverlays: Array.isArray(p.activeOverlays) ? p.activeOverlays.map(String) : ["takeHome"],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveTrendsSettings(s: TrendsSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore quota / sandbox errors
  }
}
