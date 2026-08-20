import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Layer 1 — platform preflight. Reports EVERY broken dependency in one run
 * (no bail): the operator wants the full list, not the first item.
 */
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, '..') } },
  test: {
    include: ['verify/src/preflight.spec.ts'],
    root: resolve(__dirname, '..'),
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
