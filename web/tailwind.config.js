/** @type {import('tailwindcss').Config} */
// v0.9.11 — color tokens point at CSS variables (defined in src/index.css)
// so themes can be swapped at runtime via `[data-theme="..."]` without a
// rebuild. The `<alpha-value>` placeholder is required for utilities like
// `bg-panel/40` to keep working — Tailwind injects the chosen alpha into
// the rgb() expression at use-site.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        panel: 'rgb(var(--color-panel) / <alpha-value>)',
        panel2: 'rgb(var(--color-panel2) / <alpha-value>)',
        line: 'rgb(var(--color-line) / <alpha-value>)',
        ink: 'rgb(var(--color-ink) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        ok: 'rgb(var(--color-ok) / <alpha-value>)',
        warn: 'rgb(var(--color-warn) / <alpha-value>)',
        bad: 'rgb(var(--color-bad) / <alpha-value>)',
        // v0.11.0 — ISA-18.2 alarm-priority ramp: High (orange, P2) and
        // Low/info (blue, P4). Critical reuses `bad`, Medium reuses `warn`.
        high: 'rgb(var(--color-high) / <alpha-value>)',
        info: 'rgb(var(--color-info) / <alpha-value>)',
      },
      fontFamily: {
        // CSS variables let the High Contrast theme swap fonts without touching JSX.
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SF Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
