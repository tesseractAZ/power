/**
 * Glossary of metric/jargon labels → plain-language explanations, plus a global
 * hook that applies them as hover tooltips.
 *
 * Rather than hand-adding `title=` to ~150 label sites across every page, a
 * single MutationObserver-driven scan walks the DOM, finds leaf text elements
 * whose text matches a glossary term, and sets their `title`. New pages and
 * components are covered automatically — just add the term here.
 */

const GLOSSARY: Record<string, string> = {};

/** Register one explanation under one or more `|`-separated label keys. */
function def(keys: string, text: string): void {
  for (const k of keys.split('|')) GLOSSARY[k.trim()] = text;
}

/* ── Battery / packs ── */
def('soc|state of charge', 'State of charge — how full the battery is right now, 0–100%.');
def('avg soc', 'Average state of charge across every online battery pack in the fleet.');
def('soh|state of health|avg soh', 'State of health — measured usable capacity vs the pack’s original design capacity. A wear gauge; 100% = like-new.');
def('ocv|open-circuit', 'Open-circuit voltage — the pack’s resting voltage with no load applied.');
def('cell spread|worst cell spread|cell imbalance|cell spread now', 'Cell-voltage spread — the gap between the highest and lowest cell in a pack. A widening gap is an early sign of imbalance.');
def('cell mean', 'Average voltage across all of the pack’s cells.');
def('pack volt', 'Pack terminal voltage.');
def('rep temp', 'Representative pack temperature reported by the BMS.');
def('cell max|cell min', 'Hottest / coldest individual cell temperature in the pack.');
def('cell temperatures', 'Per-cell temperature sensors inside the pack.');
def('cell voltages', 'Per-cell voltage, each shown with its deviation from the pack mean.');
def('mos max|mosfet temperatures|mosfet temps|mosfet', 'Power-MOSFET temperature — the BMS switching transistors.');
def('board', 'BMS circuit-board temperature.');
def('shunt', 'Current-shunt temperature — the precision resistor the BMS measures pack current across.');
def('ptc heater temperatures|ptc heater temps|ptc', 'PTC heater temperature — keeps the cells warm enough to charge safely in the cold.');
def('cycles', 'Equivalent full charge/discharge cycles the pack has completed — a measure of battery age.');
def('lifetime throughput', 'Total energy ever charged into and discharged out of the pack.');
def('capacity', 'Energy the battery can store, in kWh.');
def('balancing|cells balancing', 'The BMS is equalizing cell voltages — routine housekeeping, no action needed.');
def('hottest pack', 'The warmest pack across the fleet right now.');
def('vitals', 'The pack’s key live readings at a glance.');

/* ── Power flow ── */
def('pv|pv in|pv total|photovoltaic', 'Photovoltaic — solar-panel power.');
def('pv high mppt|pv low mppt', 'Power from one of the DPU’s two solar strings (high- or low-voltage MPPT input).');
def('ac out|ac output', 'AC power flowing out of the inverter to your loads.');
def('ac in', 'AC power flowing into the inverter — grid or generator charging.');
def('ac out freq / v', 'Inverter AC output frequency (Hz) and voltage.');
def('total in / out', 'Total power into and out of the DPU across every input and output.');
def('battery v / a', 'Internal battery-bus voltage and current.');
def('in|out', 'Power flowing in to / out of the device.');
def('input|output', 'Power flowing into (charging) or out of (discharging) the pack.');
def('panel load', 'Total power the SHP2’s circuits are drawing right now.');
def('live contribution|live draw', 'Power this device is feeding/drawing right now.');
def('voltage|current', 'Live electrical voltage / current at this input.');
def('v × a', 'Voltage × current — instantaneous power, shown as a cross-check on the reported watts.');
def('string ω', 'Effective resistance (volts ÷ amps) at the MPPT string’s operating point.');

