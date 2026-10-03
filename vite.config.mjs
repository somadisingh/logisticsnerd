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
        const procurement = procurementMiddleware(getEnv, { compareQuotes, validateComparisonInput }, suppliers);
        server.middlewares.use(procurement);
        server.httpServer?.once('close', () => { void procurement.close(); });
      },
      configurePreviewServer(server) {
        server.middlewares.use(shippingMiddleware(getEnv));
        const procurement = procurementMiddleware(getEnv, { compareQuotes, validateComparisonInput }, suppliers);
        server.middlewares.use(procurement);
        server.httpServer?.once('close', () => { void procurement.close(); });
      },
    }],
    build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), shipping: resolve(import.meta.dirname, 'shipping-lab.html') } } },
  };
});
