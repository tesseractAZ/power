import { THEMES, useTheme, type ThemeId } from '../theme';

/**
 * v0.9.11 — header chip that switches between available themes.
 *
 * Two-button pill (mirrors the tab selector styling so it fits the
 * existing header without inventing a new affordance). One row, no
 * dropdown — there are only two themes and probably will stay that
 * way for a while.
 *
 * If we end up adding more themes (Minbari? Centauri? Narn? Vorlon
 * encounter-suit-green?), swap this for a Listbox or cycle-button.
 */
export function ThemeToggle() {
  const [active, setActive] = useTheme();

  return (
    <div
      className="flex shrink-0 bg-panel border border-line rounded-lg overflow-hidden"
      title="Switch UI theme"
    >
      {THEMES.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setActive(t.id as ThemeId)}
            className={`px-2 py-1 text-[11px] whitespace-nowrap transition-colors ${
              selected ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'
            }`}
            title={t.description}
          >
            {t.name}
          </button>
        );
      })}
    </div>
  );
}
