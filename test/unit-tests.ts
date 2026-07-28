/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/* Unit tests for the smb.conf model. Run with `npm test`.
 *
 * These cover src/samba/conf.ts, which has no Cockpit dependency and is
 * where the behaviour that is easy to get quietly wrong lives: keeping
 * the parts of the file the page does not manage, and reading parameters
 * the way Samba does rather than the way they happen to be written.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    addSection, getParam, getSection, globalText, isAuditEnabled, normalizeKey,
    parseBool, parseConf, readShares, removeSection, serializeConf, setAuditEnabled,
    setGlobalText, setParam, writeShare, type Share,
} from "../src/samba/conf";

const SAMPLE = `#
# A hand written smb.conf
#
[global]
\tworkgroup = WORKGROUP
\tserver string = %h server
\t; a semicolon comment
\tlog level = 1

# The shared documents
[documents]
\tpath = /srv/documents
\tcomment = Shared documents
\tread only = no
\tvalid users = alice, @staff
\tmax connections = 4

[scanner]
\tpath = /srv/scanner
\tbrowseable = No
\tguest ok = Yes
`;

function roundTrip(text: string): string {
    return serializeConf(parseConf(text));
}

test("serializing an unmodified config returns it unchanged", () => {
    assert.equal(roundTrip(SAMPLE), SAMPLE);
});

test("round trip preserves files without a trailing newline", () => {
    assert.equal(roundTrip("[global]\n\tworkgroup = X"), "[global]\n\tworkgroup = X\n");
});

test("round trip preserves CRLF line endings", () => {
    const text = "[global]\r\n\tworkgroup = X\r\n";
    assert.equal(roundTrip(text), text);
});

test("parameter names ignore case and internal spaces", () => {
    assert.equal(normalizeKey("Read Only"), "readonly");
    assert.equal(normalizeKey("read  only"), "readonly");

    const conf = parseConf("[a]\n\tRead  Only = yes\n");
    assert.equal(getParam(getSection(conf, "a"), "read only"), "yes");
});

test("section lookup ignores case", () => {
    const conf = parseConf("[Documents]\n\tpath = /srv\n");
    assert.ok(getSection(conf, "documents"));
    assert.ok(getSection(conf, "DOCUMENTS"));
});

test("booleans accept every spelling Samba accepts", () => {
    for (const yes of ["yes", "Yes", "YES", "true", "1", "on"])
        assert.equal(parseBool(yes), true, yes);
    for (const no of ["no", "No", "false", "0", "off"])
        assert.equal(parseBool(no), false, no);
    assert.equal(parseBool("maybe"), undefined);
    assert.equal(parseBool(undefined), undefined);
});

test("the last definition of a repeated parameter wins", () => {
    const conf = parseConf("[a]\n\tpath = /first\n\tpath = /second\n");
    assert.equal(getParam(getSection(conf, "a"), "path"), "/second");
});

test("backslash continuations are joined into one value", () => {
    const conf = parseConf("[a]\n\tvalid users = alice, \\\n\t\tbob\n");
    assert.equal(getParam(getSection(conf, "a"), "valid users"), "alice, bob");
});

test("comments are not mistaken for sections or parameters", () => {
    const conf = parseConf("# [notasection]\n; key = value\n[real]\n\tpath = /srv\n");
    assert.deepEqual(conf.sections.filter(s => s.headerLines.length).map(s => s.name), ["real"]);
});

test("shares are read with Samba's own defaults and synonyms", () => {
    const shares = readShares(parseConf(SAMPLE));
    const byName = Object.fromEntries(shares.map(s => [s.name, s]));

    assert.deepEqual(Object.keys(byName).sort(), ["documents", "scanner"]);

    assert.equal(byName.documents.path, "/srv/documents");
    assert.equal(byName.documents.comment, "Shared documents");
    assert.equal(byName.documents.readOnly, false);
    assert.deepEqual(byName.documents.validUsers, ["alice", "@staff"]);
    /* Not set anywhere, and Samba's default is yes. */
    assert.equal(byName.documents.browseable, true);
    assert.equal(byName.documents.guestOk, false);

    /* "browseable" is the other spelling of "browsable", and values are
       not case sensitive. */
    assert.equal(byName.scanner.browseable, false);
    assert.equal(byName.scanner.guestOk, true);
    /* Nothing sets read only, and Samba's default is yes. */
    assert.equal(byName.scanner.readOnly, true);
});

test("writeable is honoured as the inverse of read only", () => {
    const shares = readShares(parseConf("[a]\n\tpath = /srv\n\twriteable = yes\n"));
    assert.equal(shares[0].readOnly, false);
});

test("a share falls back to [global] before Samba's default", () => {
    const conf = parseConf("[global]\n\tread only = no\n\n[a]\n\tpath = /srv\n");
    assert.equal(readShares(conf)[0].readOnly, false);
});

