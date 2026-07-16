/**
 * v0.85.0 — a reusable in-page pill sub-nav.
 *
 * Mirrors the header tab selector / ThemeToggle styling (bg-panel pill, an
 * accent-tinted selected segment) so a page's sub-views feel native to the app
 * rather than a new affordance. Used for the Alerts page's Active | Cleared |
 * Settings switch; any page that wants section grouping can reuse it.
 *
 * Token-only styling ⇒ correct in both Default and High Contrast themes.
 */

export interface SubNavTab<T extends string> {
  id: T;
  label: string;
  /** Optional count/marker rendered as a small pill after the label. */
  badge?: { count: number; tone?: 'bad' | 'high' | 'warn' | 'accent' };
}

const BADGE_TONE: Record<'bad' | 'high' | 'warn' | 'accent', string> = {
  bad: 'bg-bad/25 text-bad',
  high: 'bg-high/25 text-high',
  warn: 'bg-warn/25 text-warn',
  accent: 'bg-accent/25 text-accent',
};

export function SubNav<T extends string>({
  tabs,
  value,
  onChange,
  'aria-label': ariaLabel,
}: {
  tabs: SubNavTab<T>[];
  value: T;
  onChange: (id: T) => void;
  'aria-label'?: string;
}) {
  return (
    <div
      className="inline-flex flex-wrap bg-panel border border-line rounded-lg max-w-full text-xs"
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.id)}
            className={`px-3 py-1 transition-colors shrink-0 whitespace-nowrap flex items-center gap-1.5 ${
              selected ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'
            }`}
          >
            {t.label}
            {t.badge && t.badge.count > 0 && (
              <span
                className={`text-[10px] font-semibold rounded-full px-1.5 py-px ${
                  BADGE_TONE[t.badge.tone ?? 'accent']
                }`}
              >
                {t.badge.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
