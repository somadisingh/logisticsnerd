import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { loadEnv } from 'vite';
import { createComparisonRunner, providers } from '../server/shipping.mjs';

const args = process.argv.slice(2);
const fixturePath = args.find((arg) => !arg.startsWith('--'));
const selected = args.find((arg) => arg.startsWith('--providers='))?.split('=')[1].split(',') ?? providers;
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const deadline = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10);
const parcel = fixturePath ? JSON.parse(await readFile(fixturePath, 'utf8')) : {
  product: 'One packed parcel of office stationery', fromPostal: '07102', toPostal: '30303',
  lengthCm: 30, widthCm: 20, heightCm: 10, weightKg: 1, pickupTime: `${tomorrow}T10:00`, deadline, carrier: 'ups',
};
const result = await createComparisonRunner({ env: loadEnv('development', process.cwd(), '') })(parcel, selected);
await mkdir('.local-planning/api-research/shipping-tests', { recursive: true });
const path = `.local-planning/api-research/shipping-tests/comparison-${Date.now()}.json`;
await writeFile(path, JSON.stringify(result, null, 2));
console.table(result.results.map((r) => ({ provider: r.name, mode: r.mode, status: r.status, apiCalls: r.traces.length, rates: r.rates.length, deadlineEstimates: r.rates.filter((v) => v.deadlineAssessment !== 'unknown').length, durationMs: r.durationMs })));
console.log(`Saved normalized evidence: ${path}`);
