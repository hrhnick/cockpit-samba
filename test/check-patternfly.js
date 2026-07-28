#!/usr/bin/env node

/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/* Check that our PatternFly versions match the ones the vendored pkg/lib
 * was built against.
 *
 * pkg/lib comes from the Cockpit repository at the commit pinned in the
 * Makefile, and its components are written against the PatternFly release
 * Cockpit used at that commit. Ours are installed separately from
 * package.json, so the two can drift apart, and cockpit-lib-update moves
 * the pin on a schedule without touching package.json at all.
 *
 * Skew does not break the build. It produces components that render but
 * are styled wrong — classes the stylesheet no longer defines, overrides
 * that no longer match — which is a great deal harder to trace back than
 * a failed check would have been.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const COMMIT_RE = /^COCKPIT_REPO_COMMIT\s*=\s*(\S+)/m;

function fail(message) {
    console.error(`check-patternfly: ${message}`);
    process.exit(1);
}

const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
const commit = COMMIT_RE.exec(makefile)?.[1];
if (!commit)
    fail("no COCKPIT_REPO_COMMIT in the Makefile");

let theirs;
try {
    /* The commit is in the object store once `make` has fetched it, which
       is also what put pkg/lib in place. */
    theirs = JSON.parse(execFileSync("git", ["show", `${commit}:package.json`], { encoding: "utf8" }));
} catch {
    fail(`cannot read Cockpit's package.json at ${commit}. Run \`make\` first, which fetches it.`);
}

const ours = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const theirDeps = { ...theirs.dependencies, ...theirs.devDependencies };
const ourDeps = { ...ours.dependencies, ...ours.devDependencies };

const mismatched = [];
const unknown = [];

for (const [name, version] of Object.entries(ourDeps)) {
    if (!name.startsWith("@patternfly/"))
        continue;
    if (!(name in theirDeps))
        unknown.push(name);
    else if (theirDeps[name] !== version)
        mismatched.push({ name, ours: version, theirs: theirDeps[name] });
}

for (const name of unknown)
    console.warn(`check-patternfly: ${name} is not in Cockpit's package.json; not checked`);

if (mismatched.length > 0) {
    console.error(`check-patternfly: PatternFly does not match pkg/lib at ${commit}:\n`);
    for (const { name, ours: mine, theirs: yours } of mismatched)
        console.error(`  ${name}: package.json has ${mine}, Cockpit uses ${yours}`);
    console.error("\nSet package.json to Cockpit's versions, or move COCKPIT_REPO_COMMIT " +
                  "back to a commit that matches.");
    process.exit(1);
}

console.log(`check-patternfly: PatternFly matches pkg/lib at ${commit.slice(0, 12)}`);
