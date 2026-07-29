/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

/* Mounts every dialog the page can open, the way the page opens them:
 * through Dialogs.show(), inside the same provider nesting index.tsx uses.
 *
 * That last part is the point. Dialogs.show() renders a dialog as a child
 * of WithDialogs rather than where it was called from, so a dialog can
 * only reach React contexts that enclose WithDialogs itself. Getting that
 * nesting wrong makes every dialog which uses one of those contexts throw
 * the moment it opens, while the rest of the page looks perfectly fine —
 * which is exactly what shipped in 2.0.0.
 *
 * Cockpit is stubbed (test/stubs/cockpit), so this checks that the
 * components mount and render, not that they talk to Samba correctly.
 */

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { useDialogs } from "dialogs";

import { Providers } from "../src/components/providers";
import { ShareDialog } from "../src/dialogs/share-dialog";
import {
    CreateDirectoryDialog, DeleteShareDialog, FixSELinuxDialog,
} from "../src/dialogs/share-actions";
import { ShareDetailsDialog } from "../src/dialogs/share-details-dialog";
import { ManageAccessDialog } from "../src/dialogs/manage-access-dialog";
import { BackupRestoreDialog, GlobalSettingsDialog } from "../src/dialogs/config-dialogs";
import { LogsDialog } from "../src/dialogs/logs-dialog";
import { emptyShare, parseConf, type Share } from "../src/samba/conf";

const share: Share = {
    ...emptyShare(),
    name: "documents",
    path: "/srv/documents",
    comment: "Docs",
    validUsers: ["alice", "@staff"],
};

/* One user and one group is the case ordinary ownership covers; several of
   each is the case that needs an ACL, and they render different text. */
const sharedShare: Share = {
    ...share,
    name: "team",
    validUsers: ["alice", "bob", "@staff"],
    writeList: ["carol"],
};

const conf = parseConf("[global]\n\tworkgroup = WORKGROUP\n\n[documents]\n\tpath = /srv/documents\n");

const noop = async () => {};
const nothing = () => {};

/* Each case is a marker that must appear in the DOM once the dialog is
   open, so that "did not throw" cannot pass for "rendered nothing".

   The elements live in a lookup table and are mounted one at a time,
   never rendered as siblings, so React's list-key rule does not apply. */
/* eslint-disable react/jsx-key */
const CASES: [string, React.ReactNode, string][] = [
    ["create share", <ShareDialog share={null} shares={[share]} guestLoginsAllowed guestAccount="nobody" applyConf={noop} onPathsChanged={nothing} />, "share-name"],
    ["edit share", <ShareDialog share={share} shares={[share]} guestLoginsAllowed guestAccount="nobody" applyConf={noop} onPathsChanged={nothing} />, "share-name"],
    /* The advanced fields are rendered collapsed, so they still have to
       mount: a broken one would take the whole dialog down. */
    ["edit share, more options", <ShareDialog share={sharedShare} shares={[sharedShare]} guestLoginsAllowed={false} guestAccount="nobody" applyConf={noop} onPathsChanged={nothing} />, "share-time-machine"],
    /* Guests allowed next to a user list that shuts them out must warn. */
    ["edit share, guest conflict", <ShareDialog share={{ ...share, guestOk: true }} shares={[share]} guestLoginsAllowed guestAccount="nobody" applyConf={noop} onPathsChanged={nothing} />, "share-guest-conflict"],
    ["delete share", <DeleteShareDialog share={share} applyConf={noop} />, "Delete share"],
    ["create directory", <CreateDirectoryDialog share={share} onDone={nothing} />, "create-directory-dialog"],
    /* A share pointing at a system directory must explain itself rather
       than offer to close / to everyone but one user. */
    ["create directory, filesystem root", <CreateDirectoryDialog share={{ ...share, path: "/" }} onDone={nothing} />, "belongs to the operating system"],
    ["fix selinux", <FixSELinuxDialog share={share} onDone={nothing} />, "fix-selinux-dialog"],
    ["share details", <ShareDetailsDialog share={share} status={{ state: "ok", selinuxOk: true, disk: { total: 1000, available: 400 } }} inUse={2} guestLoginsAllowed guestAccount="nobody" />, "share-details-dialog"],
    /* The folder warning lives in the table now, not here: a missing
       folder must still open the details dialog, and must not carry the
       "does not exist" alert. */
    ["share details, missing folder", <ShareDetailsDialog share={share} status={{ state: "missing", selinuxOk: true, disk: null }} inUse={0} guestLoginsAllowed guestAccount="nobody" />, "share-details-dialog"],
    /* The stubbed cockpit yields no accounts, so the table shows its
       empty state rather than the connection columns; the mount still
       exercises the connections poll and the guest-row derivation. */
    ["manage access", <ManageAccessDialog canEdit shares={[share, sharedShare]} />, "manage-access-dialog"],
    ["server settings", <GlobalSettingsDialog conf={conf} applyConf={noop} />, "global-settings-dialog"],
    ["backup and restore", <BackupRestoreDialog conf={conf} tag="1" />, "backup-restore-dialog"],
    ["logs", <LogsDialog conf={conf} unit="smb.service" applyConf={noop} canEdit />, "logs-dialog"],
];
/* eslint-enable react/jsx-key */

/* The async loads inside the dialogs settle during the wait below, which
   React reports as updates outside act(); for this smoke harness that is
   the mechanism, not a mistake, so the warning is noise. */
const nativeConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("not wrapped in act"))
        return;
    nativeConsoleError(...args);
};

const Opener = ({ dialog }: { dialog: React.ReactNode }) => {
    const Dialogs = useDialogs();
    /* Run once: showing the dialog gives WithDialogs a new context value,
       so depending on Dialogs would re-show into the open dialog. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    React.useEffect(() => { Dialogs.show(dialog) }, []);
    return null;
};

async function mount(dialog: React.ReactNode): Promise<string> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    /* Providers is the same component index.tsx mounts, so this exercises
       the real nesting rather than a copy of it. */
    await act(async () => {
        root.render(
            <Providers>
                <Opener dialog={dialog} />
            </Providers>);
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) });

    const html = document.body.innerHTML;
    root.unmount();
    host.remove();
    return html;
}

(async () => {
    let failed = 0;

    for (const [name, dialog, marker] of CASES) {
        try {
            const html = await mount(dialog);
            if (html.includes(marker)) {
                console.log(`ok - ${name}`);
            } else {
                console.log(`FAIL - ${name}: mounted but "${marker}" is not in the DOM`);
                failed++;
            }
        } catch (exception) {
            console.log(`FAIL - ${name}: ${(exception as Error).message}`);
            failed++;
        }
    }

    console.log(failed ? `\n${failed} of ${CASES.length} dialogs failed` : `\nall ${CASES.length} dialogs open`);
    /* jsdom's timers and PatternFly's focus trap keep the loop alive. */
    process.exit(failed ? 1 : 0);
})();
