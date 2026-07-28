#!/usr/bin/env node

/*
 * SPDX-License-Identifier: MIT
 *
 * Runs test/dialog-tests.tsx, which opens every dialog in a jsdom
 * document to check that it mounts. esbuild bundles it the same way the
 * real build does, with pkg/lib on the module path, and cockpit replaced
 * by the stub in test/stubs.
 *
 * Skips itself when jsdom is not installed, so that `npm test` still
 * works from a plain checkout.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

try {
    require.resolve('jsdom');
} catch {
    console.log('# skipped: jsdom is not installed (npm install --no-save jsdom)');
    process.exit(0);
}

const esbuild = await (async () => {
    for (const pkg of ['esbuild', 'esbuild-wasm']) {
        try {
            const mod = (await import(pkg)).default;
            await mod.formatMessages([], { kind: 'error' });
            return mod;
        } catch { /* try the next candidate */ }
    }
    return (await import(require.resolve('esbuild'))).default;
})();

const outdir = 'tmp';
const outfile = path.join(outdir, 'dialog-tests.cjs');
const runner = path.join(outdir, 'dialog-tests-runner.cjs');

fs.mkdirSync(outdir, { recursive: true });

await esbuild.build({
    entryPoints: ['test/dialog-tests.tsx'],
    bundle: true,
    platform: 'node',
    // cjs because react-dom pulls in Node built-ins through require()
    format: 'cjs',
    outfile,
    nodePaths: ['pkg/lib'],
    // Stylesheets are irrelevant here, and .js files in pkg/lib contain JSX
    loader: { '.js': 'jsx', '.css': 'empty', '.scss': 'empty' },
    alias: { cockpit: './test/stubs/cockpit' },
    logLevel: 'warning',
});

/* A DOM has to exist before React is loaded, so the bundle is required
   from a wrapper rather than run directly. */
fs.writeFileSync(runner, `
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost:9090/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
                   'getComputedStyle', 'MutationObserver', 'DOMParser', 'Event', 'CustomEvent'])
    global[key] = dom.window[key];
global.requestAnimationFrame = cb => setTimeout(cb, 0);
global.cancelAnimationFrame = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;
require('./${path.basename(outfile)}');
`);

const result = spawnSync(process.execPath, [runner], { stdio: 'inherit' });
process.exit(result.status ?? 1);
