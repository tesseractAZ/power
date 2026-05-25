/**
 * scripts/probe-shp2-reboot-direct.ts
 *
 * One-off direct probe to EcoFlow's IoT Open API using the existing
 * sendCommand helper. Faster than going through the running add-on:
 * we skip the WRITE_DEBUG_TOKEN dance entirely and just sign the
 * request locally with creds from server/.env.
 *
 * Usage (from repo root):
 *   node --env-file=server/.env --import=tsx scripts/probe-shp2-reboot-direct.ts \
 *     <sn> <comma-separated 1-based candidate indices>
 *
 * Example — try only the safest two:
 *   ... probe-shp2-reboot-direct.ts HD31ZASAHH120432 1,10
 *
 * Candidates (same as scripts/probe-shp2-reboot.sh, kept in sync):
 *   1: { cmdCode: "PD303_APP_SET", params: {} }                    SAFE-ish (no params)
 *   2: { cmdCode: "PD303_APP_SET", params: { backupReserveSoc:20 } } WRITES state — skip unless cur=20
 *   3: { cmdCode: "PD303_REBOOT", params: {} }                     speculative reboot
 *   4: { cmdCode: "PD303_APP_REBOOT", params: {} }                 speculative reboot
 *   5: { cmdCode: "PD303_RESET", params: {} }                      speculative reset
 *   6: { cmdCode: "PD303_SYS_REBOOT", params: {} }                 speculative system reboot
 *   7: { cmdCode: "PD303_APP_SET", params: { reboot: 1 } }         set-with-reboot-flag
 *   8: { moduleType: 1, operateType: "reboot", params: {} }        legacy SHP1 shape
 *   9: { moduleType: 1, operateType: "powerOff", params: {} }      legacy SHP1 shape
 *  10: { cmdSet: 11, cmdId: 17, params: {} }                       v0.9.6 (known fail 8524)
 */

import { ecoflow } from '../server/src/ecoflow/rest.js';

const CANDIDATES: Record<number, { label: string; body: Record<string, unknown> }> = {
  1:  { label: 'PD303_APP_SET empty',           body: { cmdCode: 'PD303_APP_SET', params: {} } },
  2:  { label: 'PD303_APP_SET backupReserveSoc:20 (WRITES)', body: { cmdCode: 'PD303_APP_SET', params: { backupReserveSoc: 20 } } },
  3:  { label: 'PD303_REBOOT',                  body: { cmdCode: 'PD303_REBOOT', params: {} } },
  4:  { label: 'PD303_APP_REBOOT',              body: { cmdCode: 'PD303_APP_REBOOT', params: {} } },
  5:  { label: 'PD303_RESET',                   body: { cmdCode: 'PD303_RESET', params: {} } },
  6:  { label: 'PD303_SYS_REBOOT',              body: { cmdCode: 'PD303_SYS_REBOOT', params: {} } },
  7:  { label: 'PD303_APP_SET reboot:1',        body: { cmdCode: 'PD303_APP_SET', params: { reboot: 1 } } },
  8:  { label: 'legacy operateType:reboot',     body: { moduleType: 1, operateType: 'reboot', params: {} } },
  9:  { label: 'legacy operateType:powerOff',   body: { moduleType: 1, operateType: 'powerOff', params: {} } },
  10: { label: 'DPU cmdSet:11 cmdId:17 (v0.9.6 baseline)', body: { cmdSet: 11, cmdId: 17, params: {} } },
};

async function main() {
  const [sn, idxList] = process.argv.slice(2);
  if (!sn || !idxList) {
    console.error('usage: probe-shp2-reboot-direct.ts <sn> <indices>  e.g.  HD31ZASAHH120432 1,10');
    process.exit(2);
  }
  const indices = idxList.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && CANDIDATES[n]);
  if (indices.length === 0) {
    console.error('No valid candidate indices. Valid: 1-10.');
    process.exit(2);
  }

  console.log(`── SHP2 reboot direct probe ──────────────────────────────────────`);
  console.log(`  sn         : ${sn}`);
  console.log(`  candidates : ${indices.join(', ')}`);
  console.log(`──────────────────────────────────────────────────────────────────`);

  for (const i of indices) {
    const c = CANDIDATES[i];
    console.log(`\n[${i}] ${c.label}`);
    console.log(`     body: ${JSON.stringify(c.body)}`);
    const t0 = Date.now();
    try {
      const data = await ecoflow.sendCommand(sn, c.body);
      const dt = Date.now() - t0;
      console.log(`     → SUCCESS  code:0  message:ok  durationMs:${dt}  data:${JSON.stringify(data)}`);
    } catch (e: any) {
      const dt = Date.now() - t0;
      console.log(`     → FAILURE  ${String(e?.message ?? e)}  (${dt}ms)`);
    }
    // Be polite to EcoFlow.
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
