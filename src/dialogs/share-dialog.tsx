/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useRef, useState } from "react";

import cockpit from "cockpit";
import { useInit } from "hooks";
import { FormHelper } from "cockpit-components-form-helper";
import { MultiTypeaheadSelect } from "cockpit-components-multi-typeahead-select";
import { TypeaheadSelect } from "cockpit-components-typeahead-select";

import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import {
    ExpandableSection,
} from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { FormGroup, FormSection } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import { DialogFrame } from "../components/dialog";
import { useAlerts } from "../components/alerts";
import { grantAccess, sharePrincipals, SystemFolderAlert } from "./share-actions";
import * as client from "../samba/client";
import { isProtectedPath } from "../samba/paths";
import { emptyShare, type Share, type SambaConf, writeShare } from "../samba/conf";

const fmt = cockpit.format;

const _ = cockpit.gettext;

export interface ShareDialogProps {
    /* The share being edited, or null when creating a new one. */
    share: Share | null;
    /* Every share, for the name collision check. */
    shares: Share[];
    /* Whether the server maps unknown users to the guest account at all.
       Without it a share can allow guests and still turn them away. */
    guestLoginsAllowed: boolean;
    /* The account guests connect as, which `valid users` is checked
       against like anyone else. */
    guestAccount: string;
    applyConf: (mutate: (conf: SambaConf) => void) => Promise<void>;
    /* Re-check directory and SELinux state after the dialog changed it. */
    onPathsChanged: () => void;
}

/* Samba writes permissions as an octal mask, the same three or four
   digits as chmod. */
const MASK_RE = /^[0-7]{3,4}$/;

/* Sizes the way vfs_fruit takes them: a number and one of Samba's
   binary suffixes. */
const SIZE_RE = /^[0-9]+\s*[KMGTP]?$/i;

