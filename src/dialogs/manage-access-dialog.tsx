/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/* Which local accounts may connect to the shares.
 *
 * Samba authenticates against its own password database rather than the
 * system one, so an account that exists on the machine still cannot use a
 * share until it has been given a Samba password. That is what this
 * dialog does; creating and deleting the accounts themselves stays in
 * Cockpit's Accounts page, which is linked from here.
 *
 * Setting a password and taking access away are separate views inside
 * this one dialog rather than dialogs of their own, because Dialogs.show()
 * allows only one dialog at a time.
 */

import React, { useCallback, useState } from "react";

import cockpit from "cockpit";
import { useDialogs } from "dialogs";
import { useInit } from "hooks";
import { KebabDropdown } from "cockpit-components-dropdown";
import { ListingTable } from "cockpit-components-table";
import { EmptyStatePanel } from "cockpit-components-empty-state";
import { PasswordFormFields } from "cockpit-components-password";
import { ModalError } from "cockpit-components-inline-notification";
import { fmt_to_fragments } from "utils";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Form } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import {
    Modal, ModalBody, ModalFooter, ModalHeader,
} from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { SearchIcon } from "@patternfly/react-icons";
import { SortByDirection } from "@patternfly/react-table";

import * as client from "../samba/client";
import type { SambaUser } from "../samba/client";
import type { Share } from "../samba/conf";

const _ = cockpit.gettext;

type View =
    | { name: "list" }
    | { name: "password", user: SambaUser }
    | { name: "remove", user: SambaUser };

/* The shares this account may connect to: those open to everyone with a
   password, and those whose list names the account or one of its groups.
   Turned-off shares are skipped — they admit nobody. */
function reachableShares(user: SambaUser, shares: Share[]): string[] {
    return shares
            .filter(share => share.available)
            .filter(share =>
                share.validUsers.length === 0 ||
                share.validUsers.includes(user.name) ||
                share.validUsers.some(entry =>
                    entry.startsWith("@") && user.groups.includes(entry.slice(1))))
            .map(share => share.name);
}

