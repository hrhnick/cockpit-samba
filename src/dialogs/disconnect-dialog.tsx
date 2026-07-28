/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

import React from "react";

import cockpit from "cockpit";
import { fmt_to_fragments } from "utils";

import { ConfirmDialog } from "../components/dialog";
import * as client from "../samba/client";
import type { Connection } from "../samba/client";

const _ = cockpit.gettext;

/* Drop a client's sessions. smbd can only be asked to close everything
 * from one address, so a machine with several sessions loses all of them,
 * and a client that is still mounting the share will simply reconnect.
 */
export const DisconnectClientDialog = ({ connection, onDone }: {
    connection: Connection;
    onDone: () => void;
}) => (
    <ConfirmDialog title={cockpit.format(_("Disconnect $0?"), connection.machine)}
                   actionLabel={_("Disconnect")}
                   onApply={async () => {
                       await client.disconnectClient(connection.machine);
                       onDone();
                   }}>
        <p>
            {fmt_to_fragments(
                _("Everything $0 has open on this server is closed, and unsaved work on those files is lost."),
                <strong>{connection.machine}</strong>)}
        </p>
        <p className="pf-v6-u-mt-sm">
            {_("A client that still has the share mounted will usually connect again straight away.")}
        </p>
    </ConfirmDialog>
);
