#!/usr/bin/env node

/*
 * SPDX-License-Identifier: MIT
 *
 * Runs test/unit-tests.ts, which covers the pure parts of the page (the
 * smb.conf model). esbuild bundles the TypeScript into a single module,
 * and node's own test runner executes it.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

/* Same resolution order as build.js: the native binary is much faster,
   but is not available for every architecture. */
const esbuild = await (async () => {
    for (const pkg of ['esbuild', 'esbuild-wasm']) {
        try {
            const mod = (await import(pkg)).default;
            await mod.formatMessages([], { kind: 'error' });
            return mod;
        } catch { /* try the next candidate */ }
    }
    const require = createRequire(import.meta.url);
    return (await import(require.resolve('esbuild'))).default;
})();

const outdir = 'tmp';
const outfile = path.join(outdir, 'unit-tests.mjs');

fs.mkdirSync(outdir, { recursive: true });

await esbuild.build({
    entryPoints: ['test/unit-tests.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile,
    logLevel: 'warning',
});

const result = spawnSync(process.execPath, ['--test-reporter=spec', outfile], { stdio: 'inherit' });
process.exit(result.status ?? 1);
