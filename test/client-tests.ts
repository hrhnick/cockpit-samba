/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

/* Unit tests for the pure parts of samba/client.ts: the permission plan
 * whose answer becomes root-run chown/chmod, and the smbstatus parsers
 * that fill the connections table — including the address the Disconnect
 * button targets. All of them turn text or arrays into data and can be
 * wrong without being loud, which is what earns them tests.
 *
 * cockpit itself is stubbed at bundle time (test/stubs); nothing here
 * touches the system.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    parseConnectionsJson, parseConnectionsText, permissionPlan,
} from "../src/samba/client";

/* --- permissionPlan ---------------------------------------------------- */

test("nobody named means nothing to grant", () => {
    assert.deepEqual(permissionPlan([]), { kind: "none" });
    /* A bare "@" names no group at all. */
    assert.deepEqual(permissionPlan(["@"]), { kind: "none" });
});

test("one user, one group, or one of each is plain ownership", () => {
    assert.deepEqual(permissionPlan(["alice"]),
                     { kind: "ownership", owner: "alice", group: "" });
    assert.deepEqual(permissionPlan(["@staff"]),
                     { kind: "ownership", owner: "", group: "staff" });
    assert.deepEqual(permissionPlan(["alice", "@staff"]),
                     { kind: "ownership", owner: "alice", group: "staff" });
});

/* The boundary that changes which root commands run: past one of either
   kind, ownership cannot express the share and ACLs take over. */
test("more than one of either kind needs ACLs", () => {
    assert.deepEqual(permissionPlan(["alice", "bob"]),
                     { kind: "acl", users: ["alice", "bob"], groups: [] });
    assert.deepEqual(permissionPlan(["alice", "@a", "@b"]),
                     { kind: "acl", users: ["alice"], groups: ["a", "b"] });
});

test("the @ marker is stripped from group names", () => {
    const plan = permissionPlan(["@staff", "@editors", "@"]);
    assert.deepEqual(plan, { kind: "acl", users: [], groups: ["staff", "editors"] });
});

/* --- The fixed-width smbstatus reports --------------------------------- */

/* Captured shapes from `smbstatus -p` and `-S` in the C locale. The
 * alignment is part of the fixture: the parser finds each column by where
 * its heading starts and slices every line at those offsets, which is
 * exactly the part that breaks quietly if the arithmetic drifts.
 */
const PROCESSES = `
Samba version 4.13.13-Debian
PID     Username     Group        Machine                                   Protocol Version  Encryption           Signing
----------------------------------------------------------------------------------------------------------------------------------------
1234    alice        alice        192.168.1.20 (ipv4:192.168.1.20:49832)    SMB3_11           -                    partial(AES-128-CMAC)
5678    bob          bob          192.168.1.30 (ipv4:192.168.1.30:50021)    SMB3_11           -                    -
`;

/* "Jul  6" carries the double space that rules out splitting on
   whitespace, which is the reason this parser slices columns at all. */
const TCONS = `
Service      pid     Machine       Connected at                     Encryption   Signing
---------------------------------------------------------------------------------------------
media        1234    192.168.1.20  Sun Jul  6 09:15:02 2025 UTC     -            -
IPC$         1234    192.168.1.20  Sun Jul  6 09:15:03 2025 UTC     -            -
backups      1234    192.168.1.20  Sat Jul  5 22:01:44 2025 UTC     -            -
docs         9999    192.168.1.99  Sun Jul  6 10:00:00 2025 UTC     -            -
`;

test("the two text reports are joined by PID", () => {
    const connections = parseConnectionsText(PROCESSES, TCONS);
    assert.deepEqual(connections.map(c => c.id), ["1234", "5678"]);

    const alice = connections[0];
    assert.equal(alice.username, "alice");
    assert.equal(alice.machine, "192.168.1.20 (ipv4:192.168.1.20:49832)");
    assert.equal(alice.signing, "partial(AES-128-CMAC)");
    /* IPC$ is the administrative pipe, not a share anyone opened; the
       tcon for PID 9999 matches no session and is dropped. */
    assert.deepEqual(alice.shares, ["media", "backups"]);

    /* When one client has several shares open, the connection is as old
       as the oldest of them. */
    assert.equal(alice.connectedAt?.toISOString(), "2025-07-05T22:01:44.000Z");

    assert.deepEqual(connections[1].shares, []);
    assert.equal(connections[1].connectedAt, null);
});

test("output without a separator line parses to nothing", () => {
    assert.deepEqual(parseConnectionsText("", ""), []);
    assert.deepEqual(parseConnectionsText("no shares are connected\n", ""), []);
});

/* --- The JSON report --------------------------------------------------- */

const JSON_REPORT = JSON.stringify({
    timestamp: "2025-07-06T09:20:11+00:00",
    version: "4.17.12",
    sessions: {
        3406: {
            session_id: "3406",
            username: "alice",
            remote_machine: "192.168.1.20",
            encryption: { cipher: "" },
            signing: { cipher: "AES-128-GMAC" },
        },
    },
    tcons: {
        101: {
            service: "media",
            session_id: "3406",
            connected_at: "2025-07-06T09:15:02+00:00",
            encryption: { cipher: "AES-128-GCM" },
            signing: { cipher: "" },
        },
        102: { service: "IPC$", session_id: "3406" },
        103: { service: "orphan", session_id: "9999" },
    },
});

test("the JSON report is grouped per session", () => {
    const connections = parseConnectionsJson(JSON_REPORT);
    assert.ok(connections);
    assert.equal(connections.length, 1);

    const alice = connections[0];
    assert.equal(alice.username, "alice");
    assert.equal(alice.machine, "192.168.1.20");
    /* IPC$ skipped; the tcon pointing at a session that does not exist
       is dropped rather than invented. */
    assert.deepEqual(alice.shares, ["media"]);
    /* The session did not name a cipher, so the share's fills in; the
       session's signing wins over the share's empty one. */
    assert.equal(alice.encryption, "AES-128-GCM");
    assert.equal(alice.signing, "AES-128-GMAC");
    assert.equal(alice.connectedAt?.toISOString(), "2025-07-06T09:15:02.000Z");
});

/* Both of these fall back to the text parser in production, so the
   contract is null, not a throw and not an empty list. */
test("something that is not the JSON report is rejected as null", () => {
    assert.equal(parseConnectionsJson("no shares are connected"), null);
    assert.equal(parseConnectionsJson("{}"), null);
    assert.equal(parseConnectionsJson("[]"), null);
    assert.equal(parseConnectionsJson('{"version": "4.17"}'), null);
});
