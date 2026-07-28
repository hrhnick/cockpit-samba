/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from "react";

import cockpit from "cockpit";
import { fmt_to_fragments } from "utils";

import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";

import { ConfirmDialog, DialogFrame } from "../components/dialog";
import { useAlerts } from "../components/alerts";
import * as client from "../samba/client";
import { removeSection, type SambaConf, type Share } from "../samba/conf";

const _ = cockpit.gettext;

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

    async function onApply() {
        await client.createDirectory(share.path);

        if (applyAcls && share.validUsers.length > 0) {
            const aclUnavailable = await client.applyPermissions(share.path, share.validUsers);
            if (aclUnavailable)
                alert({
                    variant: "warning",
                    title: _("The folder was created, but per-user permissions could not be set."),
                    detail: _("setfacl is not available, so access is limited to the folder's owner and group."),
                });
        }

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
            {share.validUsers.length > 0 && (
                <Checkbox id="create-directory-acls"
                          className="pf-v6-u-mt-md"
                          label={_("Give the share's users access to it")}
                          description={cockpit.format(_("Sets filesystem permissions for $0."),
                                                      share.validUsers.join(", "))}
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
