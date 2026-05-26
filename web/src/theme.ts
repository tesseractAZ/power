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
 *      persists the choice to localStorage, and lazy-loads B5's
 *      Google Fonts when that theme is first selected.
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
} as const;

export const UI: Readonly<typeof UI_FALLBACK> = cssVarProxy('--color-', UI_FALLBACK);

/** Structural chart colors (gridlines, axes, tooltip). */
export const CHART = {
  get grid() { return cssVarRgb('--color-panel2', '#c4cad3'); },
  get axis() { return UI.muted; },
  get tooltipBg() { return cssVarRgb('--color-panel', '#ffffff'); },
  get tooltipBorder() { return UI.line; },
} as const;

/**
 * Semantic series hues — tuned to read on the original light panel.
 * Kept static for now: amber/cyan/teal etc. read reasonably on both
 * themes, and re-skinning every series per theme is a bigger lift.
 * (Solar = amber, battery = cyan, load = teal stays meaningful.)
 */
export const HUES = {
  solar: '#d97706',  // amber-600
  battery: '#0e7490', // cyan-700
  load: '#0f766e',    // teal-700
  soc: '#15803d',     // green-700
  grid: '#586474',    // grey
  violet: '#7c3aed',
  pink: '#db2777',
  amber: '#b45309',
} as const;

/** Palette for multi-series charts (per-DPU / per-string lines). */
export const SERIES_PALETTE = ['#0e7490', '#15803d', '#b45309', '#7c3aed', '#db2777', '#0f766e'];

/* ─── 2. Runtime theme switcher ────────────────────────────────────────── */

export const THEMES = [
  {
    id: 'default' as const,
    name: 'Default',
    description: 'Light industrial HMI / control-room palette (original).',
  },
  {
    id: 'b5' as const,
    name: 'Babylon 5',
    description: 'Earthforce / Babylon Station system UI — deep navy + station cyan + amber accents.',
  },
  {
    id: 'starfleet' as const,
    name: 'Starfleet',
    description: 'USS Enterprise NCC-1701 refit bridge (Star Trek: The Motion Picture). New layout, new stations, new chrome — not a re-skin.',
  },
  {
    id: 'opus' as const,
    name: 'Opus',
    description: 'Project Genesis — Apple-aesthetic Living World view. Deep cosmic black, glassmorphism, organic gradients, hero typography. Data feels alive.',
  },
];

export type ThemeId = (typeof THEMES)[number]['id'];

const STORAGE_KEY = 'ecoflow-theme';
const DEFAULT_THEME: ThemeId = 'default';

export function getStoredTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    return v && THEMES.some((t) => t.id === v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id: ThemeId) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = id;
  // Lazy-load the B5 Google Fonts only when that theme is actually selected.
  // Idempotent — checks for an existing <link> with the same id first.
  if (id === 'b5' && !document.getElementById('theme-b5-fonts')) {
    const link = document.createElement('link');
    link.id = 'theme-b5-fonts';
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Share+Tech+Mono&display=swap';
    document.head.appendChild(link);
  }
  // v0.9.14 — Starfleet (TMP era) fonts. Antonio for Eurostile-feel
  // (geometric extended sans for headers/labels), Saira Condensed for
  // body, Share Tech Mono for monospaced numeric readouts.
  if (id === 'starfleet' && !document.getElementById('theme-starfleet-fonts')) {
    const link = document.createElement('link');
    link.id = 'theme-starfleet-fonts';
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Antonio:wght@400;700&family=Saira+Condensed:wght@400;600&family=Share+Tech+Mono&display=swap';
    document.head.appendChild(link);
  }
}

/* ─── v0.9.17 — singleton theme store ──────────────────────────────────
 *
 * Earlier versions made `useTheme` a plain `useState` hook. Each component
 * that called it got its OWN state instance, so when `ThemeToggle`'s
 * `setActive('starfleet')` fired, the App component's separate useTheme
 * instance never saw the change — the CSS palette swapped (via the
 * side-effect `applyTheme` call) but the `if (theme === 'starfleet')`
 * branch in App.tsx kept returning false. Result: the normal dashboard
 * stayed mounted under a Starfleet-colored palette instead of the
 * StarfleetBridge component swapping in.
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
