/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

import React, { useState } from "react";

import cockpit from "cockpit";
import { fmt_to_fragments } from "utils";

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";

import { ConfirmDialog, DialogFrame } from "../components/dialog";
import { useAlerts, type AlertRequest } from "../components/alerts";
import * as client from "../samba/client";
import { isProtectedPath, normalizePath } from "../samba/paths";
import type { PathStatus } from "../samba/hooks";
import { removeSection, sharePrincipals, type SambaConf, type Share } from "../samba/conf";

const _ = cockpit.gettext;

/* Why a share cannot currently serve its folder. Detected here, beside
   the dialogs that fix each one; the shares table shows it as an icon in
   the folder column and offers the matching fix in the row's menu. */
export type Problem = "missing" | "not-a-directory" | "selinux" | null;

export function shareProblem(share: Share, status: PathStatus | undefined): Problem {
    if (share.isSpecial || !share.path || !status)
        return null;
    if (status.state === "missing")
        return "missing";
    if (status.state === "not-a-directory")
        return "not-a-directory";
    if (!status.selinuxOk)
        return "selinux";
    return null;
}

export const PROBLEM_SUMMARY: Record<Exclude<Problem, null>, () => string> = {
    missing: () => _("The folder does not exist"),
    "not-a-directory": () => _("The path is not a folder"),
    selinux: () => _("SELinux is blocking access to the folder"),
};

/* setfacl comes from the acl package, which Debian and its derivatives do
   not install by default. Without it a share for several users falls back
   to what plain ownership can express, which is less than was asked for. */
function aclUnavailableAlert(created: boolean): AlertRequest {
    return {
        variant: "warning",
        title: created
            ? _("The folder was created, but not everyone could be given access.")
            : _("Not everyone could be given access to the folder."),
        detail: _("Granting access to more than one user or group needs ACLs, and setfacl is not installed. Install the acl package, then edit the share and tick \"Set the folder's permissions to match\"."),
    };
}

/* Set the folder's permissions from the share's user list, reporting the
   ACL shortfall if there is one. Shared by everything that creates or
   repairs a share folder. */
export async function grantAccess(share: Share, created: boolean,
    alert: (request: AlertRequest) => void): Promise<void> {
    const aclUnavailable = await client.applyPermissions(share.path, sharePrincipals(share));
    if (aclUnavailable)
        alert(aclUnavailableAlert(created));
}

export const DeleteShareDialog = ({ share, applyConf }: {
    share: Share;
    applyConf: (mutate: (conf: SambaConf) => void) => Promise<void>;
}) => (
    <ConfirmDialog title={cockpit.format(_("Delete share $0?"), share.name)}
                   actionLabel={_("Delete share")}
                   onApply={() => applyConf(conf => removeSection(conf, share.name))}>
        <p>
            {fmt_to_fragments(
                _("The $0 share will be removed from the Samba configuration and clients using it will lose access."),
                <strong>{share.name}</strong>)}
        </p>
        {share.path && (
            <p className="pf-v6-u-mt-sm">
                {fmt_to_fragments(
                    _("The folder $0 and the files in it are $1 deleted."),
                    <code>{share.path}</code>, <strong>{_("not")}</strong>)}
            </p>
        )}
    </ConfirmDialog>
);

/* A folder this page will not take over. Explaining why is worth more
   than hiding the action: the reason it is refused is also the reason the
   share should be pointing somewhere else. */
export const SystemFolderAlert = ({ path }: { path: string }) => (
    <Alert isInline variant="warning" className="pf-v6-u-mt-md"
           title={_("This folder belongs to the operating system")}>
        {fmt_to_fragments(
            _("Giving $0 to this share's users means closing it to everyone else, and everything on the machine underneath it goes with it. Point the share at a folder inside it instead."),
            <code>{normalizePath(path)}</code>)}
    </Alert>
);

/* A share whose directory does not exist looks fine in the configuration
   but fails for every client that opens it. */
export const CreateDirectoryDialog = ({ share, onDone }: {
    share: Share;
    onDone: () => void;
}) => {
    const alert = useAlerts();
    const [applyAcls, setApplyAcls] = useState(true);
    const principals = sharePrincipals(share);
    const isSystemFolder = isProtectedPath(share.path);

    async function onApply() {
        await client.createDirectory(share.path);

        if (applyAcls && principals.length > 0 && !isSystemFolder)
            await grantAccess(share, true, alert);

        if (await client.isSELinuxEnabled())
            await client.fixSELinuxContext(share.path).catch(() => null);

        onDone();
    }

    return (
        <DialogFrame id="create-directory-dialog"
                     variant="small"
                     title={_("Create the share folder")}
                     actionLabel={_("Create folder")}
                     onApply={onApply}>
            <p>
                {fmt_to_fragments(
                    _("The folder $0 does not exist, so clients cannot open this share."),
                    <code>{share.path}</code>)}
            </p>
            {isSystemFolder && <SystemFolderAlert path={share.path} />}
            {!isSystemFolder && principals.length > 0 && (
                <Checkbox id="create-directory-acls"
                          className="pf-v6-u-mt-md"
                          label={_("Give the share's users access to it")}
                          description={cockpit.format(_("Sets filesystem permissions for $0."),
                                                      principals.join(", "))}
                          isChecked={applyAcls}
                          onChange={(_event, checked) => setApplyAcls(checked)} />
            )}
        </DialogFrame>
    );
};

/* SELinux refuses Samba access to a directory that is not labelled for
   it, which produces permission denied errors that look nothing like a
   labelling problem. */
export const FixSELinuxDialog = ({ share, onDone }: {
    share: Share;
    onDone: () => void;
}) => (
    <DialogFrame id="fix-selinux-dialog"
                 variant="small"
                 title={_("Allow Samba to use this folder")}
                 actionLabel={_("Apply SELinux label")}
                 onApply={async () => {
                     await client.fixSELinuxContext(share.path);
                     onDone();
                 }}>
        <p>
            {fmt_to_fragments(
                _("SELinux is blocking Samba from reading $0 because the folder is not labelled for file sharing."),
                <code>{share.path}</code>)}
        </p>
        <p className="pf-v6-u-mt-sm">
            {fmt_to_fragments(
                _("Applying the label records a permanent $0 rule with $1 and relabels the folder with $2, so it survives a filesystem relabel."),
                <code>samba_share_t</code>, <code>semanage fcontext</code>, <code>restorecon</code>)}
        </p>
    </DialogFrame>
);
