import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { shippingMiddleware } from './server/middleware.mjs';
import { procurementMiddleware } from './server/procurement-middleware.mjs';
import { workflowDemoMiddleware } from './server/workflow-demo.mjs';
import { createEstimateRunner } from './server/procurement.mjs';
import { createRedisCache } from './server/redis-cache.mjs';
import { compareQuotes } from './src/domain/compare.ts';
import { validateComparisonInput } from './src/domain/validate.ts';
import { suppliers } from './src/data.ts';

export default defineConfig(({ mode }) => {
  const getEnv = () => loadEnv(mode, process.cwd(), '');
  const estimatesFactory = (catalog) => {
    const cache = createRedisCache({ getEnv });
    return {
      run: createEstimateRunner({ env: getEnv, rules: { compareQuotes, validateComparisonInput }, catalog, pricing: 'unit', persistentCache: cache }),
      close: () => cache.close(),
    };
  };
  return {
    server: { proxy: { '/api/purchasing': { target: 'http://127.0.0.1:8001' } } },
    preview: { proxy: { '/api/purchasing': { target: 'http://127.0.0.1:8001' } } },
    plugins: [{
      name: 'local-shipping-comparison',
      configureServer(server) {
        const workflow = workflowDemoMiddleware({ estimatesFactory });
        server.middlewares.use(workflow);
        server.httpServer?.once('close', () => workflow.close());
        server.middlewares.use(shippingMiddleware(getEnv));
        const procurement = procurementMiddleware(getEnv, { compareQuotes, validateComparisonInput }, suppliers);
        server.middlewares.use(procurement);
        server.httpServer?.once('close', () => { void procurement.close(); });
      },
      configurePreviewServer(server) {
        const workflow = workflowDemoMiddleware({ estimatesFactory });
        server.middlewares.use(workflow);
        server.httpServer?.once('close', () => workflow.close());
        server.middlewares.use(shippingMiddleware(getEnv));
        const procurement = procurementMiddleware(getEnv, { compareQuotes, validateComparisonInput }, suppliers);
        server.middlewares.use(procurement);
        server.httpServer?.once('close', () => { void procurement.close(); });
      },
    }],
    build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), comparison: resolve(import.meta.dirname, 'supplier-comparison.html'), shipping: resolve(import.meta.dirname, 'shipping-lab.html'), purchasing: resolve(import.meta.dirname, 'purchasing.html') } } },
  };
});
