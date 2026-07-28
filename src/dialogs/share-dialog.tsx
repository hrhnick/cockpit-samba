/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useRef, useState } from "react";

import cockpit from "cockpit";
import { useInit } from "hooks";
import { FormHelper } from "cockpit-components-form-helper";
import { MultiTypeaheadSelect } from "cockpit-components-multi-typeahead-select";

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { FormGroup, FormSection } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import { DialogFrame } from "../components/dialog";
import { useAlerts } from "../components/alerts";
import * as client from "../samba/client";
import { type Share, type SambaConf, writeShare } from "../samba/conf";

const _ = cockpit.gettext;

export interface ShareDialogProps {
    /* The share being edited, or null when creating a new one. */
    share: Share | null;
    /* Every share, for the name collision check. */
    shares: Share[];
    applyConf: (mutate: (conf: SambaConf) => void) => Promise<void>;
    /* Re-check directory and SELinux state after the dialog changed it. */
    onPathsChanged: () => void;
}

interface FormState {
    name: string;
    path: string;
    comment: string;
    readOnly: boolean;
    browseable: boolean;
    guestOk: boolean;
    validUsers: string[];
}

const EMPTY: FormState = {
    name: "",
    path: "",
    comment: "",
    readOnly: false,
    browseable: true,
    guestOk: false,
    validUsers: [],
};

