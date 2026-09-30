import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { shippingMiddleware } from './server/middleware.mjs';

export default defineConfig(({ mode }) => {
  const getEnv = () => loadEnv(mode, process.cwd(), '');
  return {
    plugins: [{
      name: 'local-shipping-comparison',
      configureServer(server) { server.middlewares.use(shippingMiddleware(getEnv)); },
      configurePreviewServer(server) { server.middlewares.use(shippingMiddleware(getEnv)); },
    }],
    build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), shipping: resolve(import.meta.dirname, 'shipping-lab.html') } } },
  };
});
