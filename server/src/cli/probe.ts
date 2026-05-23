import { ecoflow } from '../ecoflow/rest.js';

async function main() {
  const sn = process.argv[2];
  if (!sn) {
    console.error('Usage: npm run probe -- <SN>');
    console.error('Or: npm run probe -- all   (probes every online device)');
    process.exit(1);
  }

  if (sn === 'all') {
    const devices = await ecoflow.listDevices();
    for (const d of devices) {
      if (d.online !== 1) {
        console.log(`\n=== ${d.deviceName ?? d.sn} (${d.sn}) — OFFLINE, skipping ===`);
        continue;
      }
      console.log(`\n=== ${d.deviceName ?? d.sn} (${d.sn}) — ${d.productName ?? 'unknown product'} ===`);
      try {
        const quota = await ecoflow.getQuotaAll(d.sn);
        const keys = Object.keys(quota).sort();
        console.log(`  ${keys.length} fields`);
        for (const k of keys) {
          const v = quota[k];
          const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
          console.log(`    ${k} = ${display.length > 80 ? display.slice(0, 80) + '…' : display}`);
        }
      } catch (e: any) {
        console.log(`  ERROR: ${e.message}`);
      }
    }
    return;
  }

  console.log(`Probing ${sn} ...\n`);
  const quota = await ecoflow.getQuotaAll(sn);
  console.log(JSON.stringify(quota, null, 2));
}

main().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
