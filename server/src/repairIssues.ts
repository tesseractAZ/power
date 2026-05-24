import type { DeviceSnapshot } from './snapshot.js';
import type { Shp2Projection, DpuProjection } from './ecoflow/project.js';
import type { Alert } from './alerts.js';
import type { FleetDegradation, SoilingDecomposition, EquipmentHealth, ForecastSkillReport } from './analytics.js';

/**
 * Actionable maintenance items surfaced as repair issues.
 *
 * HA Core's Repair UI is integration-side (Python). This module ships
 * a REST endpoint + MQTT-discoverable `binary_sensor` for each active
 * repair so users can wire them into their own HA automations or
 * surface them in Lovelace cards. Each item has a stable id, severity,
 * and a step-by-step fix.
 *
 * Repair items are a curated SUBSET of alerts — only the ones where
 * the user can physically do something. "Cell imbalance" is a sensor
 * reading; "wash the east-facing panels" is a repair.
 */

export type RepairSeverity = 'critical' | 'warning' | 'info';

export interface RepairIssue {
  id: string;                  // stable id, machine-readable
  severity: RepairSeverity;
  title: string;               // short, scannable
  summary: string;             // 1-2 sentence diagnosis
  fixSteps: string[];          // ordered, actionable
  category: 'Cleaning' | 'Connectivity' | 'Hardware' | 'Configuration' | 'Storm' | 'Battery';
  estimatedTimeMinutes: number | null;
  // When the issue first surfaced (so HA can show "active for N hours")
  firstSeenAt: number;
}

export interface RepairIssuesReport {
  generatedAt: number;
  issues: RepairIssue[];
}

// Persistent "first-seen" map so the repair issue's age survives multiple
// fetches. Reset only when the issue clears.
const firstSeenById = new Map<string, number>();

function track(id: string, now: number): number {
  let ts = firstSeenById.get(id);
  if (ts == null) {
    ts = now;
    firstSeenById.set(id, ts);
  }
  return ts;
}

export interface RepairContext {
  devices: Record<string, DeviceSnapshot>;
  alerts: Alert[];
  degradation: FleetDegradation | null;
  soiling: SoilingDecomposition | null;
  equipmentHealth: EquipmentHealth | null;
  forecastSkill: ForecastSkillReport | null;
}

