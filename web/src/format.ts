export const fmtW = (w: number | null | undefined) => {
  if (w == null) return '—';
  if (Math.abs(w) >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
};
export const fmtWh = (w: number | null | undefined) => {
  if (w == null) return '—';
  if (Math.abs(w) >= 1000) return `${(w / 1000).toFixed(2)} kWh`;
  return `${Math.round(w)} Wh`;
};
export const fmtPct = (p: number | null | undefined, digits = 0) =>
  p == null ? '—' : `${p.toFixed(digits)}%`;
/** EcoFlow reports temperatures in Celsius. Display in Fahrenheit. */
export const cToF = (c: number) => (c * 9) / 5 + 32;
export const fmtTemp = (t: number | null | undefined) => (t == null ? '—' : `${Math.round(cToF(t))}°F`);
export const fmtMins = (m: number | null | undefined) => {
  if (m == null) return '—';
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  if (h < 24) return `${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
};
// v1.176.0 — `nowMs` lets a caller pass its ticking clock so the age re-renders.
export const fmtRel = (ts: number | null | undefined, nowMs: number = Date.now()) => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
export const socColor = (soc: number | null | undefined) => {
  if (soc == null) return 'bg-muted';
  if (soc >= 50) return 'bg-ok';
  if (soc >= 25) return 'bg-warn';
  return 'bg-bad';
};
