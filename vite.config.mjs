import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { shippingMiddleware } from './server/middleware.mjs';
import { procurementMiddleware } from './server/procurement-middleware.mjs';
import { compareQuotes } from './src/domain/compare.ts';
import { validateComparisonInput } from './src/domain/validate.ts';
import { suppliers } from './src/data.ts';

export default defineConfig(({ mode }) => {
  const getEnv = () => loadEnv(mode, process.cwd(), '');
  return {
    plugins: [{
      name: 'local-shipping-comparison',
      configureServer(server) {
        server.middlewares.use(shippingMiddleware(getEnv));
        server.middlewares.use(procurementMiddleware(getEnv, { compareQuotes, validateComparisonInput }, suppliers));
      },
      configurePreviewServer(server) {
        server.middlewares.use(shippingMiddleware(getEnv));
        server.middlewares.use(procurementMiddleware(getEnv, { compareQuotes, validateComparisonInput }, suppliers));
      },
    }],
    build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), shipping: resolve(import.meta.dirname, 'shipping-lab.html') } } },
  };
});