/* ── MPPT / solar ── */
def('mppt|mppt temp|mppt hv|mppt lv|hv mppt|lv mppt', 'MPPT — the solar charge controller (Maximum Power Point Tracker). Each DPU has two: a high-voltage and a low-voltage string input.');
def('hv channels|lv channels', 'High-/low-voltage MPPT solar string inputs — one of each per DPU.');
def('ghi', 'Global Horizontal Irradiance — total sunlight energy on a flat surface (W/m²); the raw “how sunny” number the forecast is built from.');
def('producing now', 'Solar power being generated right now.');
def('peak today', 'The highest solar power reached so far today.');
def('coefficient|peak response|response coefficient', 'Learned response coefficient — watts of PV produced per W/m² of sunlight. Captures panel size, orientation, shading and inverter clipping.');
def('strongest hour', 'The hour of day your arrays convert sunlight to power most efficiently — reveals their orientation.');
def('observed peak pv', 'The highest PV output actually recorded at this hour-of-day.');
def('soiling', 'Dust/pollen on the panels cutting output. Detected by comparing clear-sky production to the cleanest day on record.');
def('output drop', 'How far clear-sky solar output has fallen below the clean-panel baseline — the soiling indicator.');

/* ── SHP2 ── */
def('backup|backup pool', 'SHP2 backup pool — the combined battery the Smart Home Panel draws on.');
def('backup %', 'Backup-pool state of charge, trended over the last hour.');
def('reserve floor|backup reserve|reserve', 'Reserve floor — the state of charge held back for backup. Loads begin shedding below it.');
def('solar reserve', 'Target state of charge to keep in reserve specifically when running on solar.');
def('mid-priority floor', 'The SoC at which mid-priority circuits are cut to protect the battery.');
def('charge power', 'Power currently flowing into the battery.');
def('charge time', 'Estimated time to fully charge the battery.');
def('rated power', 'The device’s rated maximum power output.');
def('ems bat temp', 'Battery temperature as reported by the SHP2’s energy-management system.');
def('hw link', 'Hardware (wired) link status between the SHP2 and this DPU.');
def('load-shed strategy', 'The SHP2’s automatic plan for dropping circuits as the battery depletes.');
def('smart backup mode', 'The SHP2’s backup-behaviour mode setting.');
def('charge schedule', 'The SHP2’s time-of-use scheduled charging windows.');
def('error code|direct errors|shp2 errors', 'Device-reported error code — 0 means no fault.');

/* ── EV charger ── */
def('charging power', 'Power the EV charger is drawing, over the last 24 hours.');
def('sessions today', 'Charging sessions detected today — a sustained draw above 1 kW.');
def('host dpu|dpu battery', 'The Delta Pro Ultra the EV charger is wired to — that DPU’s AC output equals the charging draw.');
def('direct telemetry', 'Raw data straight from the device over MQTT, rather than inferred.');

/* ── Forecast & learned ── */
def('solar next 24 h|solar next 24h', 'Projected solar production, from the cloud forecast run through your learned array model.');
def('forecast load|forecast load 24 h|typical solar / day', 'Projected household load from the typical-day consumption curve.');
def('forecast pv', 'Projected PV output for this hour.');
def('projected low soc', 'The lowest the battery is forecast to reach over the next 24 hours.');
def('cloud cover', 'Forecast cloud cover — what derates the solar prediction each hour.');
def('outlook', 'At-a-glance battery comfort vs the reserve floor: Comfortable, Watch or Tight.');
def('history depth', 'Days of recorded data behind the forecast and learned models — they sharpen as it grows.');
def('confidence', 'How trustworthy the learned model is, based on how many samples it has.');
def('z-score|peer z-score', 'Modified z-score — how many robust deviations a reading sits from normal. Higher = more anomalous; ≥ 3.5 flags, ≥ 5 warns.');
def('fit quality|fit r²', 'R-squared — how well the trend line fits the data, 0–1. Higher means a more trustworthy projection.');
def('samples|regression samples', 'How many data points the estimate is built from — more points, more reliable.');
def('sibling median', 'The median reading across the pack’s four siblings — the “normal” this pack is compared against.');
def('this pack', 'This pack’s current reading.');
def('deviation', 'How far this reading sits from the expected/normal value.');
def('baseline window', 'The span of history and number of samples behind the self-baseline.');
def('decline rate|rise rate', 'How fast the value is changing, per unit time.');

