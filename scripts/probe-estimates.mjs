import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, loadEnv } from 'vite';
import { createEstimateRunner, MODEL_CONFIGS } from '../server/procurement.mjs';

// Reuse the TypeScript business rules through Vite, without opening a listener.
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const [{ compareQuotes }, { validateComparisonInput }, data] = await Promise.all([
    vite.ssrLoadModule('/src/domain/compare.ts'),
    vite.ssrLoadModule('/src/domain/validate.ts'),
    vite.ssrLoadModule('/src/data.ts'),
  ]);
  const env = loadEnv('development', process.cwd(), '');
  const run = createEstimateRunner({ env, rules: { compareQuotes, validateComparisonInput }, catalog: data.suppliers });
  const quick = process.argv.includes('--quick');
  const cases = [
    ...data.scenarios.map((scenario) => ({ id: scenario.id, draft: data.sampleDraft(scenario.id), expectation: 'estimated' })),
    ...(!quick ? [
      { id: 'custom-quantity', draft: { ...data.sampleDraft('chairs'), quantity: '75' }, expectation: 'estimated' },
      { id: 'ambiguous-goods', draft: { ...data.sampleDraft('chairs'), item: 'supplies' }, expectation: 'needs_clarification' },
      { id: 'impossible-constraints', draft: { ...data.sampleDraft('chairs'), deadline: '2026-10-02', budget: '1' }, expectation: 'no_feasible_quote' },
      { id: 'chairs-repeat', draft: data.sampleDraft('chairs'), expectation: 'estimated' },
    ] : []),
  ];
  const rows = [];
  for (const testCase of cases) {
    const request = data.requestFromDraft(testCase.draft);
    const body = { request, suppliers: data.suppliers.filter((supplier) => request.selectedSupplierIds.includes(supplier.id)).map(({ id, name }) => ({ id, name })), preference: 'lowest_cost' };
    const results = await Promise.all(MODEL_CONFIGS.map(async (model) => {
      const start = Date.now();
      try {
        const result = await run(body, { modelIds: [model.id], bypassCache: true });
        return { case: testCase.id, expectation: testCase.expectation, model: model.model, status: 'estimated', durationMs: Date.now() - start, expectationMet: testCase.expectation === 'estimated' || (testCase.expectation === 'no_feasible_quote' && result.comparisons.lowest_cost.outcome === 'no_feasible_quote'), result };
      } catch (error) {
        return { case: testCase.id, expectation: testCase.expectation, model: model.model, status: error.code ?? 'failed', durationMs: Date.now() - start, expectationMet: testCase.expectation === error.code, ...(error.clarification ? { clarification: error.clarification } : {}) };
      }
    }));
    rows.push(...results);
    console.log(JSON.stringify(results.map(({ result, ...summary }) => ({ ...summary, usage: result?.provenance.usage, cheapest: result?.comparisons.lowest_cost.recommendedSupplierIds, fastest: result?.comparisons.earliest_delivery.recommendedSupplierIds }))));
  }
  const summary = MODEL_CONFIGS.map((model) => {
    const matching = rows.filter((row) => row.model === model.model);
    const successful = matching.filter((row) => row.expectationMet);
    const latencies = successful.map((row) => row.durationMs).sort((a, b) => a - b);
    const middle = Math.floor(latencies.length / 2);
    const medianMs = !latencies.length ? null : latencies.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2;
    return { model: model.model, passed: successful.length, attempted: matching.length, medianMs, maxMs: latencies.at(-1) ?? null };
  });
  const directory = '.local-planning/api-research/baseten-tests';
  await mkdir(directory, { recursive: true });
  const path = `${directory}/comparison-${Date.now()}.json`;
  await writeFile(path, JSON.stringify({ checkedAt: new Date().toISOString(), syntheticEstimatesOnly: true, summary, rows }, null, 2));
  console.log(JSON.stringify({ report: path, summary }));
} finally { await vite.close(); }
