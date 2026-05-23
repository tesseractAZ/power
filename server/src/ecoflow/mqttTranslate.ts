/**
 * Translate EcoFlow MQTT param payloads (keyed by cmdId) into the REST quota
 * schema (`hs_yj751_pd_appshow_addr.*`, `hs_yj751_pd_backend_addr.*`,
 * `hs_yj751_bms_slave_addr.{N}.*`) so they can be merged into the same raw cache
 * the projectors already read from. Mapping discovered empirically from live trace
 * on a Delta Pro Ultra (Y711…). Other DPU firmwares should be similar.
 *
 * cmdIds (DPU):
 *   1  – appshow snapshot (top-level summary)
 *   2  – backend snapshot (PCS / MPPT / AC out detail)
 *   4  – bpInfo[] per-pack incremental (bp* schema)
 *   21 – single field powGetPvH (alias for inHvMpptPwr)
 *   28 – per-pack BMS detail (identified by packSn lookup)
 */

type Raw = Record<string, unknown>;

export function translateDpuMqtt(
  cmdId: number,
  param: Raw,
  currentRaw: Raw | undefined,
): Raw | null {
  switch (cmdId) {
    case 1:
      return prefixKeys(param, 'hs_yj751_pd_appshow_addr.');
    case 2:
      return prefixKeys(param, 'hs_yj751_pd_backend_addr.');
    case 21:
      if (typeof param.powGetPvH === 'number') {
        return { 'hs_yj751_pd_appshow_addr.inHvMpptPwr': param.powGetPvH };
      }
      return null;
    case 28: {
      if (typeof param.packSn !== 'string' || !currentRaw) return null;
      const target = param.packSn;
      for (let i = 1; i <= 5; i++) {
        if (currentRaw[`hs_yj751_bms_slave_addr.${i}.packSn`] === target) {
          return prefixKeys(param, `hs_yj751_bms_slave_addr.${i}.`);
        }
      }
      return null;
    }
    case 4: {
      if (!Array.isArray(param.bpInfo)) return null;
      const out: Raw = {};
      for (const bp of param.bpInfo as Array<Record<string, unknown>>) {
        const num = typeof bp.bpNo === 'number' ? bp.bpNo : null;
        if (num == null) continue;
        const base = `hs_yj751_bms_slave_addr.${num}.`;
        if (typeof bp.bpSoc === 'number') out[`${base}soc`] = bp.bpSoc;
        if (typeof bp.bpTemp === 'number') out[`${base}temp`] = bp.bpTemp;
        if (typeof bp.remainTime === 'number') out[`${base}remainTime`] = bp.remainTime;
        if (typeof bp.bpErrCode === 'number') out[`${base}errCode`] = bp.bpErrCode;
        if (typeof bp.bpPwr === 'number') {
          // Convention from EcoFlow firmware: positive bpPwr = discharging (out),
          // negative = charging (in). Translate to REST's two-field shape.
          if (bp.bpPwr >= 0) {
            out[`${base}outputWatts`] = bp.bpPwr;
            out[`${base}inputWatts`] = 0;
          } else {
            out[`${base}inputWatts`] = -bp.bpPwr;
            out[`${base}outputWatts`] = 0;
          }
        }
      }
      return Object.keys(out).length > 0 ? out : null;
    }
    default:
      return null;
  }
}

function prefixKeys(obj: Raw, prefix: string): Raw {
  const out: Raw = {};
  for (const [k, v] of Object.entries(obj)) {
    out[`${prefix}${k}`] = v;
  }
  return out;
}
