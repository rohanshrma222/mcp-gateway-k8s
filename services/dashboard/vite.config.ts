import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite config for the dashboard.
 *
 * Tailwind is wired as a Vite plugin rather than through PostCSS, which is the v4 way:
 * configuration lives in CSS (`@theme` in index.css) instead of a tailwind.config.js, so
 * there is one place design tokens are defined rather than two that can disagree.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // nginx caches /assets/* for a year with `immutable`, which is only safe because Vite
    // puts a content hash in each filename. This is the default; stated so a future edit
    // cannot quietly break the caching contract in nginx.conf.
    assetsDir: 'assets',
    // Source maps in a production bundle would publish the readable source of the whole
    // dashboard to anyone who opens devtools. Nothing secret lives in frontend code - the
    // API key is never there - but it is free reconnaissance and costs nothing to omit.
    sourcemap: false,
  },
  server: {
    /**
     * Dev-only proxy, so `npm run dev` talks to the real gateway through the Ingress.
     *
     * Without this the dev server would be a second origin and every /api call would be
     * cross-origin: the SameSite=Strict session cookie would not be sent, login would
     * appear to succeed and every later request would 401. Proxying keeps dev on one
     * origin, which is the same property the Ingress gives production.
     */
    proxy: {
      '/api': { target: 'http://app.urumi.local', changeOrigin: false },
      '/mcp': { target: 'http://app.urumi.local', changeOrigin: false },
    },
  },
});
