import { useEffect, useState } from 'react';
import type { GridBackstop } from '../types';
import { apiUrl } from '../api';
import { UI } from '../theme';

/**
 * v1.184.0 — "Grid is back — clear", shown while a declared grid is vetoed by a panel reading the
 * panel is not refreshing (offline, replaying, stale, from before a restart, or with no device list
 * at all). Driven by the snapshot's TOP-LEVEL `grid` — the panel card only exists for a projected
 * panel, and the restart cases this is for have none. The panel's next reading counts again.
 */
export function GridVetoClear({ grid }: { grid: GridBackstop | undefined }) {
  const clearable = grid?.vetoClearable === true;
  const [state, setState] = useState<'idle' | 'busy' | 'done' | string>('idle');
  // A later episode (the veto back on a new stale reading) offers the button again.
  useEffect(() => { if (clearable && state === 'done') setState('idle'); }, [clearable]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!clearable) {
    return state === 'done'
      ? <div className="card col-span-full text-xs" style={{ color: UI.muted }}>Cleared — the panel's next reading counts.</div>
      : null;
  }
  const clear = async () => {
    if (!window.confirm('Only if you know the grid is back: clear the saved "no grid" reading? The panel\'s next reading will count again.')) return;
    setState('busy');
    try {
      const r = await fetch(apiUrl('api/grid-veto/clear'), { method: 'POST' });
      setState(r.ok ? 'done' : `clear failed (HTTP ${r.status})`);
    } catch {
      setState('clear failed — network error');
    }
  };
  return (
    <div className="card col-span-full flex items-center gap-3 text-sm">
      <span style={{ color: UI.muted }}>
        Off-grid from the panel's last reading, which it is not refreshing{grid?.reason ? ` (${grid.reason})` : ''}.
      </span>
      <button onClick={clear} disabled={state === 'busy'} className="ml-auto shrink-0 px-2 py-1 rounded border border-line bg-panel hover:bg-panel2 text-ink disabled:opacity-50">
        Grid is back — clear
      </button>
      {state !== 'idle' && state !== 'busy' && state !== 'done' ? <span className="text-xs" style={{ color: UI.bad }}>{state}</span> : null}
    </div>
  );
}