export const ShareDialog = ({ share, shares, applyConf, onPathsChanged }: ShareDialogProps) => {
    const alert = useAlerts();
    const isEdit = share !== null;

    const [form, setForm] = useState<FormState>(share
        ? {
            name: share.name,
            path: share.path,
            comment: share.comment,
            readOnly: share.readOnly,
            browseable: share.browseable,
            guestOk: share.guestOk,
            validUsers: share.validUsers,
        }
        : EMPTY);

    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [typed, setTyped] = useState("");
    /* undefined until the path has been checked at least once. */
    const [pathState, setPathState] = useState<client.PathState | undefined>();
    const [createFolder, setCreateFolder] = useState(true);
    const [applyAcls, setApplyAcls] = useState(true);

    const update = (fields: Partial<FormState>) => setForm(current => ({ ...current, ...fields }));

    useInit(() => {
        client.listUserGroupSuggestions().then(setSuggestions, () => setSuggestions([]));
        /* Check the folder of a share being edited too, so a share whose
           folder has gone missing offers to recreate it from here. */
        if (share?.path)
            client.checkPath(share.path).then(setPathState, () => null);
        return null;
    }, []);

    /* The path the field holds right now, so that a check which finishes
       after the user typed on can be discarded. */
    const currentPath = useRef(form.path);

    /* Check the folder as it is typed, so the dialog can offer to create
       it before the share is saved rather than after it is broken. */
    function setPath(path: string) {
        currentPath.current = path;
        update({ path });
        if (!path.startsWith("/")) {
            setPathState(undefined);
            return;
        }
        client.checkPath(path).then(state => {
            if (currentPath.current === path)
                setPathState(state);
        });
    }

    const name = form.name.trim();
    const path = form.path.trim();

    const nameError = (() => {
        if (!name)
            return "";
        if (name.toLowerCase() === "global")
            return _("\"global\" is reserved for the server's own settings.");
        if (/[[\]/]/.test(name))
            return _("Share names cannot contain [, ] or /.");
        if (name.length > 80)
            return _("Share names cannot be longer than 80 characters.");
        /* Samba matches section names case insensitively, so a name that
           differs only in case would silently take over the other share. */
        const clash = shares.find(s =>
            s.name.toLowerCase() === name.toLowerCase() &&
            s.name.toLowerCase() !== share?.name.toLowerCase());
        return clash ? cockpit.format(_("A share named \"$0\" already exists."), clash.name) : "";
    })();

    const needsPath = !share?.isSpecial;
    const pathError = (() => {
        if (!needsPath || !path)
            return "";
        if (!path.startsWith("/"))
            return _("The path must be absolute, starting with /.");
        if (pathState === "not-a-directory")
            return _("This path exists but is not a directory.");
        return "";
    })();

    const isMissing = needsPath && pathState === "missing";
    const isValid = !!name && !nameError && (!needsPath || (!!path && !pathError));

    /* Chips for the users and groups already on the share, the system's
       suggestions, and whatever is being typed, so an account Samba knows
       about but this machine does not can still be entered. */
    const userOptions = (() => {
        const values = new Set([...form.validUsers, ...suggestions]);
        if (typed.trim())
            values.add(typed.trim());
        return [...values].map(value => ({
            value,
            content: value,
            /* Groups yellow and users blue, as on the Accounts page. */
            color: value.startsWith("@") ? "yellow" as const : "blue" as const,
        }));
    })();

    async function onApply() {
        if (isMissing && createFolder) {
            await client.createDirectory(path);

            if (applyAcls && form.validUsers.length > 0) {
                const aclUnavailable = await client.applyPermissions(path, form.validUsers);
                if (aclUnavailable)
                    alert({
                        variant: "warning",
                        title: _("The folder was created, but per-user permissions could not be set."),
                        detail: _("setfacl is not available, so access is limited to the folder's owner and group."),
                    });
            }

            /* A new directory under /srv or /home gets a label that
               SELinux will not let Samba read. */
            if (await client.isSELinuxEnabled())
                await client.fixSELinuxContext(path).catch(() => null);
        }

        await applyConf(conf => writeShare(conf, {
            name,
            path,
            comment: form.comment.trim(),
            readOnly: form.readOnly,
            browseable: form.browseable,
            guestOk: form.guestOk,
            validUsers: form.validUsers,
            isSpecial: share?.isSpecial ?? false,
        }, share?.name));

        onPathsChanged();
    }

    return (
        <DialogFrame id="share-dialog"
                     title={share ? cockpit.format(_("Edit share $0"), share.name) : _("Create share")}
                     actionLabel={isEdit ? _("Save") : _("Create")}
                     isActionDisabled={!isValid}
                     onApply={onApply}
                     isForm isHorizontal>
            <FormGroup label={_("Name")} fieldId="share-name" isRequired>
                <TextInput id="share-name"
                           value={form.name}
                           validated={nameError ? "error" : "default"}
                           onChange={(_event, value) => update({ name: value })} />
                <FormHelper fieldId="share-name"
                            helperTextInvalid={nameError}
                            helperText={_("The name clients see when browsing this server.")} />
            </FormGroup>

            {needsPath && (
                <FormGroup label={_("Folder")} fieldId="share-path" isRequired>
                    <TextInput id="share-path"
                               value={form.path}
                               placeholder="/srv/samba/share"
                               validated={pathError ? "error" : "default"}
                               onChange={(_event, value) => setPath(value)} />
                    <FormHelper fieldId="share-path"
                                helperTextInvalid={pathError}
                                helperText={_("The folder on this machine that clients will see.")} />
                </FormGroup>
            )}

            <FormGroup label={_("Description")} fieldId="share-comment">
                <TextInput id="share-comment"
                           value={form.comment}
                           onChange={(_event, value) => update({ comment: value })} />
            </FormGroup>

            <FormGroup label={_("Access for")} fieldId="share-users">
                <MultiTypeaheadSelect id="share-users"
                                      options={userOptions}
                                      selected={form.validUsers}
                                      placeholder={form.validUsers.length === 0 ? _("Everyone with an account") : ""}
                                      onAdd={value => update({ validUsers: [...form.validUsers, String(value)] })}
                                      onRemove={value => update({ validUsers: form.validUsers.filter(u => u !== value) })}
                                      onInputChange={setTyped}
                                      noOptionsFoundMessage={() => _("Type a user name, or @ and a group name")} />
                <FormHelper fieldId="share-users"
                            helperText={_("Leave empty to let every user with a Samba password connect.")} />
            </FormGroup>

            <FormGroup label={_("Options")} role="group" fieldId="share-read-only" hasNoPaddingTop>
                <Checkbox id="share-read-only"
                          label={_("Read only")}
                          description={_("Clients can open and copy files, but not change them.")}
                          isChecked={form.readOnly}
                          onChange={(_event, checked) => update({ readOnly: checked })} />
                <Checkbox id="share-browseable"
                          label={_("Visible when browsing the server")}
                          description={_("When off, the share still works but has to be opened by name.")}
                          isChecked={form.browseable}
                          onChange={(_event, checked) => update({ browseable: checked })} />
                <Checkbox id="share-guest-ok"
                          label={_("Allow guests")}
                          description={_("Anyone on the network can connect without a password.")}
                          isChecked={form.guestOk}
                          onChange={(_event, checked) => update({ guestOk: checked })} />
            </FormGroup>

            {isMissing && (
                <FormSection>
                    <Alert isInline
                           variant="warning"
                           title={_("This folder does not exist yet")}>
                        <Checkbox id="share-create-folder"
                                  label={_("Create it now")}
                                  isChecked={createFolder}
                                  onChange={(_event, checked) => setCreateFolder(checked)} />
                        {createFolder && form.validUsers.length > 0 && (
                            <Checkbox id="share-apply-acls"
                                      label={_("Give the users above access to it")}
                                      isChecked={applyAcls}
                                      onChange={(_event, checked) => setApplyAcls(checked)} />
                        )}
                        {!createFolder && (
                            <p>{_("Samba cannot serve the share until the folder exists.")}</p>
                        )}
                    </Alert>
                </FormSection>
            )}
        </DialogFrame>
    );
};
