/**
 * v0.9.11 — Theme system.
 *
 * Two responsibilities live in this file:
 *
 *   1. **Chart colors** (`UI`, `CHART`, `HUES`, `SERIES_PALETTE`) —
 *      recharts components need literal color strings (Tailwind classes
 *      can't reach them). Each export below is a Proxy that resolves
 *      the current value from the active theme's CSS variables on
 *      access, so charts re-color when the user toggles themes —
 *      React's natural re-render flow picks up the new values.
 *
 *   2. **Runtime theme switcher** (`THEMES`, `applyTheme`, `useTheme`)
 *      — the CSS variables themselves live under `[data-theme="..."]`
 *      selectors in src/index.css. This module sets the attribute,
 *      persists the choice to localStorage, and lazy-loads the High
 *      Contrast theme's Google Fonts when that theme is first selected.
 */

import { useSyncExternalStore } from 'react';

/* ─── 1. Chart color resolvers ─────────────────────────────────────────── */

/**
 * Convert a CSS variable that stores a space-separated R G B triple
 * (e.g. `--color-accent: 14 116 144`) to a hex string recharts can use.
 * Returns a safe fallback on the server / before CSS is loaded.
 */
function cssVarRgb(name: string, fallback = '#000000'): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return fallback;
  return `#${parts.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Build a getter-proxy that maps property names → CSS variable lookups.
 * Used so existing `UI.accent` / `CHART.grid` call sites stay unchanged
 * but now resolve dynamically per active theme.
 */
function cssVarProxy<T extends Record<string, string>>(
  prefix: string,
  fallbacks: T,
): T {
  return new Proxy({} as T, {
    get(_, key: string) {
      const fb = (fallbacks as Record<string, string>)[key] ?? '#000000';
      return cssVarRgb(`${prefix}${key}`, fb);
    },
  });
}

/** Fallbacks mirror the default-theme palette so SSR / preload look right. */
const UI_FALLBACK = {
  bg: '#c2c8d0',
  panel: '#eef0f3',
  panel2: '#dfe3e8',
  line: '#9aa3b0',
  ink: '#1b2027',
  muted: '#586474',
  accent: '#0e7490',
  ok: '#15803d',
  warn: '#b45309',
  bad: '#b91c1c',
  elev: '#ffffff', // v0.36.0 — raised surface (flow-diagram node box). #fff default, dark panel in High Contrast.
} as const;

export const UI: Readonly<typeof UI_FALLBACK> = cssVarProxy('--color-', UI_FALLBACK);

/** Structural chart colors (gridlines, axes, tooltip). */
export const CHART = {
  // v0.36.0 — dedicated --chart-* vars whose Default values equal the historical
  // literals (#c4cad3 / #ffffff), so the Default theme is unchanged while High
  // Contrast supplies dark variants.
  get grid() { return cssVarRgb('--chart-grid', '#c4cad3'); },
  get axis() { return UI.muted; },
  get tooltipBg() { return cssVarRgb('--chart-tooltip-bg', '#ffffff'); },
  get tooltipBorder() { return UI.line; },
} as const;

/** Fallbacks = the original static hues (also the exact Default-theme values). */
const HUES_FALLBACK = {
  solar: '#d97706',   // amber-600
  battery: '#0e7490', // cyan-700
  load: '#0f766e',    // teal-700
  soc: '#15803d',     // green-700
  grid: '#586474',    // grey
  violet: '#7c3aed',
  pink: '#db2777',
  amber: '#b45309',
} as const;

/**
 * v0.36.0 — semantic series hues, now THEME-AWARE (resolve from `--hue-*` CSS
 * vars). Default values match the originals exactly; High Contrast brightens them
 * so chart series read on the dark palette instead of the muted light-theme tones.
 * (Solar = amber, battery = blue, load = cyan, soc = green stays meaningful.)
 */
export const HUES: Readonly<typeof HUES_FALLBACK> = cssVarProxy('--hue-', HUES_FALLBACK);

/**
 * Palette for multi-series charts (per-DPU / per-string lines). v0.36.0 — a Proxy
 * over the theme-aware HUES so each index resolves per active theme. The default
 * order reproduces the original ['#0e7490','#15803d','#b45309','#7c3aed','#db2777',
 * '#0f766e'] exactly, and the `SERIES_PALETTE[i]` / `.length` call-site API is
 * unchanged.
 */
export const SERIES_PALETTE: readonly string[] = new Proxy([] as string[], {
  get(_t, key) {
    const order = [HUES.battery, HUES.soc, HUES.amber, HUES.violet, HUES.pink, HUES.load];
    if (key === 'length') return order.length;
    if (typeof key === 'string' && /^\d+$/.test(key)) return order[Number(key)];
    return (order as unknown as Record<PropertyKey, unknown>)[key];
  },
});

/* ─── 2. Runtime theme switcher ────────────────────────────────────────── */

export const THEMES = [
  {
    id: 'default' as const,
    name: 'Default',
    description: 'Light industrial HMI / control-room palette (original).',
  },
  {
    id: 'high-contrast' as const,
    name: 'High Contrast',
    description: 'High-contrast dark palette — deep navy + cyan + amber accents.',
  },
];

export type ThemeId = (typeof THEMES)[number]['id'];

const STORAGE_KEY = 'ecoflow-theme';
const DEFAULT_THEME: ThemeId = 'default';

export function getStoredTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // Migrate the pre-rename slug: the "High Contrast" theme was formerly stored
    // as 'b5'. Map it forward so an existing selection survives the rename.
    const v = (raw === 'b5' ? 'high-contrast' : raw) as ThemeId | null;
    return v && THEMES.some((t) => t.id === v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id: ThemeId) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = id;
  // Lazy-load the High Contrast Google Fonts only when that theme is actually
  // selected. Idempotent — checks for an existing <link> with the same id first.
  if (id === 'high-contrast' && !document.getElementById('theme-high-contrast-fonts')) {
    const link = document.createElement('link');
    link.id = 'theme-high-contrast-fonts';
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Share+Tech+Mono&display=swap';
    document.head.appendChild(link);
  }
}

/* ─── v0.9.17 — singleton theme store ──────────────────────────────────
 *
 * Earlier versions made `useTheme` a plain `useState` hook. Each component
 * that called it got its OWN state instance, so when `ThemeToggle`'s
 * `setActive(...)` fired, other `useTheme` consumers never saw the change —
 * the CSS palette swapped (via the side-effect `applyTheme` call) but any
 * component branching on the active theme kept reading its own stale copy.
 *
 * Fix: hold the active theme in a module-level singleton + maintain a Set
 * of subscribers. Every `useTheme()` consumer subscribes via
 * `useSyncExternalStore`, so an update from any caller re-renders every
 * subscriber consistently. Apply-side-effects (CSS attribute, font load,
 * localStorage persist) run exactly once per change inside the setter,
 * not per subscriber. */

let currentTheme: ThemeId = getStoredTheme();
const subscribers = new Set<() => void>();

function setThemeGlobal(id: ThemeId) {
  if (id === currentTheme) return;
  currentTheme = id;
  applyTheme(id);
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch { /* private mode or quota — non-fatal */ }
  subscribers.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

function getSnapshot(): ThemeId {
  return currentTheme;
}

/** Snapshot for SSR. We don't actually SSR, but useSyncExternalStore wants it. */
function getServerSnapshot(): ThemeId {
  return DEFAULT_THEME;
}

/**
 * React hook — current theme + setter. State is shared across every
 * consumer, so a flip in `<ThemeToggle>` re-renders `<App>` too.
 */
export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [theme, setThemeGlobal];
}
