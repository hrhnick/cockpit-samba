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
    acceptGuestLogins, addSection, emptyShare, getParam, getSection, globalText,
    guestLoginsAccepted, isAuditEnabled, normalizeKey, parseBool, parseConf,
    readShares, removeSection, serializeConf, setAuditEnabled, setGlobalText,
    setParam, writeShare, type Share,
} from "../src/samba/conf";
import { isProtectedPath, normalizePath } from "../src/samba/paths";

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
    writeShare(conf, { ...emptyShare(), name: "media", path: "/srv/media", readOnly: true });

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

/* --- The rest of the share parameters --------------------------------- */

function oneShare(text: string): Share {
    return readShares(parseConf(text))[0];
}

/* Round trip a share through a write and read it back, which is how the
   dialog uses the model: what you save is what you see next time. */
function rewrite(text: string, changes: Partial<Share>): { share: Share, text: string } {
    const conf = parseConf(text);
    const share = readShares(conf)[0];
    writeShare(conf, { ...share, ...changes }, share.name);
    const out = serializeConf(conf);
    return { share: oneShare(out), text: out };
}

test("a share is available unless it says otherwise", () => {
    assert.equal(oneShare("[a]\n\tpath = /srv\n").available, true);
    assert.equal(oneShare("[a]\n\tpath = /srv\n\tavailable = no\n").available, false);
});

test("turning a share off records it, turning it back on removes the parameter", () => {
    const off = rewrite("[a]\n\tpath = /srv\n", { available: false });
    assert.match(off.text, /available = no/);
    assert.equal(off.share.available, false);

    const on = rewrite(off.text, { available: true });
    assert.doesNotMatch(on.text, /available/);
    assert.equal(on.share.available, true);
});

test("the write list is read and written like valid users", () => {
    const { share, text } = rewrite("[a]\n\tpath = /srv\n\tread only = yes\n",
                                    { writeList: ["alice", "@editors"] });
    assert.match(text, /write list = alice, @editors/);
    assert.deepEqual(share.writeList, ["alice", "@editors"]);

    assert.doesNotMatch(rewrite(text, { writeList: [] }).text, /write list/);
});

test("host restrictions keep the syntax they were written in", () => {
    /* smb.conf's own forms: a subnet, a name, and an EXCEPT clause. */
    const value = "192.168.1. .example.com EXCEPT 192.168.1.99";
    const { share, text } = rewrite("[a]\n\tpath = /srv\n", { hostsAllow: value });
    assert.match(text, /hosts allow = 192\.168\.1\. \.example\.com EXCEPT 192\.168\.1\.99/);
    assert.equal(share.hostsAllow, value);
});

test("the older spellings of the host and mask parameters are honoured", () => {
    const share = oneShare("[a]\n\tpath = /srv\n\tallow hosts = 10.0.0.0/8\n" +
                           "\tdeny hosts = 10.1.2.3\n\tcreate mode = 0664\n" +
                           "\tdirectory mode = 0775\n\tgroup = staff\n");
    assert.equal(share.hostsAllow, "10.0.0.0/8");
    assert.equal(share.hostsDeny, "10.1.2.3");
    assert.equal(share.createMask, "0664");
    assert.equal(share.directoryMask, "0775");
    assert.equal(share.forceGroup, "staff");
});

test("writing a mask drops the older spelling that would contradict it", () => {
    const { text } = rewrite("[a]\n\tpath = /srv\n\tcreate mode = 0600\n", { createMask: "0664" });
    assert.match(text, /create mask = 0664/);
    assert.doesNotMatch(text, /create mode/);
});

test("the recycle bin brings its settings with it and takes them away again", () => {
    const on = rewrite("[a]\n\tpath = /srv\n", { recycleBin: true });
    assert.equal(on.share.recycleBin, true);
    assert.match(on.text, /vfs objects = recycle/);
    assert.match(on.text, /recycle:repository = \.recycle\/%U/);

    const off = rewrite(on.text, { recycleBin: false });
    assert.equal(off.share.recycleBin, false);
    assert.doesNotMatch(off.text, /recycle/);
});

test("Time Machine needs the module stack and the option, in that order", () => {
    const { share, text } = rewrite("[a]\n\tpath = /srv\n", { timeMachine: true });
    assert.match(text, /vfs objects = catia fruit streams_xattr/);
    assert.match(text, /fruit:time machine = yes/);
    assert.equal(share.timeMachine, true);
    /* The global-only options have no effect in a share, so they are not
       written into one. */
    assert.doesNotMatch(text, /fruit:model/);
});

test("the fruit module without the option is not a Time Machine share", () => {
    assert.equal(oneShare("[a]\n\tpath = /srv\n\tvfs objects = catia fruit streams_xattr\n").timeMachine,
                 false);
});

/* vfs objects is not additive: a share that sets it overrides [global]
   rather than adding to it, so a naive write would silently take audit
   logging off that share. */
