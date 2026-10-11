/**
 * v1.187.18 — which device-basis generation an analytics-worker report flight belongs to.
 *
 * The report chokepoint (reports.ts buildReport) advances the generation whenever it resets the
 * worker's result caches for a new device basis, and runs every report flight inside the
 * generation it was ASKED in. A flight still running when the generation moves on was computed
 * on the superseded map: its cache writes are dropped (cacheWritable), so nothing it computes
 * after the reset can be read by a flight on the new basis. Its own caller still gets its answer.
 *
 * Why a per-flight context and not a reset when the old flight settles: flights on two bases can
 * resume from ONE shared promise (the single-flighted weather fetch, cold at every worker start
 * and at each 2-h refresh), so the old flight's write and the new flight's read can fall in the
 * same microtask drain, before any settle hook runs. And a reset on settle also threw away what
 * flights on the CURRENT basis had just cached, each such reset chaining into the next.
 *
 * The context follows a flight through every await (AsyncLocalStorage). Code outside any flight
 * — tests calling a compute function directly, the main thread's derived reports — always writes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const flightGeneration = new AsyncLocalStorage<number>();
let generation = 0;

/** The current basis generation (advanced only when the chokepoint resets for a new basis). */
export function basisGeneration(): number { return generation; }

/** Advance the generation: every flight asked before now is on a superseded basis. */
export function advanceBasisGeneration(): number { generation += 1; return generation; }

/** Run a report flight in the generation it was asked in. */
export function runInBasisGeneration<T>(gen: number, fn: () => T): T { return flightGeneration.run(gen, fn); }

/** May the code running now write a worker result cache? Not inside a superseded flight. */
export function cacheWritable(): boolean {
  const g = flightGeneration.getStore();
  return g === undefined || g === generation;
}

/** Test seam: a fresh worker's generation. */
export function resetBasisGenerationForTesting(): void { generation = 0; }