export const ManageAccessDialog = ({ canEdit, shares }: {
    canEdit: boolean;
    shares: Share[];
}) => {
    const Dialogs = useDialogs();

    const [users, setUsers] = useState<SambaUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState("");
    const [view, setView] = useState<View>({ name: "list" });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            setUsers(await client.listUsers());
        } catch (exception) {
            setError(client.errorString(exception));
        } finally {
            setLoading(false);
        }
    }, []);

    useInit(() => { reload() }, []);

    function show(next: View) {
        setError(null);
        setPassword("");
        setConfirm("");
        setView(next);
    }

    async function attempt(action: () => Promise<void>) {
        setBusy(true);
        setError(null);
        try {
            await action();
            await reload();
            show({ name: "list" });
        } catch (exception) {
            setError(client.errorString(exception));
        } finally {
            setBusy(false);
        }
    }

    /* --- Set or change a password --- */

    if (view.name === "password") {
        const user = view.user;
        const mismatch = confirm.length > 0 && password !== confirm;

        return (
            <Modal id="manage-access-dialog" isOpen position="top" variant="medium"
                   onClose={() => Dialogs.close()}>
                <ModalHeader title={user.hasPassword
                    ? cockpit.format(_("Change Samba password for $0"), user.name)
                    : cockpit.format(_("Set Samba password for $0"), user.name)}
                             description={_("This password is only used to connect to shares. The account's login password is left alone.")} />
                <ModalBody>
                    {error && <ModalError dialogError={error} />}
                    <Form onSubmit={event => event.preventDefault()}>
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
                    </Form>
                </ModalBody>
                <ModalFooter>
                    <Button variant="primary"
                            isLoading={busy}
                            isDisabled={busy || !password || password !== confirm}
                            onClick={() => attempt(() => client.setPassword(user.name, password))}>
                        {user.hasPassword ? _("Change password") : _("Set password")}
                    </Button>
                    <Button variant="link" isDisabled={busy} onClick={() => show({ name: "list" })}>
                        {_("Back")}
                    </Button>
                </ModalFooter>
            </Modal>
        );
    }

    /* --- Take access away --- */

    if (view.name === "remove") {
        const user = view.user;

        return (
            <Modal id="manage-access-dialog" isOpen position="top" variant="small"
                   onClose={() => Dialogs.close()}>
                <ModalHeader title={cockpit.format(_("Remove Samba access for $0?"), user.name)}
                             titleIconVariant="warning" />
                <ModalBody>
                    {error && <ModalError dialogError={error} />}
                    <p>
                        {fmt_to_fragments(
                            _("$0 will no longer be able to connect to any share on this server. The account itself, and its ability to log in, are not affected."),
                            <strong>{user.name}</strong>)}
                    </p>
                </ModalBody>
                <ModalFooter>
                    <Button variant="danger"
                            isLoading={busy}
                            isDisabled={busy}
                            onClick={() => attempt(() => client.removePassword(user.name))}>
                        {_("Remove access")}
                    </Button>
                    <Button variant="link" isDisabled={busy} onClick={() => show({ name: "list" })}>
                        {_("Back")}
                    </Button>
                </ModalFooter>
            </Modal>
        );
    }

    /* --- The list of accounts --- */

    const needle = filter.trim().toLowerCase();
    const filtered = users.filter(user =>
        !needle || user.name.toLowerCase().includes(needle) || user.fullName.toLowerCase().includes(needle));

    const columns = [
        { title: _("User"), sortable: true },
        { title: _("Full name"), sortable: true },
        { title: _("Samba access"), sortable: true },
        { title: _("Shares") },
        { title: "", props: { screenReaderText: _("Actions") } },
    ];

    const rows = filtered.map(user => ({
        props: { key: user.name, "data-row-id": user.name },
        columns: [
            { title: user.name, sortKey: user.name, props: { width: 20 as const } },
            { title: user.fullName, sortKey: user.fullName, props: { width: 25 as const } },
            {
                title: user.hasPassword
                    ? <Label color="green">{_("Allowed")}</Label>
                    : <Label color="grey">{_("No access")}</Label>,
                sortKey: user.hasPassword ? "1" : "0",
            },
            {
                /* Which shares the password would open, not which are
                   open now: it answers "what happens if I allow this
                   account" for accounts without one too. */
                title: (() => {
                    const names = reachableShares(user, shares);
                    if (names.length === 0)
                        return <span className="samba-subtle">{_("None")}</span>;
                    return (
                        <Flex spaceItems={{ default: "spaceItemsSm" }}>
                            {names.map(name => <Label key={name} isCompact>{name}</Label>)}
                        </Flex>
                    );
                })(),
            },
            {
                title: canEdit
                    ? (
                        <KebabDropdown dropdownItems={[
                            <DropdownItem key="password" onClick={() => show({ name: "password", user })}>
                                {user.hasPassword ? _("Change Samba password") : _("Set Samba password")}
                            </DropdownItem>,
                            ...user.hasPassword
                                ? [
                                    <DropdownItem key="remove" isDanger
                                                  onClick={() => show({ name: "remove", user })}>
                                        {_("Remove Samba access")}
                                    </DropdownItem>
                                ]
                                : [],
                        ]} />
                    )
                    : null,
                props: { className: "pf-v6-c-table__action" },
            },
        ],
    }));

    return (
        <Modal id="manage-access-dialog" isOpen position="top" variant="large"
               onClose={() => Dialogs.close()}>
            <ModalHeader title={_("Manage access")}
                         description={_("An account can connect to the shares once it has a Samba password. This is separate from the password it logs in with.")} />
            <ModalBody>
                {error && <ModalError dialogError={error} />}
                <Toolbar>
                    <ToolbarContent>
                        <ToolbarItem>
                            <SearchInput id="samba-access-filter"
                                         placeholder={_("Search for a user")}
                                         value={filter}
                                         onChange={(_event, value) => setFilter(value)}
                                         onClear={() => setFilter("")} />
                        </ToolbarItem>
                        <ToolbarItem align={{ md: "alignEnd" }}>
                            <Button variant="secondary" onClick={() => cockpit.jump("/users")}>
                                {_("Manage accounts")}
                            </Button>
                        </ToolbarItem>
                    </ToolbarContent>
                </Toolbar>
                <ListingTable id="samba-users"
                              aria-label={_("Samba access")}
                              variant="compact"
                              columns={columns}
                              rows={rows}
                              sortBy={{ index: 0, direction: SortByDirection.asc }}
                              loading={loading ? _("Loading…") : ""}
                              isEmptyStateInTable={needle !== "" && filtered.length !== users.length}
                              emptyComponent={needle
                                  ? (
                                      <EmptyStatePanel title={_("No matching user")}
                                                       icon={SearchIcon}
                                                       action={_("Clear filter")}
                                                       actionVariant="link"
                                                       onAction={() => setFilter("")} />
                                  )
                                  : (
                                      <EmptyStatePanel title={_("No user accounts")}
                                                       paragraph={_("Only accounts a person can log in with are listed here.")} />
                                  )} />
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={() => Dialogs.close()}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
};
