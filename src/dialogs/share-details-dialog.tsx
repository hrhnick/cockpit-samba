/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

/* Everything about one share that is worth reading but not worth a table
 * column: who may connect and write, client address restrictions, free
 * space, the address to type into a client, and any reason the share
 * cannot currently work. This used to live in an expandable table row;
 * it is a dialog now, opened from "View details" in the row's menu.
 *
 * The problem detection lives here too, because the alert that explains
 * a problem and the fix it offers are the heart of this dialog. The
 * shares table imports it for the warning icon in the folder column.
 */

import React from "react";

import cockpit from "cockpit";
import { useDialogs } from "dialogs";
import { fmt_to_fragments } from "utils";

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { ClipboardCopy } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm,
} from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import {
    Modal, ModalBody, ModalFooter, ModalHeader,
} from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import { PrincipalLabels } from "../components/labels";
import type { PathStatus } from "../samba/hooks";
import { guestsShutOut, type Share } from "../samba/conf";

const _ = cockpit.gettext;

/* The address a client types to reach the share. Cockpit may be managing a
   different machine than the one serving the page, in which case the
   transport knows its name. */
function serverAddress(): string {
    const host = cockpit.transport.host;
    return !host || host === "localhost" ? window.location.hostname : host;
}

/* A share whose folder is missing or SELinux-blocked shows that in the
   table, next to the path, with the fix in the row's menu — not here.
   This dialog is the read-only detail, so it explains the configuration
   without repeating the folder warning or carrying its fix. */
export const ShareDetailsDialog = ({
    share, status, inUse, guestLoginsAllowed, guestAccount,
}: {
    share: Share;
    status: PathStatus | undefined;
    /* Connections that currently have this share open. */
    inUse: number;
    guestLoginsAllowed: boolean;
    guestAccount: string;
}) => {
    const Dialogs = useDialogs();
    const disk = status?.disk;

    return (
        <Modal id="share-details-dialog" isOpen position="top" variant="medium"
               onClose={() => Dialogs.close()}>
            <ModalHeader title={share.name} description={share.comment} />
            <ModalBody>
                <Stack hasGutter>
                    {!share.available && (
                        <Alert isInline variant="info" title={_("This share is turned off")}>
                            {_("It keeps its configuration, but Samba does not offer it to clients.")}
                        </Alert>
                    )}
                    {share.guestOk && !guestLoginsAllowed && (
                        <Alert isInline variant="warning" title={_("Guests are allowed but cannot log in")}>
                            {fmt_to_fragments(
                                _("This share allows guests, but the server's $0 setting turns unknown users away before they reach it. Saving the share from $1 sets it."),
                                <code>map to guest</code>, <strong>{_("Edit share")}</strong>)}
                        </Alert>
                    )}
                    {guestLoginsAllowed && guestsShutOut(share, guestAccount) && (
                        <Alert isInline variant="warning" title={_("Guests are allowed but the user list keeps them out")}>
                            {cockpit.format(
                                _("Guests connect as the $0 account, and \"Who can connect\" does not include it. Edit the share and add $0, or clear the list."),
                                guestAccount)}
                        </Alert>
                    )}
                    <DescriptionList isHorizontal>
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Who can connect")}</DescriptionListTerm>
                            <DescriptionListDescription>
                                {share.validUsers.length === 0
                                    ? _("Every user with a Samba password")
                                    : <PrincipalLabels principals={share.validUsers} />}
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                        {share.writeList.length > 0 && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("May write")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <PrincipalLabels principals={share.writeList} />
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {(share.hostsAllow || share.hostsDeny) && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Client addresses")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {share.hostsAllow && (
                                        <div>{cockpit.format(_("Allowed: $0"), share.hostsAllow)}</div>
                                    )}
                                    {share.hostsDeny && (
                                        <div>{cockpit.format(_("Refused: $0"), share.hostsDeny)}</div>
                                    )}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Connected clients")}</DescriptionListTerm>
                            <DescriptionListDescription>{inUse}</DescriptionListDescription>
                        </DescriptionListGroup>
                        {disk && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Free space")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {cockpit.format(_("$0 free of $1"),
                                                    cockpit.format_bytes(disk.available),
                                                    cockpit.format_bytes(disk.total))}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {share.path && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Network address")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {/* Read only, but still selectable and
                                        copyable: it has to be typed into a
                                        client exactly. */}
                                    <ClipboardCopy isReadOnly hoverTip={_("Copy")} clickTip={_("Copied")}
                                                   variant="inline-compact">
                                        {`\\\\${serverAddress()}\\${share.name}`}
                                    </ClipboardCopy>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                </Stack>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={() => Dialogs.close()}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
};