/* ── Degradation / end-of-life ── */
def('end-of-life|eol|projected eol|reaches 80%', 'End of life — the 80%-SoH point where a pack has lost a fifth of its original capacity; the conventional LFP replacement mark.');
def('fade rate|fade / yr|avg fade rate', 'How fast measured capacity (State of Health) is falling — SoH percentage points lost per year.');
def('service left|years left|years to eol', 'Projected years of service remaining before the pack reaches the 80% end-of-life threshold.');
def('eol threshold', 'The State of Health at which a pack counts as end-of-life — conventionally 80% for LFP cells.');
def('packs projecting', 'How many packs have a firm enough SoH trend to project an end-of-life date.');
def('soonest eol', 'The pack across the fleet projected to reach end-of-life first.');
def('cycles at eol', 'Projected equivalent full-cycle count by the time the pack reaches end-of-life.');
def('data span', 'Days of recorded history the projection is regressed over.');
def('projection notes', 'Plain-language end-of-life verdict for each pack with a firm fade trend.');
def('trend', 'Whether a pack has a projected fade trend, is stable, is still learning, or has no data yet.');

/* ── Alerts — ISA-18.2 / IEC 62682 priority taxonomy ── */
// Priorities mirror PRIORITY_META in alertPriority.ts. Legacy severity keys
// (warning / info) are kept as aliases so existing label sites still resolve.
def(
  'critical|crit|p1|priority 1',
  'Critical (P1) — immediate action required to protect people, the battery, or the plant from imminent harm.',
);
def(
  'high|high priority|p2|priority 2',
  'High (P2) — a protective hardware limit has been crossed. Prompt operator action is needed.',
);
def(
  'medium|med|warning|warnings|p3|priority 3',
  'Medium (P3) — a learned/statistical anomaly deviating from the normal baseline. Investigate before it escalates.',
);
def(
  'low|info|informational|p4|priority 4',
  'Low (P4) — advisory for situational awareness. No immediate action expected.',
);
def('anomalies', 'Things unusual right now — flagged by peer comparison and self-baseline.');
def('forecasts', 'Where things are heading — runtime, degradation and day-ahead projections.');
def('actionable', 'Critical, High & Medium items that may need attention.');
def('recently cleared', 'Alerts that were raised and have since resolved, with how long each lasted.');

/* ── Misc ── */
def('today', 'Energy totals since local midnight.');
def('solar produced', 'Total solar energy harvested today.');
def('batteries', 'Net battery energy today — negative means net charged, positive means net discharged.');

/** Normalize a label for lookup — drop a trailing "· …" or "( …)" and lowercase. */
function normalize(s: string): string {
  return s.split('·')[0].split('(')[0].replace(/\s+/g, ' ').trim().toLowerCase();
}

function hintFor(text: string): string | undefined {
  const n = normalize(text);
  return n ? GLOSSARY[n] : undefined;
}

/**
 * Scan the document and attach `title` tooltips to every leaf label element
 * whose text is a known glossary term. Re-runs (coalesced per frame) whenever
 * the DOM changes, so new pages get covered. Returns a cleanup function.
 */
export function installGlossaryTooltips(): () => void {
  const apply = () => {
    document.body.querySelectorAll('*').forEach((el) => {
      if (el.childElementCount !== 0) return; // text-only leaf elements
      if (el instanceof SVGElement) return; // SVG ignores HTML title tooltips
      const h = hintFor(el.textContent ?? '');
      if (h && el.getAttribute('title') !== h) el.setAttribute('title', h);
    });
  };
  // Coalesce rescans. Under the live 1 Hz snapshot re-render the body churns
  // ~30 childList mutations/sec; a full rescan is cheap (~1 ms) but pointless to
  // run per-mutation. The old code coalesced per animation frame (rAF), which
  // already collapsed that to ~2 rescans/sec. We bound it further to at most one
  // rescan per RESCAN_THROTTLE_MS, TRAILING-guaranteed: continuous churn can't
  // starve it, and a settled burst always gets a final scan. A mutation after
  // idle still scans near-immediately (wait clamps to 0) — only sustained churn
  // is throttled, so newly-rendered content gets its hover tooltip within at most
  // RESCAN_THROTTLE_MS, imperceptible for a `title=` that only matters on hover.
  // Measured: ~2/sec → ~1/sec on desktop; a bigger relative cut on slow mobile.
  const RESCAN_THROTTLE_MS = 1000;
  let timer = 0;
  let lastRun = 0;
  const schedule = () => {
    if (timer) return; // a rescan is already queued
    const wait = Math.max(0, RESCAN_THROTTLE_MS - (performance.now() - lastRun));
    timer = window.setTimeout(() => {
      timer = 0;
      lastRun = performance.now();
      apply();
    }, wait);
  };
  apply();
  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { childList: true, subtree: true });
  return () => {
    mo.disconnect();
    if (timer) clearTimeout(timer);
  };
}
