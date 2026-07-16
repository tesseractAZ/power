import type { ReactNode } from 'react';

/**
 * v0.86.0 — Readability primitives.
 *
 * The dashboard had two problems: headers read as faint captions (tiny muted
 * uppercase), and every card opened with a multi-sentence method-explainer
 * paragraph that repeated the numbers below it — "word vomit with a lot of
 * numbers". These primitives fix both:
 *   • SectionHeader — a prominent, scannable title with a domain-colour accent
 *     bar, an optional right-side status chip, and an optional one-line takeaway.
 *   • SubHeader — a bold subsection divider inside a multi-part card.
 *   • HowItWorks — the static "how this is computed" prose, collapsed by default
 *     (kept available, out of the default flow).
 *   • Expander — a generic "Show detail" collapse for dense per-hour / per-pack /
 *     per-circuit tables, so the default view is summary tiles.
 * All theme-token only (correct in Default + High Contrast).
 */

export type Accent = 'solar' | 'battery' | 'grid' | 'load' | 'soc' | 'neutral' | 'alert';

// Accent bar colour via the existing CSS-var hue tokens (space-separated RGB
// triples), so it tracks both themes. Inline style avoids Tailwind purge issues
// with arbitrary values.
const ACCENT_RGB: Record<Accent, string> = {
  solar: 'var(--hue-solar)',
  battery: 'var(--hue-battery)',
  grid: 'var(--color-accent)',
  load: 'var(--hue-load)',
  soc: 'var(--hue-soc)',
  neutral: 'var(--color-line)',
  alert: 'var(--color-bad)',
};

/**
 * A prominent section header. Use at the top of a card or a page section.
 *   title   — the header text (bold, ink, sentence-case).
 *   accent  — domain colour for the left bar (solar/battery/grid/…).
 *   chip    — small right-aligned status pill (e.g. a PredictiveBadge or a badge).
 *   takeaway— ONE plain-language line that cites the live number (replaces the
 *             old explainer paragraph). Keep it short.
 *   info    — optional "How this works" prose, rendered collapsed under the header.
 */
export function SectionHeader({
  title, accent = 'neutral', chip, takeaway, info,
}: {
  title: ReactNode;
  accent?: Accent;
  chip?: ReactNode;
  takeaway?: ReactNode;
  info?: ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <span
          className="inline-block w-1 self-stretch min-h-[1.1rem] rounded-full shrink-0"
          style={{ backgroundColor: `rgb(${ACCENT_RGB[accent]})` }}
          aria-hidden
        />
        <h3 className="text-[15px] font-bold text-ink leading-tight flex-1 min-w-0">{title}</h3>
        {chip}
      </div>
      {takeaway != null && <p className="text-sm text-ink/90 leading-snug mt-1 ml-3">{takeaway}</p>}
      {info != null && <div className="ml-3"><HowItWorks>{info}</HowItWorks></div>}
    </div>
  );
}

/** Bold subsection divider inside a multi-part card (hairline rule above). */
export function SubHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="subhead">
      <span>{children}</span>
      {right}
    </div>
  );
}

/** The static method-explainer prose, collapsed by default. Kept available on
 *  demand so context isn't lost, but out of the default scannable view. */
export function HowItWorks({ children, label = 'How this works' }: { children: ReactNode; label?: string }) {
  return (
    <details className="mt-2 group">
      <summary className="cursor-pointer list-none inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted hover:text-ink select-none">
        <span className="inline-block transition-transform group-open:rotate-90">▸</span>
        {label}
      </summary>
      <div className="text-sm text-muted leading-relaxed mt-2 pl-3 border-l border-line">{children}</div>
    </details>
  );
}

/** Generic "Show detail" collapse for dense tables/lists. Collapsed by default so
 *  the summary tiles lead; open by passing defaultOpen. */
export function Expander({
  label, children, defaultOpen = false, count,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
  count?: number;
}) {
  return (
    <details className="mt-3 group" open={defaultOpen}>
      <summary className="cursor-pointer list-none inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline select-none">
        <span className="inline-block transition-transform group-open:rotate-90">▸</span>
        {label}{count != null ? ` (${count})` : ''}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
