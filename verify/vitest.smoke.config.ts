import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Layer 2 — authenticated journey smoke. `bail: 1` on purpose: the journeys are
 * sequential, so once a step breaks every later step fails for the same reason.
 * Stopping at the first failure keeps the deploy gate's output to exactly one
 * actionable line.
 */
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, '..') } },
  test: {
    include: ['verify/src/smoke.spec.ts'],
    root: resolve(__dirname, '..'),
    environment: 'node',
    bail: 1,
    sequence: { concurrent: false },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