test("per-share VFS modules keep the ones inherited from global", () => {
    const conf = parseConf("[global]\n\tvfs objects = full_audit\n\n[a]\n\tpath = /srv\n");
    const share = readShares(conf)[0];
    writeShare(conf, { ...share, recycleBin: true }, share.name);

    const modules = /\[a\][\s\S]*?vfs objects = (.*)/.exec(serializeConf(conf))?.[1].split(" ");
    assert.deepEqual(modules?.sort(), ["full_audit", "recycle"]);
});

test("a share with nothing of its own keeps inheriting global's modules", () => {
    const conf = parseConf("[global]\n\tvfs objects = full_audit\n\n[a]\n\tpath = /srv\n");
    const share = readShares(conf)[0];
    writeShare(conf, { ...share, comment: "unrelated edit" }, share.name);
    /* Only [global] mentions the modules; the share still inherits. */
    assert.equal(serializeConf(conf).match(/vfs objects/g)?.length, 1);
});

test("turning the last managed module off leaves other modules alone", () => {
    const on = rewrite("[a]\n\tpath = /srv\n\tvfs objects = shadow_copy2\n", { recycleBin: true });
    assert.match(on.text, /vfs objects = shadow_copy2 recycle/);

    const off = rewrite(on.text, { recycleBin: false });
    assert.match(off.text, /vfs objects = shadow_copy2/);
    assert.doesNotMatch(off.text, /recycle/);
});

/* Samba's map to guest defaults to Never, which turns away the very
   logins guest ok is meant to admit. */
test("allowing guests on a share also makes the server accept guest logins", () => {
    const conf = parseConf("[global]\n\tworkgroup = X\n\n[a]\n\tpath = /srv\n");
    assert.equal(guestLoginsAccepted(conf), false);

    const share = readShares(conf)[0];
    writeShare(conf, { ...share, guestOk: true }, share.name);

    assert.equal(guestLoginsAccepted(conf), true);
    assert.match(serializeConf(conf), /map to guest = Bad User/);
});

test("an existing map to guest setting is left as the admin wrote it", () => {
    const conf = parseConf("[global]\n\tmap to guest = Bad Password\n\n[a]\n\tpath = /srv\n");
    const share = readShares(conf)[0];
    writeShare(conf, { ...share, guestOk: true }, share.name);
    assert.match(serializeConf(conf), /map to guest = Bad Password/);
});

test("guest mapping is recognised however it is spelled", () => {
    assert.equal(guestLoginsAccepted(parseConf("[global]\n\tmap to guest = Never\n")), false);
    assert.equal(guestLoginsAccepted(parseConf("[global]\n\tMapToGuest = bad user\n")), true);

    const conf = parseConf("[global]\n\tworkgroup = X\n");
    acceptGuestLogins(conf);
    assert.equal(guestLoginsAccepted(conf), true);
});

/* --- Folders this page refuses to take over ---------------------------- */

/* Setting a share folder's permissions closes it to everyone but the
   share's users, and that is not recursive but traversal is: doing it to /
   takes every path on the machine away from every non-root process. */

test("paths are collapsed to one form before being judged", () => {
    assert.equal(normalizePath("/srv//media/"), "/srv/media");
    assert.equal(normalizePath("/srv/./media"), "/srv/media");
    assert.equal(normalizePath("/srv/samba/../media"), "/srv/media");
    assert.equal(normalizePath("///"), "/");
    /* Nothing usable collapses to the root, which is refused, and
       refusing is the right way to be wrong here. */
    assert.equal(normalizePath(""), "/");
});

test("the filesystem root is refused", () => {
    assert.equal(isProtectedPath("/"), true);
    assert.equal(isProtectedPath("//"), true);
    assert.equal(isProtectedPath("  /  "), true);
    /* A path that walks its way back up to the root is still the root. */
    assert.equal(isProtectedPath("/srv/.."), true);
    assert.equal(isProtectedPath("/usr/local/../.."), true);
});

test("the directories the system needs are refused", () => {
    for (const path of ["/etc", "/home", "/usr", "/var", "/tmp", "/boot", "/root",
        "/proc", "/sys", "/dev", "/srv", "/mnt", "/opt",
        "/usr/local", "/var/log", "/var/tmp"])
        assert.equal(isProtectedPath(path), true, path);

    /* Trailing slashes must not be a way around it. */
    assert.equal(isProtectedPath("/home/"), true);
    assert.equal(isProtectedPath("/usr/local/"), true);
});

test("an ordinary share folder is allowed", () => {
    /* Only the shared directory itself is ever modified, so there is no
       reason to refuse somewhere inside a system directory. */
    for (const path of ["/srv/media", "/srv/samba/documents", "/home/alice",
        "/var/www/files", "/usr/local/share/files", "/mnt/usb",
        "/media/pi/BACKUP"])
        assert.equal(isProtectedPath(path), false, path);

    /* A dedicated disk mounted at the top level is an ordinary way to set
       up a file server, so depth alone cannot be the rule. */
    for (const path of ["/data", "/storage", "/tank", "/pool/share"])
        assert.equal(isProtectedPath(path), false, path);
});