test("editing a share keeps parameters the page does not manage", () => {
    const conf = parseConf(SAMPLE);
    const share = readShares(conf).find(s => s.name === "documents") as Share;

    writeShare(conf, { ...share, comment: "Team documents" }, share.name);
    const text = serializeConf(conf);

    assert.match(text, /comment = Team documents/);
    /* Untouched by this page, and still there. */
    assert.match(text, /max connections = 4/);
    /* So are the comments and the rest of the file. */
    assert.match(text, /# A hand written smb.conf/);
    assert.match(text, /; a semicolon comment/);
    assert.match(text, /\[scanner\]/);
});

test("writing a flag removes the synonym that would contradict it", () => {
    const conf = parseConf("[a]\n\tpath = /srv\n\twriteable = yes\n\tbrowsable = yes\n");
    const share = readShares(conf)[0];

    writeShare(conf, { ...share, readOnly: true, browseable: false }, share.name);
    const text = serializeConf(conf);

    assert.match(text, /read only = yes/);
    assert.doesNotMatch(text, /writeable/);
    assert.match(text, /browseable = no/);
    assert.doesNotMatch(text, /browsable = /);
});

test("an empty valid users list removes the parameter", () => {
    const conf = parseConf("[a]\n\tpath = /srv\n\tvalid users = alice\n");
    const share = readShares(conf)[0];

    writeShare(conf, { ...share, validUsers: [] }, share.name);
    assert.doesNotMatch(serializeConf(conf), /valid users/);
});

test("renaming a share renames its section and keeps its body", () => {
    const conf = parseConf(SAMPLE);
    const share = readShares(conf).find(s => s.name === "documents") as Share;

    writeShare(conf, { ...share, name: "papers" }, "documents");
    const text = serializeConf(conf);

    assert.match(text, /\[papers\]/);
    assert.doesNotMatch(text, /\[documents\]/);
    assert.match(text, /max connections = 4/);
});

test("creating a share appends a new section", () => {
    const conf = parseConf(SAMPLE);
    writeShare(conf, {
        name: "media",
        path: "/srv/media",
        comment: "",
        readOnly: true,
        browseable: true,
        guestOk: false,
        validUsers: [],
        isSpecial: false,
    });

    const text = serializeConf(conf);
    assert.match(text, /\[media\]\n\tpath = \/srv\/media\n/);
    /* The section before it is still intact. */
    assert.match(text, /\[scanner\]/);
    assert.equal(readShares(parseConf(text)).length, 3);
});

test("deleting a share removes only its section", () => {
    const conf = parseConf(SAMPLE);
    removeSection(conf, "documents");
    const text = serializeConf(conf);

    assert.doesNotMatch(text, /\[documents\]/);
    assert.doesNotMatch(text, /max connections/);
    assert.match(text, /\[scanner\]/);
    assert.match(text, /workgroup = WORKGROUP/);
});

test("setParam replaces in place and keeps the file's indentation", () => {
    const conf = parseConf("[a]\n    path = /srv\n");
    setParam(getSection(conf, "a")!, "path", "/data");
    assert.equal(serializeConf(conf), "[a]\n    path = /data\n");
});

test("setParam collapses duplicate definitions into one", () => {
    const conf = parseConf("[a]\n\tpath = /one\n\tpath = /two\n");
    setParam(getSection(conf, "a")!, "path", "/three");
    assert.equal(serializeConf(conf), "[a]\n\tpath = /three\n");
});

test("addSection separates the new section from the previous one", () => {
    const conf = parseConf("[global]\n\tworkgroup = X\n");
    addSection(conf, "new");
    assert.equal(serializeConf(conf), "[global]\n\tworkgroup = X\n\n[new]\n");
});

test("the global section is exposed and replaced as text", () => {
    const conf = parseConf(SAMPLE);
    assert.match(globalText(conf), /workgroup = WORKGROUP/);
    assert.match(globalText(conf), /; a semicolon comment/);

    setGlobalText(conf, "\tworkgroup = OTHER\n\t# new comment");
    const text = serializeConf(conf);

    assert.match(text, /workgroup = OTHER/);
    assert.match(text, /# new comment/);
    assert.doesNotMatch(text, /WORKGROUP/);
    /* Shares are not affected by editing [global]. */
    assert.match(text, /\[documents\]/);
});

test("enabling audit logging keeps other VFS modules", () => {
    const conf = parseConf("[global]\n\tvfs objects = recycle\n");
    setAuditEnabled(conf, true);

    assert.equal(isAuditEnabled(conf), true);
    const text = serializeConf(conf);
    assert.match(text, /vfs objects = recycle full_audit/);
    assert.match(text, /full_audit:prefix = %u\|%I\|%S/);
});

test("disabling audit logging removes its settings and keeps the rest", () => {
    const conf = parseConf("[global]\n\tvfs objects = recycle\n");
    setAuditEnabled(conf, true);
    setAuditEnabled(conf, false);

    assert.equal(isAuditEnabled(conf), false);
    const text = serializeConf(conf);
    assert.match(text, /vfs objects = recycle/);
    assert.doesNotMatch(text, /full_audit/);
});

test("disabling audit logging drops the parameter when nothing else uses it", () => {
    const conf = parseConf("[global]\n\tworkgroup = X\n");
    setAuditEnabled(conf, true);
    setAuditEnabled(conf, false);
    assert.doesNotMatch(serializeConf(conf), /vfs objects/);
});

test("a config with no global section still round trips and takes edits", () => {
    const conf = parseConf("[share]\n\tpath = /srv\n");
    setAuditEnabled(conf, true);
    assert.match(serializeConf(conf), /\[global\]/);
    assert.equal(readShares(conf).length, 1);
});

test("the special sections are marked as such", () => {
    const shares = readShares(parseConf("[homes]\n\tbrowseable = no\n[printers]\n\tpath = /var/tmp\n"));
    assert.deepEqual(shares.map(s => s.isSpecial), [true, true]);
});
