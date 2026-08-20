import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Layer 3 — pure logic only. Runs in `npm test`; no network, no credentials. */
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, '..') } },
  test: {
    include: ['verify/src/**/*.unit.test.ts'],
    root: resolve(__dirname, '..'),
    environment: 'node',
  },
});
