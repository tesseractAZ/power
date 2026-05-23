import { ecoflow } from '../ecoflow/rest.js';

async function main() {
  console.log('Calling EcoFlow /iot-open/sign/device/list ...\n');
  const devices = await ecoflow.listDevices();
  console.log(`Found ${devices.length} device(s):\n`);
  for (const d of devices) {
    console.log(`  - SN: ${d.sn}`);
    console.log(`    Name: ${d.deviceName ?? '(none)'}`);
    console.log(`    Product: ${d.productName ?? '(unknown)'}`);
    console.log(`    Online: ${d.online === 1 ? 'yes' : 'no'}`);
    console.log('');
  }
  console.log('--- Raw JSON ---');
  console.log(JSON.stringify(devices, null, 2));
}

main().catch((err) => {
  console.error('Discovery failed:', err.message);
  process.exit(1);
});
