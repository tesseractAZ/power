import { staleAsOf } from '../freshness';

/**
 * v1.176.0 — the marker a polled card shows when its last good payload is older than
 * pollStale() allows. The card keeps its figures (a blip must not blank it) but can no
 * longer present them as current.
 */
export function StaleNote({ lastOkAt, nowMs = Date.now() }: { lastOkAt: number | null; nowMs?: number }) {
  const at = staleAsOf(lastOkAt, nowMs);
  return (
    <span
      className="badge badge-warn normal-case tracking-normal"
      title="The add-on has not answered this card's refresh — the figures shown are from the last successful update, not now."
    >
      {at ? `stale · as of ${at}` : 'stale'}
    </span>
  );
}
