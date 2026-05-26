import type { FleetSnapshot } from './types.js';

export interface SnapshotStore {
  getSnapshot(): FleetSnapshot | null;
  subscribe(cb: (s: FleetSnapshot | null) => void): () => void;
  connectionState(): 'idle' | 'connecting' | 'open' | 'closed';
}

const stores = new Map<string, SnapshotStore>();

export function getStore(host: string): SnapshotStore {
  const existing = stores.get(host);
  if (existing) return existing;
  // PR1 stub: never connects, always returns null snapshot.
  // PR2 will implement real WS + reconnect/backoff.
  const stub: SnapshotStore = {
    getSnapshot: () => null,
    subscribe: (_cb) => () => {},
    connectionState: () => 'idle',
  };
  stores.set(host, stub);
  return stub;
}
