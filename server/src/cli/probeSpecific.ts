import { ecoflow } from '../ecoflow/rest.js';

/**
 * Test the single-quota endpoint with common field name guesses for various
 * EcoFlow product families. Reports which keys returned values vs which were
 * silently empty — letting us discover the actual schema for devices that
 * block /quota/all.
 */

const COMMON_KEYS: Record<string, string[]> = {
  delta_3_plus: [
    'bms_bmsStatus.soc', 'bms_bmsStatus.f32ShowSoc', 'bms_bmsStatus.soh', 'bms_bmsStatus.temp',
    'bms_bmsStatus.minCellVol', 'bms_bmsStatus.maxCellVol', 'bms_bmsStatus.maxCellTemp',
    'bms_bmsStatus.remainCap', 'bms_bmsStatus.fullCap', 'bms_bmsStatus.cycles',
    'pd.soc', 'pd.wattsInSum', 'pd.wattsOutSum', 'pd.remainTime',
    'pd.usb1Watts', 'pd.usb2Watts', 'pd.typec1Watts', 'pd.typec2Watts',
    'inv.outputWatts', 'inv.inputWatts', 'inv.acInFreq', 'inv.acInVol', 'inv.acInAmp',
    'inv.outFreq', 'inv.outAmp', 'inv.outVol', 'inv.invType',
    'inv.dcInVol', 'inv.dcInAmp',
    'mppt.inWatts', 'mppt.inVol', 'mppt.inAmp', 'mppt.inTemp',
  ],
  river_3_plus: [
    'bms_bmsStatus.soc', 'bms_bmsStatus.soh', 'bms_bmsStatus.temp',
    'bms_bmsStatus.minCellVol', 'bms_bmsStatus.maxCellVol',
    'bms_bmsStatus.remainCap', 'bms_bmsStatus.fullCap', 'bms_bmsStatus.cycles',
    'pd.soc', 'pd.wattsInSum', 'pd.wattsOutSum', 'pd.remainTime',
    'inv.outputWatts', 'inv.inputWatts', 'inv.acInVol', 'inv.outFreq', 'inv.outAmp',
  ],
  powerinsight: [
    'sense.l1Pwr', 'sense.l2Pwr', 'sense.l1Vol', 'sense.l2Vol',
    'sense.l1Amp', 'sense.l2Amp', 'sense.totalPwr', 'sense.dailyEnergy',
    'pd.totalPwr', 'pd.l1Pwr', 'pd.l2Pwr',
    'ct.ch1Pwr', 'ct.ch2Pwr', 'ct.ch3Pwr', 'ct.ch4Pwr',
  ],
};

async function probe(sn: string, productGuess: string) {
  const candidates = COMMON_KEYS[productGuess] ?? [];
  if (!candidates.length) {
    console.log(`No candidate key list for product ${productGuess}`);
    return;
  }
  console.log(`Trying ${candidates.length} candidate keys on ${sn} (${productGuess})...`);
  try {
    const res = await ecoflow.getQuotaSpecific(sn, candidates);
    const got = Object.keys(res ?? {}).sort();
    console.log(`  Returned ${got.length} fields:`);
    for (const k of got) {
      console.log(`    ${k} = ${JSON.stringify(res[k])}`);
    }
    const missed = candidates.filter((k) => !(k in (res ?? {})));
    if (missed.length) {
      console.log(`  Unknown / not-returned (${missed.length}):`, missed.slice(0, 8).join(', ') + (missed.length > 8 ? ', …' : ''));
    }
  } catch (e: any) {
    console.log(`  FAILED: ${e.message}`);
  }
}

async function main() {
  const tests: Array<{ sn: string; product: string }> = [
    { sn: 'P351ZA1APH6G0413', product: 'delta_3_plus' },
    { sn: 'P351ZAH4PGCU0216', product: 'delta_3_plus' },
    { sn: 'R631ZABAWH1S0633', product: 'river_3_plus' },
    { sn: 'HT31ZAB51G760667', product: 'powerinsight' },
  ];
  for (const t of tests) {
    console.log(`\n=== ${t.sn} (${t.product}) ===`);
    await probe(t.sn, t.product);
  }
}

main().catch((e) => {
  console.error('Top-level error:', e.message);
  process.exit(1);
});
