/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useEffect, useRef, useState } from "react";

import cockpit from "cockpit";
import { useDialogs } from "dialogs";
import { useInit } from "hooks";
import { InlineNotification } from "cockpit-components-inline-notification";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { CodeBlock, CodeBlockCode } from "@patternfly/react-core/dist/esm/components/CodeBlock/index.js";
import {
    Modal, ModalBody, ModalFooter, ModalHeader,
} from "@patternfly/react-core/dist/esm/components/Modal/index.js";

import * as client from "../samba/client";
import { AUDIT_IDENTIFIER, isAuditEnabled, setAuditEnabled, type SambaConf } from "../samba/conf";

const _ = cockpit.gettext;

/* A long-lived stream would grow without bound; keep a window of the most
   recent output. */
const BUFFER_LIMIT = 200000;
const BUFFER_KEEP = 150000;

export const LogsDialog = ({ conf, unit, applyConf, canEdit }: {
    conf: SambaConf;
    unit: string | null;
    applyConf: (mutate: (conf: SambaConf) => void) => Promise<void>;
    canEdit: boolean;
}) => {
    const Dialogs = useDialogs();
    const [text, setText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [toggling, setToggling] = useState(false);
    const view = useRef<HTMLDivElement>(null);

    const auditEnabled = isAuditEnabled(conf);

    useInit(() => {
        const proc = client.followLogs(unit, AUDIT_IDENTIFIER, chunk =>
            setText(current => {
                const next = current + chunk;
                return next.length > BUFFER_LIMIT ? next.slice(next.length - BUFFER_KEEP) : next;
            }));

        /* journalctl --follow only ends if it fails or we close it, and
           closing it surfaces as "cancelled", which is not an error. */
        proc.catch((exception: client.SpawnError) => {
            if (exception?.problem !== "cancelled")
                setError(cockpit.format(_("The log stream stopped: $0"), client.errorString(exception)));
        });

        return proc;
    }, [unit], undefined, proc => proc.close());

    /* Keep the newest output in view as it arrives. */
    useEffect(() => {
        if (view.current)
            view.current.scrollTop = view.current.scrollHeight;
    }, [text]);

    async function toggleAudit(enabled: boolean) {
        setToggling(true);
        setError(null);
        try {
            await applyConf(current => setAuditEnabled(current, enabled));
        } catch (exception) {
            setError(client.errorString(exception));
        } finally {
            setToggling(false);
        }
    }

    return (
        <Modal id="logs-dialog" isOpen position="top" variant="large" onClose={() => Dialogs.close()}>
            <ModalHeader title={_("Samba logs")} />
            <ModalBody>
                {error && <InlineNotification type="danger" text={error} onDismiss={() => setError(null)} />}
                <Checkbox id="samba-audit"
                          label={_("Log file activity")}
                          description={_("Record when connected clients create, change, rename or delete files. Off by default because it adds a line per operation.")}
                          isChecked={auditEnabled}
                          isDisabled={toggling || !canEdit}
                          onChange={(_event, checked) => toggleAudit(checked)} />
                <CodeBlock>
                    <CodeBlockCode>
                        <div ref={view} className="samba-log-scroll">
                            {text || _("Waiting for log output…")}
                        </div>
                    </CodeBlockCode>
                </CodeBlock>
            </ModalBody>
            <ModalFooter>
                <Button variant="secondary" onClick={() => cockpit.jump("/system/logs")}>
                    {_("View all logs")}
                </Button>
                <Button variant="primary" onClick={() => Dialogs.close()}>
                    {_("Close")}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