export const ShareDialog = ({
    share, shares, guestLoginsAllowed, guestAccount, applyConf, onPathsChanged,
}: ShareDialogProps) => {
    const alert = useAlerts();
    const isEdit = share !== null;

    const [form, setForm] = useState<Share>(share ?? emptyShare());

    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [typed, setTyped] = useState("");
    const [writerTyped, setWriterTyped] = useState("");
    /* undefined until the path has been checked at least once. */
    const [pathState, setPathState] = useState<client.PathState | undefined>();
    const [createFolder, setCreateFolder] = useState(true);
    const [applyAcls, setApplyAcls] = useState(true);
    /* Off by default when editing: the folder may have been given
       permissions by hand that the share's user list knows nothing about,
       and taking them over uninvited would be a surprise. */
    const [fixPermissions, setFixPermissions] = useState(false);
    const [isAdvancedOpen, setAdvancedOpen] = useState(false);

    const update = (fields: Partial<Share>) => setForm(current => ({ ...current, ...fields }));

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

    const maskError = (value: string) =>
        (!value.trim() || MASK_RE.test(value.trim()) ? "" : _("Enter three or four digits, as for chmod."));
    const createMaskError = maskError(form.createMask);
    const directoryMaskError = maskError(form.directoryMask);

    const sizeError = form.timeMachine && form.timeMachineMaxSize.trim() &&
        !SIZE_RE.test(form.timeMachineMaxSize.trim())
        ? _("Enter a number with a unit, like 500G or 1T.")
        : "";

    /* Time Machine writes backups, so a read-only backup target is a
       contradiction rather than a choice. */
    const timeMachineError = form.timeMachine && form.readOnly
        ? _("Time Machine has to write to the share, so turn Read only off.")
        : "";

    /* `valid users`, once set, is the whole list of who may connect;
       write list grants writing, not entry. A writer missing from the
       list would be turned away at the door with their write permission
       in hand. Adding a writer adds them to the list automatically, so
       this only trips when someone is removed from one list but not the
       other. */
    const shutOutWriters = form.validUsers.length > 0
        ? form.writeList.filter(w => !form.validUsers.includes(w))
        : [];
    const writeListError = shutOutWriters.length > 0
        ? fmt(_("$0 cannot connect to the share: \"Access for\" is set and does not include them."),
              shutOutWriters.join(", "))
        : "";

    /* The same gate catches guests: they connect as the guest account. */
    const guestsShutOut = form.guestOk && form.validUsers.length > 0 &&
        !form.validUsers.includes(guestAccount);

    const isMissing = needsPath && pathState === "missing";
    const folderExists = needsPath && pathState === "ok";
    /* A folder whose permissions this page will not take over; see
       samba/paths.ts. The share itself is still allowed — Samba can serve
       whatever the admin points it at — but the folder is left alone. */
    const isSystemFolder = needsPath && !!path && isProtectedPath(path);
    const isValid = !!name && !nameError && !createMaskError && !directoryMaskError &&
        !sizeError && !timeMachineError && !writeListError &&
        (!needsPath || (!!path && !pathError));

    /* Chips for the users and groups already on the share, the system's
       suggestions, and whatever is being typed, so an account Samba knows
       about but this machine does not can still be entered. */
    const principalOptions = (selected: string[], typing: string) => {
        const values = new Set([...selected, ...suggestions]);
        if (typing.trim())
            values.add(typing.trim());
        return [...values].map(value => ({
            value,
            content: value,
            /* Groups yellow and users blue, as on the Accounts page. */
            color: value.startsWith("@") ? "yellow" as const : "blue" as const,
        }));
    };

    /* force group takes a group name without the @ that smb.conf's user
       lists use to mark one. */
    const groupOptions = (() => {
        const names = suggestions.filter(s => s.startsWith("@")).map(s => s.slice(1));
        if (form.forceGroup && !names.includes(form.forceGroup))
            names.unshift(form.forceGroup);
        return names.map(value => ({ value, content: value }));
    })();

    const nextShare = (): Share => ({
        ...form,
        name,
        path,
        comment: form.comment.trim(),
        forceGroup: form.forceGroup.trim(),
        createMask: form.createMask.trim(),
        directoryMask: form.directoryMask.trim(),
        hostsAllow: form.hostsAllow.trim(),
        hostsDeny: form.hostsDeny.trim(),
        timeMachineMaxSize: form.timeMachineMaxSize.trim(),
        isSpecial: share?.isSpecial ?? false,
    });

    async function onApply() {
        const next = nextShare();
        const hasPrincipals = sharePrincipals(next).length > 0;

        if (isMissing && createFolder) {
            await client.createDirectory(path);

            if (applyAcls && hasPrincipals && !isSystemFolder)
                await grantAccess(next, true, alert);

            /* A new directory under /srv or /home gets a label that
               SELinux will not let Samba read. */
            if (await client.isSELinuxEnabled())
                await client.fixSELinuxContext(path).catch(() => null);
        } else if (folderExists && fixPermissions && hasPrincipals && !isSystemFolder) {
            await grantAccess(next, false, alert);
        }

        await applyConf(conf => writeShare(conf, next, share?.name));

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
                                      options={principalOptions(form.validUsers, typed)}
                                      selected={form.validUsers}
                                      placeholder={form.validUsers.length === 0 ? _("Everyone with an account") : ""}
                                      onAdd={value => update({ validUsers: [...form.validUsers, String(value)] })}
                                      onRemove={value => update({ validUsers: form.validUsers.filter(u => u !== value) })}
                                      onInputChange={setTyped}
                                      noOptionsFoundMessage={() => _("Type a user name, or @ and a group name")} />
                <FormHelper fieldId="share-users"
                            helperText={_("Leave empty to let every user with a Samba password connect.")} />
            </FormGroup>

            <FormGroup label={_("Options")} role="group" fieldId="share-available" hasNoPaddingTop>
                <Checkbox id="share-available"
                          label={_("Enabled")}
                          description={_("When off, the share keeps its configuration but clients cannot connect to it.")}
                          isChecked={form.available}
                          onChange={(_event, checked) => update({ available: checked })} />
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
                          description={guestLoginsAllowed
                              ? _("Anyone on the network can connect without a password.")
                              : _("Anyone on the network can connect without a password. Saving will also set the server to accept guest logins, which it does not do by default.")}
                          isChecked={form.guestOk}
                          onChange={(_event, checked) => update({ guestOk: checked })} />
            </FormGroup>

            {/* Warned rather than blocked: adding the guest account to
                the list is a legitimate way to have both. */}
            {guestsShutOut && (
                <FormSection>
                    <Alert isInline variant="warning" id="share-guest-conflict"
                           title={_("Guests are allowed but cannot get in")}>
                        {fmt(_("Guests connect as the $0 account, and \"Access for\" does not include it. Add $0 to the list, or clear the list."),
                             guestAccount)}
                    </Alert>
                </FormSection>
            )}

            {isMissing && (
                <FormSection>
                    <Alert isInline
                           variant="warning"
                           title={_("This folder does not exist yet")}>
                        <Checkbox id="share-create-folder"
                                  label={_("Create it now")}
                                  isChecked={createFolder}
                                  onChange={(_event, checked) => setCreateFolder(checked)} />
                        {createFolder && !isSystemFolder && sharePrincipals(form).length > 0 && (
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

            {/* Samba checks the folder's own permissions as well as the
                share's user list, and changing the one does not change the
                other. */}
            {folderExists && !isSystemFolder && sharePrincipals(form).length > 0 && (
                <FormGroup label={_("Folder permissions")} role="group"
                           fieldId="share-fix-permissions" hasNoPaddingTop>
                    <Checkbox id="share-fix-permissions"
                              label={_("Set the folder's permissions to match")}
                              description={_("Gives the users above access to the folder itself. Without this the share's user list can allow someone the folder still keeps out.")}
                              isChecked={fixPermissions}
                              onChange={(_event, checked) => setFixPermissions(checked)} />
                </FormGroup>
            )}

            {isSystemFolder && (
                <FormSection>
                    <SystemFolderAlert path={path} />
                </FormSection>
            )}

            <ExpandableSection toggleText={_("More options")}
                               isExpanded={isAdvancedOpen}
                               onToggle={(_event, expanded) => setAdvancedOpen(expanded)}>
                <FormGroup label={_("May write")} fieldId="share-write-list">
                    <MultiTypeaheadSelect id="share-write-list"
                                          options={principalOptions(form.writeList, writerTyped)}
                                          selected={form.writeList}
                                          placeholder={form.writeList.length === 0 ? _("Nobody in particular") : ""}
                                          onAdd={value => {
                                              const writer = String(value);
                                              /* A writer has to be able to connect, and once
                                                 "Access for" is a list, being on it is what
                                                 grants that. */
                                              const validUsers = form.validUsers.length > 0 &&
                                                  !form.validUsers.includes(writer)
                                                  ? [...form.validUsers, writer]
                                                  : form.validUsers;
                                              update({ writeList: [...form.writeList, writer], validUsers });
                                          }}
                                          onRemove={value => update({ writeList: form.writeList.filter(u => u !== value) })}
                                          onInputChange={setWriterTyped}
                                          noOptionsFoundMessage={() => _("Type a user name, or @ and a group name")} />
                    <FormHelper fieldId="share-write-list"
                                helperTextInvalid={writeListError}
                                helperText={_("These may change files even when the share is read only. Anyone added here is also added to \"Access for\" when that is a list.")} />
                </FormGroup>

                <FormGroup label={_("Allowed clients")} fieldId="share-hosts-allow">
                    <TextInput id="share-hosts-allow"
                               value={form.hostsAllow}
                               placeholder="192.168.1. 10.0.0.0/8"
                               onChange={(_event, value) => update({ hostsAllow: value })} />
                    <FormHelper fieldId="share-hosts-allow"
                                helperText={_("Addresses, names or subnets that may connect. Leave empty to allow any.")} />
                </FormGroup>

                <FormGroup label={_("Refused clients")} fieldId="share-hosts-deny">
                    <TextInput id="share-hosts-deny"
                               value={form.hostsDeny}
                               onChange={(_event, value) => update({ hostsDeny: value })} />
                    <FormHelper fieldId="share-hosts-deny"
                                helperText={_("Checked after the allowed list, so it takes an address back out of it.")} />
                </FormGroup>

                <FormGroup label={_("New files belong to")} fieldId="share-force-group">
                    <TypeaheadSelect id="share-force-group"
                                     selectOptions={groupOptions}
                                     selected={form.forceGroup || null}
                                     selectedIsTrusted
                                     isCreatable
                                     placeholder={_("The user who created them")}
                                     onSelect={(_event, value) => update({ forceGroup: String(value) })}
                                     onClearSelection={() => update({ forceGroup: "" })}
                                     createOptionMessage={value => cockpit.format(_("Use \"$0\""), value)}
                                     noOptionsAvailableMessage={_("No groups found")} />
                    <FormHelper fieldId="share-force-group"
                                helperText={_("Puts everything clients create into one group, so the people sharing the folder can reach each other's files.")} />
                </FormGroup>

                <FormGroup label={_("New file permissions")} fieldId="share-create-mask">
                    <TextInput id="share-create-mask"
                               value={form.createMask}
                               placeholder="0744"
                               validated={createMaskError ? "error" : "default"}
                               onChange={(_event, value) => update({ createMask: value })} />
                    <FormHelper fieldId="share-create-mask"
                                helperTextInvalid={createMaskError}
                                helperText={_("The most a new file may be given, as an octal mask. 0664 lets the group write.")} />
                </FormGroup>

                <FormGroup label={_("New folder permissions")} fieldId="share-directory-mask">
                    <TextInput id="share-directory-mask"
                               value={form.directoryMask}
                               placeholder="0755"
                               validated={directoryMaskError ? "error" : "default"}
                               onChange={(_event, value) => update({ directoryMask: value })} />
                    <FormHelper fieldId="share-directory-mask"
                                helperTextInvalid={directoryMaskError}
                                helperText={_("The same, for folders. 0775 lets the group add files.")} />
                </FormGroup>

                <FormGroup label={_("Extras")} role="group" fieldId="share-recycle" hasNoPaddingTop>
                    <Checkbox id="share-recycle"
                              label={_("Recycle bin")}
                              description={_("Files deleted over the network are moved to a .recycle folder in the share instead of being destroyed. Nothing empties it by itself.")}
                              isChecked={form.recycleBin}
                              onChange={(_event, checked) => update({ recycleBin: checked })} />
                    <Checkbox id="share-time-machine"
                              label={_("Time Machine backups")}
                              description={_("Offers the share to macOS as a backup destination, and stores the file metadata macOS expects.")}
                              isChecked={form.timeMachine}
                              onChange={(_event, checked) => update({ timeMachine: checked })} />
                    <FormHelper fieldId="share-time-machine"
                                helperTextInvalid={timeMachineError} />
                </FormGroup>

                {form.timeMachine && (
                    <FormGroup label={_("Backup size limit")} fieldId="share-tm-max-size">
                        <TextInput id="share-tm-max-size"
                                   value={form.timeMachineMaxSize}
                                   placeholder="1T"
                                   validated={sizeError ? "error" : "default"}
                                   onChange={(_event, value) => update({ timeMachineMaxSize: value })} />
                        <FormHelper fieldId="share-tm-max-size"
                                    helperTextInvalid={sizeError}
                                    helperText={_("How much space the backups may use, like 500G or 1T. Without a limit, macOS grows them until the disk is full.")} />
                    </FormGroup>
                )}
            </ExpandableSection>
        </DialogFrame>
    );
};
