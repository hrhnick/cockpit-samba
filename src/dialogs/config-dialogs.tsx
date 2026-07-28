/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

import React, { useState } from "react";

import cockpit from "cockpit";
import { fmt_to_fragments } from "utils";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { FileUpload } from "@patternfly/react-core/dist/esm/components/FileUpload/index.js";
import { FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";

import { DialogFrame } from "../components/dialog";
import * as client from "../samba/client";
import { globalText, setGlobalText, serializeConf, type SambaConf } from "../samba/conf";

const _ = cockpit.gettext;

/* Edit the [global] section as text. It holds several dozen parameters
 * that no form could reasonably cover, so this is a text field with
 * testparm as the guard rail: an invalid section is rejected before it
 * reaches the file.
 */
export const GlobalSettingsDialog = ({ conf, applyConf }: {
    conf: SambaConf;
    applyConf: (mutate: (conf: SambaConf) => void) => Promise<void>;
}) => {
    const [text, setText] = useState(() => globalText(conf));

    return (
        <DialogFrame id="global-settings-dialog"
                     title={_("Global settings")}
                     description={fmt_to_fragments(
                         _("The $0 section of the Samba configuration. Changes are checked with $1 before they are saved."),
                         <code>[global]</code>, <code>testparm</code>)}
                     actionLabel={_("Save")}
                     onApply={() => applyConf(current => setGlobalText(current, text))}>
            <FormGroup label={_("Settings")} fieldId="global-settings-text">
                <TextArea id="global-settings-text"
                          value={text}
                          onChange={(_event, value) => setText(value)}
                          aria-label={_("Global settings")}
                          resizeOrientation="vertical"
                          rows={16}
                          className="samba-conf-editor" />
            </FormGroup>
        </DialogFrame>
    );
};

/* Cockpit runs each page in a sandboxed iframe without allow-downloads,
 * so a download started from inside this frame is blocked silently. The
 * sandbox does allow same-origin, which the bridge needs, so the shell's
 * own document is reachable: build and click the link there, using that
 * realm's Blob and URL so the object URL is valid in it.
 */
function downloadText(filename: string, text: string) {
    let target: Window & typeof globalThis = window;
    try {
        const top = window.top as (Window & typeof globalThis) | null;
        if (top?.document?.body)
            target = top;
    } catch {
        /* A cross-origin top window is not reachable; try our own frame
           and let the browser decide. */
    }

    const url = target.URL.createObjectURL(new target.Blob([text], { type: "text/plain" }));
    const link = target.document.createElement("a");
    link.href = url;
    link.download = filename;
    target.document.body.appendChild(link);
    link.click();
    target.document.body.removeChild(link);
    target.setTimeout(() => target.URL.revokeObjectURL(url), 1000);
}

/* Download the current smb.conf, or load one from the user's machine and
 * put it back. Nothing is written until Save, and Save goes through the
 * same testparm check and .bak backup as every other change.
 */
export const BackupRestoreDialog = ({ conf, tag }: {
    conf: SambaConf;
    /* The file tag we last saw, so a config that changed underneath us is
       not silently overwritten. */
    tag: string | null;
}) => {
    /* The parser round-trips, so this is the file exactly as it is on
       disk, without reading it again. */
    const [original] = useState(() => serializeConf(conf));
    const [text, setText] = useState(original);
    const [filename, setFilename] = useState("");
    const [loading, setLoading] = useState(false);

    const isModified = text !== original;

    return (
        <DialogFrame id="backup-restore-dialog"
                     variant="large"
                     title={_("Back up or restore configuration")}
                     description={_("Save a copy of the Samba configuration, or replace it with one you saved earlier.")}
                     actionLabel={_("Save")}
                     isActionDisabled={!isModified}
                     onApply={() => client.writeRawConf(text, tag ?? undefined)}
                     secondaryActions={
                         <Button variant="secondary" onClick={() => downloadText("smb.conf", original)}>
                             {_("Download current configuration")}
                         </Button>
                     }>
            <FormGroup label={_("Configuration")} fieldId="backup-restore-text">
                <FileUpload id="backup-restore-text"
                            type="text"
                            value={text}
                            filename={filename}
                            filenamePlaceholder={_("Drag a configuration file here, or edit below")}
                            browseButtonText={_("Upload")}
                            clearButtonText={_("Revert")}
                            allowEditingUploadedText
                            isLoading={loading}
                            hideDefaultPreview={false}
                            onFileInputChange={(_event, file) => setFilename(file.name)}
                            onDataChange={(_event, data) => setText(data)}
                            onTextChange={(_event, value) => setText(value)}
                            onReadStarted={() => setLoading(true)}
                            onReadFinished={() => setLoading(false)}
                            onClearClick={() => { setFilename(""); setText(original) }}
                            aria-label={_("Samba configuration")} />
            </FormGroup>
        </DialogFrame>
    );
};
