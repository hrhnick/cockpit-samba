/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from "react";

import cockpit from "cockpit";
import { PasswordFormFields } from "cockpit-components-password";
import { fmt_to_fragments } from "utils";

import { DialogFrame, ConfirmDialog } from "../components/dialog";
import * as client from "../samba/client";
import type { SambaUser } from "../samba/client";

const _ = cockpit.gettext;

/* Samba keeps its own password database, separate from the system one,
 * because the SMB protocol needs a hash the system password file does not
 * store. Setting a Samba password is therefore what grants an existing
 * account access to the shares, and it does not change the account's
 * login password.
 */
export const SetPasswordDialog = ({ user, onDone }: {
    user: SambaUser;
    onDone: () => void;
}) => {
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");

    const mismatch = confirm.length > 0 && password !== confirm;

    async function onApply() {
        await client.setPassword(user.name, password);
        onDone();
    }

    return (
        <DialogFrame id="set-password-dialog"
                     variant="small"
                     title={user.hasPassword
                         ? cockpit.format(_("Change Samba password for $0"), user.name)
                         : cockpit.format(_("Set Samba password for $0"), user.name)}
                     description={_("This password is only used to connect to shares. The account's login password is left alone.")}
                     actionLabel={user.hasPassword ? _("Change password") : _("Set password")}
                     isActionDisabled={!password || password !== confirm}
                     onApply={onApply}
                     isForm>
            <PasswordFormFields idPrefix="samba-password"
                                password_label={_("Samba password")}
                                password_confirm_label={_("Confirm")}
                                error_password_confirm={mismatch ? _("The passwords do not match") : ""}
                                change={(field, value) => {
                                    if (field === "password")
                                        setPassword(value);
                                    else
                                        setConfirm(value);
                                }} />
        </DialogFrame>
    );
};

export const RemoveAccessDialog = ({ user, onDone }: {
    user: SambaUser;
    onDone: () => void;
}) => (
    <ConfirmDialog title={cockpit.format(_("Remove Samba access for $0?"), user.name)}
                   actionLabel={_("Remove access")}
                   onApply={async () => {
                       await client.removePassword(user.name);
                       onDone();
                   }}>
        <p>
            {fmt_to_fragments(
                _("$0 will no longer be able to connect to any share on this server. The account itself, and its ability to log in, are not affected."),
                <strong>{user.name}</strong>)}
        </p>
    </ConfirmDialog>
);
