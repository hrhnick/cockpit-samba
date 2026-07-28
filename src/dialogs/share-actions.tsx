/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from "react";

import cockpit from "cockpit";
import { fmt_to_fragments } from "utils";

import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";

import { ConfirmDialog, DialogFrame } from "../components/dialog";
import { useAlerts, type AlertRequest } from "../components/alerts";
import * as client from "../samba/client";
import { removeSection, type SambaConf, type Share } from "../samba/conf";

const _ = cockpit.gettext;

/* The accounts a share names, and so the ones its folder has to let in:
   whoever may connect, plus anyone who may write even when it is read
   only. */
export function sharePrincipals(share: Share): string[] {
    return [...new Set([...share.validUsers, ...share.writeList])];
}

/* setfacl comes from the acl package, which Debian and its derivatives do
   not install by default. Without it a share for several users falls back
   to what plain ownership can express, which is less than was asked for. */
function aclUnavailableAlert(created: boolean): AlertRequest {
    return {
        variant: "warning",
        title: created
            ? _("The folder was created, but not everyone could be given access.")
            : _("Not everyone could be given access to the folder."),
        detail: _("Granting access to more than one user or group needs ACLs, and setfacl is not installed. Install the acl package, then use \"Fix folder permissions\" in the share's menu."),
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

/* A share whose directory does not exist looks fine in the configuration
   but fails for every client that opens it. */
export const CreateDirectoryDialog = ({ share, onDone }: {
    share: Share;
    onDone: () => void;
}) => {
    const alert = useAlerts();
    const [applyAcls, setApplyAcls] = useState(true);
    const principals = sharePrincipals(share);

    async function onApply() {
        await client.createDirectory(share.path);

        if (applyAcls && principals.length > 0)
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
            {principals.length > 0 && (
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

/* What plain ownership will be set to. A share named one user, one group,
   or one of each, and each reads differently. */
function ownershipSummary(owner: string, group: string): React.ReactNode {
    if (owner && group)
        return fmt_to_fragments(
            _("The folder will be owned by $0 and the group $1, and closed to everyone else."),
            <strong>{owner}</strong>, <strong>{group}</strong>);
    if (group)
        return fmt_to_fragments(
            _("The folder will be given to the group $0, and closed to everyone else."),
            <strong>{group}</strong>);
    return fmt_to_fragments(
        _("The folder will be owned by $0, and closed to everyone else."),
        <strong>{owner}</strong>);
}

/* Samba checks `valid users` on top of the ordinary Unix permissions, so
 * a share whose folder does not let those accounts in refuses them however
 * the share itself is configured. That is what this repairs — most often
 * after the user list changed, since the folder does not follow it by
 * itself.
 */
export const FixPermissionsDialog = ({ share, onDone }: {
    share: Share;
    onDone: () => void;
}) => {
    const alert = useAlerts();
    const principals = sharePrincipals(share);
    const plan = client.permissionPlan(principals);

    async function onApply() {
        await grantAccess(share, false, alert);
        onDone();
    }

    return (
        <DialogFrame id="fix-permissions-dialog"
                     variant="small"
                     title={_("Fix folder permissions")}
                     actionLabel={_("Apply permissions")}
                     isActionDisabled={plan.kind === "none"}
                     onApply={onApply}>
            <p>
                {fmt_to_fragments(
                    _("Samba only lets an account into a share if the folder $0 lets it in too. Changing who may use a share does not change the folder, so the two can drift apart."),
                    <code>{share.path}</code>)}
            </p>

            {plan.kind === "none" && (
                <p className="pf-v6-u-mt-sm">
                    {_("This share names no users, so there is nothing to grant. Every account with a Samba password may connect, and the folder's own permissions decide what they can do.")}
                </p>
            )}

            {plan.kind === "ownership" && (
                <p className="pf-v6-u-mt-sm">{ownershipSummary(plan.owner, plan.group)}</p>
            )}

            {plan.kind === "acl" && (
                <p className="pf-v6-u-mt-sm">
                    {cockpit.format(
                        _("$0 will each be given access through a filesystem ACL, which new files inside the folder inherit."),
                        principals.join(", "))}
                </p>
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
