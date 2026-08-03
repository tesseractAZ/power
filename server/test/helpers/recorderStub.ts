/**
 * Shared no-op `Recorder` stub for tests.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Before test/ was type-checked, ~15 test files each hand-rolled their own
 * recorder stub as `{ …7 members } as unknown as Recorder`. That idiom is
 * doubly corrosive:
 *
 *   1. `as unknown` erases the contextual type, so TypeScript stopped inferring
 *      parameter types for the stubbed methods — every `(_sn, metric) => …`
 *      silently became implicit-`any` (26 TS7006s once the suite was checked).
 *   2. The double assertion suppresses the excess/missing-property check
 *      entirely, so as `Recorder` grew from 7 members to 17 the stubs never
 *      complained. All of them were 10 members behind: telemetryGaps,
 *      recordWeatherGhi, recordForecastArchive, recordNightPlan,
 *      recordNightOutcome, readNightLedger, readNightCalibration,
 *      upsertNightCalibration, listLifetimeKeys, batteryLifetimeDebug.
 *
 * `makeRecorderStub(overrides: Partial<Recorder>)` fixes both at once: the
 * parameter is a real `Partial<Recorder>`, so contextual typing flows into the
 * override arrows (no implicit any), and the base object supplies every member,
 * so the result is a genuine `Recorder` with no assertion anywhere.
 *
 * ── Why the 10 members were NOT made optional ────────────────────────────────
 * Marking them `?` on the interface would have silenced the same errors in one
 * line. It was rejected deliberately: production code calls all ten
 * unconditionally, so optionality would force `?.`/fallback guards into src/
 * for a case that cannot happen at runtime, and would permanently disarm the
 * drift detector that just caught this. (`queryFirstLast?` is a legitimate
 * exception — it is documented as a perf fast-path with a mandatory `query()`
 * fallback at every call site.)
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   const rec = makeRecorderStub({ query: (_sn, metric) => rows[metric] ?? [] });
 *
 *   // with a call counter
 *   return { ...makeRecorderStub({ query: () => { n++; return []; } }),
 *            get queryCount() { return n; } };
 *
 * Overrides are spread LAST, so a caller always wins over the no-op default.
 */
import type {
  Recorder,
  TelemetryGap,
  LifetimeTotals,
  NightLedgerRow,
  NightCalibration,
  BatteryLifetimeDebug,
} from '../../src/recorder.js';

/** Read-only diagnostics shape with every field at its empty/zero identity. */
function emptyBatteryLifetimeDebug(): BatteryLifetimeDebug {
  return {
    rawChargeFloorWh: 0,
    rawDischargeFloorWh: 0,
    emittedChargeWh: 0,
    emittedDischargeWh: 0,
    charge: { persistedWh: 0, pendingWh: 0 },
    discharge: { persistedWh: 0, pendingWh: 0 },
    deficitWh: 0,
    packs: [],
    offlineHeldMembers: [],
  };
}

/**
 * A complete, inert `Recorder`. Every reader returns an empty result and every
 * writer is a no-op; nothing touches sqlite or the filesystem.
 *
 * `queryFirstLast` is deliberately NOT supplied. It is the one genuinely
 * optional member, and every consumer is required to fall back to `query()`
 * when it is absent — which is the path each of these stubs already took while
 * they were assertion-cast. Providing an empty-array implementation here would
 * silently divert those consumers onto the fast path and hand them no data,
 * changing behaviour under the guise of a type fix. A test that wants to
 * exercise the fast path passes it in `overrides`.
 *
 * @param overrides only the members the test actually cares about. Typed
 *   `Partial<Recorder>`, which is what restores contextual typing for the
 *   arrow parameters (and rejects a member whose signature has drifted).
 */
export function makeRecorderStub(overrides: Partial<Recorder> = {}): Recorder {
  const base: Recorder = {
    insertSnapshot: () => {},
    query: (): Array<{ ts: number; value: number }> => [],
    queryMulti: (_sn: string, metrics: string[]) =>
      new Map<string, Array<{ ts: number; value: number }>>(metrics.map((m) => [m, []])),
    listMetrics: (): string[] => [],
    telemetryGaps: (): TelemetryGap[] => [],
    recordWeatherGhi: () => {},
    recordForecastArchive: () => {},
    recordNightPlan: () => {},
    recordNightOutcome: () => {},
    readNightLedger: (): NightLedgerRow[] => [],
    readNightCalibration: (): NightCalibration | null => null,
    upsertNightCalibration: () => {},
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: (): Record<string, LifetimeTotals> => ({}),
    listLifetimeKeys: (): string[] => [],
    batteryLifetimeDebug: emptyBatteryLifetimeDebug,
  };
  return { ...base, ...overrides };
}