export function computeRepairIssues(ctx: RepairContext): RepairIssuesReport {
  const now = Date.now();
  const out: RepairIssue[] = [];

  // EcoFlow-zombie devices (cloud says offline) — actionable as power-cycle.
  for (const d of Object.values(ctx.devices)) {
    if (!d.online) {
      const id = `zombie-${d.sn}`;
      out.push({
        id,
        severity: 'warning',
        title: `${d.deviceName} marked offline by EcoFlow`,
        summary: `${d.deviceName} (${d.sn}) is flagged offline by EcoFlow Cloud. If the device's network adapter shows online on your router, this is the "EcoFlow zombie" state — MQTT TCP session wedged.`,
        fixSteps: [
          `Confirm ${d.deviceName} is physically powered on.`,
          `On your router, verify the device's IP is currently active.`,
          `Power-cycle the device's network connection (yank + reseat Ethernet, or toggle WiFi).`,
          `Wait ~2 minutes; the dashboard should clear the offline state automatically.`,
          `If still offline, full power-cycle the device (off ≥30 s, then on).`,
        ],
        category: 'Connectivity',
        estimatedTimeMinutes: 5,
        firstSeenAt: track(id, now),
      });
    }
  }

  // Soiling above wash threshold.
  if (ctx.soiling) {
    const perDpu = ctx.soiling.perDevice.filter(
      (d) => d.dropPct != null && d.dropPct >= 15 && d.cleanDays >= 6,
    );
    if (perDpu.length > 0) {
      const id = 'wash-panels';
      const worst = perDpu.reduce((b, d) => ((d.dropPct ?? 0) > (b.dropPct ?? 0) ? d : b), perDpu[0]);
      const worstDrop = worst.dropPct ?? 0;
      out.push({
        id,
        severity: worstDrop >= 22 ? 'warning' : 'info',
        title: `Wash solar panels (~${worstDrop}% output drop on ${worst.device})`,
        summary: `Per-DPU soiling decomposition shows ${perDpu.length} array(s) producing ${worstDrop}%+ less than the clean-panel baseline. Most of this loss is recoverable with a wash. Per-hour breakdown points to which direction is worst-affected.`,
        fixSteps: [
          'Plan the wash for a cool morning before peak sun.',
          'Use a soft-bristled brush + plain water (no soap, no high-pressure).',
          'Focus on the worst-affected array(s) identified in the soiling decomposition table.',
          'Re-check the panel soiling report 3-5 clear days later — drop% should recover toward 0%.',
        ],
        category: 'Cleaning',
        estimatedTimeMinutes: 60,
        firstSeenAt: track(id, now),
      });
    }
  }

  // Peer-outlier degradation packs — recommend rebalance / inspection.
  if (ctx.degradation) {
    const outliers = ctx.degradation.packs.filter((p) => p.peerOutlier);
    for (const p of outliers) {
      const id = `peer-outlier-${p.sn}-${p.packNum}`;
      out.push({
        id,
        severity: 'warning',
        title: `Pack wearing fast: Core ${p.coreNum} · Pack ${p.packNum}`,
        summary: `This pack is fading at ${(p.peerFadeRatio ?? 1).toFixed(1)}× the fleet-median rate — the fastest-wearing pack in its peer group. ${p.summary}`,
        fixSteps: [
          'Open the Core and inspect the pack for visible damage (swelling, leakage, scorch marks).',
          'Verify the pack temperature in the dashboard is within band (target < 113°F).',
          'Check thermal-event counter to see if this pack has historic overheat events that explain the fade.',
          'If the pack is under EcoFlow warranty (≤3 yrs), file a warranty claim before EOL.',
          'If out of warranty, plan replacement timing using the projected EOL date in the degradation card.',
        ],
        category: 'Battery',
        estimatedTimeMinutes: 30,
        firstSeenAt: track(id, now),
      });
    }
  }

  // MPPT efficiency drift — actionable if drift > 3 pp.
  if (ctx.equipmentHealth) {
    for (const s of ctx.equipmentHealth.mpptStrings) {
      if (s.driftPctPts != null && s.driftPctPts < -3) {
        const id = `mppt-drift-${s.sn}-${s.string}`;
        out.push({
          id,
          severity: 'info',
          title: `MPPT efficiency drift: Core ${s.coreNum} ${s.string} string`,
          summary: `This MPPT string has lost ${Math.abs(s.driftPctPts)} percentage points of conversion efficiency vs its baseline (recent ${s.recentEffPct}% vs baseline ${s.baselineEffPct}%). Could be cabling resistance creep, MPPT heat damage, or panel-side degradation.`,
          fixSteps: [
            `Inspect MC4 connectors on the ${s.string} string for corrosion or loose seating.`,
            'Check the DPU MPPT temperature — if elevated, improve ventilation around the unit.',
            'Compare per-panel watts with a clamp meter; one underperforming panel can drag the string.',
            'If drift continues, file an EcoFlow warranty inquiry on the MPPT.',
          ],
          category: 'Hardware',
          estimatedTimeMinutes: 20,
          firstSeenAt: track(id, now),
        });
      }
    }
  }

  // Forecast skill — if model bias has drifted far from 1.0, the model is mis-calibrated.
  if (ctx.forecastSkill?.biasFactor != null) {
    const bias = ctx.forecastSkill.biasFactor;
    if (Math.abs(bias - 1) > 0.25) {
      const id = 'forecast-bias';
      out.push({
        id,
        severity: 'info',
        title: `Forecast model bias drift (×${bias.toFixed(2)})`,
        summary: `The learned GHI→PV model is systematically over- or under-predicting recent days (actual ÷ predicted = ${bias.toFixed(2)}). Often resolves itself as the model accumulates more data, but worth checking if it persists.`,
        fixSteps: [
          'Let the model accumulate another 7-14 days; new history will re-train per-hour coefficients.',
          'Verify weather coordinates (FORECAST_LAT/LON) point to the actual install location.',
          'Check the recorder DB for sample gaps; missing samples make the per-hour fit noisy.',
        ],
        category: 'Configuration',
        estimatedTimeMinutes: 10,
        firstSeenAt: track(id, now),
      });
    }
  }

  // Active NWS storm — convert to repair item.
  for (const a of ctx.alerts.filter((x) => x.id.startsWith('storm-'))) {
    const id = a.id;
    out.push({
      id,
      severity: a.severity === 'critical' ? 'critical' : 'warning',
      title: a.title,
      summary: a.detail,
      fixSteps: [
        'Pre-charge the backup pool to 100% via the EcoFlow app before onset.',
        'Verify essential circuits are on the SHP2 backup-priority list.',
        'If forecast predicts grid loss, set backup-reserve floor to a higher value (e.g. 30%).',
        'Charge any portable devices (laptops, phones, flashlights) ahead of the event.',
      ],
      category: 'Storm',
      estimatedTimeMinutes: 30,
      firstSeenAt: track(id, now),
    });
  }

  // Clean up firstSeenById entries for issues no longer active.
  const currentIds = new Set(out.map((i) => i.id));
  for (const id of [...firstSeenById.keys()]) {
    if (!currentIds.has(id)) firstSeenById.delete(id);
  }

  return { generatedAt: now, issues: out };
}
