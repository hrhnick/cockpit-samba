#!/usr/bin/env node

/*
 * SPDX-License-Identifier: MIT
 *
 * Runs the unit tests: test/unit-tests.ts covers the smb.conf model, and
 * test/client-tests.ts the pure parsing and planning in samba/client.ts.
 * esbuild bundles the TypeScript — with the cockpit stub from test/stubs,
 * since client.ts imports cockpit even though the tested functions never
 * call it — and node's own test runner executes both.
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
const entries = ['test/unit-tests.ts', 'test/client-tests.ts'];

fs.mkdirSync(outdir, { recursive: true });

await esbuild.build({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outdir,
    outExtension: { '.js': '.mjs' },
    nodePaths: ['pkg/lib'],
    // client.ts imports cockpit only for types and a handful of spawns the
    // tested functions never reach; the stub stands in so the bundle needs
    // no DOM. An alias rather than a nodePaths entry, so it wins over the
    // real cockpit.js in pkg/lib.
    alias: { cockpit: './test/stubs/cockpit' },
    logLevel: 'warning',
});

const outfiles = entries.map(e => path.join(outdir, path.basename(e).replace(/\.ts$/, '.mjs')));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...outfiles],
                         { stdio: 'inherit' });
process.exit(result.status ?? 1);
