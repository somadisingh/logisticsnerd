import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { shippingMiddleware } from './server/middleware.mjs';
import { procurementMiddleware } from './server/procurement-middleware.mjs';
import { workflowDemoMiddleware } from './server/workflow-demo.mjs';
import { compareQuotes } from './src/domain/compare.ts';
import { validateComparisonInput } from './src/domain/validate.ts';
import { suppliers } from './src/data.ts';

export default defineConfig(({ mode }) => {
  const getEnv = () => loadEnv(mode, process.cwd(), '');
  return {
    plugins: [{
      name: 'local-shipping-comparison',
      configureServer(server) {
        const workflow = workflowDemoMiddleware();
        server.middlewares.use(workflow);
        server.httpServer?.once('close', () => workflow.close());
        server.middlewares.use(shippingMiddleware(getEnv));
        const procurement = procurementMiddleware(getEnv, { compareQuotes, validateComparisonInput }, suppliers);
        server.middlewares.use(procurement);
        server.httpServer?.once('close', () => { void procurement.close(); });
      },
      configurePreviewServer(server) {
        const workflow = workflowDemoMiddleware();
        server.middlewares.use(workflow);
        server.httpServer?.once('close', () => workflow.close());
        server.middlewares.use(shippingMiddleware(getEnv));
        const procurement = procurementMiddleware(getEnv, { compareQuotes, validateComparisonInput }, suppliers);
        server.middlewares.use(procurement);
        server.httpServer?.once('close', () => { void procurement.close(); });
      },
    }],
    build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), comparison: resolve(import.meta.dirname, 'supplier-comparison.html'), shipping: resolve(import.meta.dirname, 'shipping-lab.html') } } },
  };
});
