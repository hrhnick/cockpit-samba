/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
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
import * as timeformat from "timeformat";
import { KebabDropdown } from "cockpit-components-dropdown";
import { ListingTable } from "cockpit-components-table";
import { EmptyStatePanel } from "cockpit-components-empty-state";
import { PasswordFormFields } from "cockpit-components-password";
import { ModalError } from "cockpit-components-inline-notification";
import { fmt_to_fragments } from "utils";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import {
    Modal, ModalBody, ModalFooter, ModalHeader,
} from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { SortByDirection } from "@patternfly/react-table";

import { DialogFrame } from "../components/dialog";
import { ShareLabels } from "../components/labels";
import { FilterInput, NoMatchState, useSearch } from "../components/search";
import * as client from "../samba/client";
import type { Connection, SambaUser } from "../samba/client";
import { CONNECTION_POLL_SECONDS, usePolled } from "../samba/hooks";
import { groupEntryName, isGroupEntry, type Share } from "../samba/conf";

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
                    isGroupEntry(entry) && user.groups.includes(groupEntryName(entry))))
            .map(share => share.name);
}

export const ManageAccessDialog = ({ canEdit, shares }: {
    canEdit: boolean;
    shares: Share[];
}) => {
    const Dialogs = useDialogs();

    const [users, setUsers] = useState<SambaUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [view, setView] = useState<View>({ name: "list" });
    const { filter, setFilter, needle, filtered } = useSearch(users, (user, needle) =>
        user.name.toLowerCase().includes(needle) || user.fullName.toLowerCase().includes(needle));

    /* Who is connected right now, polled while the dialog is open. The
       dialog fetches this itself: Dialogs.show() captures props at the
       moment of the click, so anything passed in would go stale. */
    const loadConnections = useCallback(() => client.getConnections(), []);
    const { value: connections } =
        usePolled<Connection[]>(loadConnections, [], true, CONNECTION_POLL_SECONDS);
    /* Failures loading the list; failures inside the password and remove
       views are shown by their DialogFrame. */
    const [error, setError] = useState<string | null>(null);

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

    /* The password and remove views are DialogFrames whose Cancel is
       "Back" and whose close — dismissed or applied — returns to the
       list rather than closing the dialog. */
    const backToList = () => show({ name: "list" });

    /* --- Set or change a password --- */

    if (view.name === "password") {
        const user = view.user;
        const mismatch = confirm.length > 0 && password !== confirm;

        return (
            <DialogFrame id="manage-access-dialog"
                         title={user.hasPassword
                             ? cockpit.format(_("Change Samba password for $0"), user.name)
                             : cockpit.format(_("Set Samba password for $0"), user.name)}
                         description={_("This password is only used to connect to shares. The account's login password is left alone.")}
                         actionLabel={user.hasPassword ? _("Change password") : _("Set password")}
                         isActionDisabled={!password || password !== confirm}
                         cancelLabel={_("Back")}
                         onClose={backToList}
                         onApply={async () => {
                             await client.setPassword(user.name, password);
                             await reload();
                         }}
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
    }

    /* --- Take access away --- */

    if (view.name === "remove") {
        const user = view.user;

        return (
            <DialogFrame id="manage-access-dialog"
                         variant="small"
                         title={cockpit.format(_("Remove Samba access for $0?"), user.name)}
                         titleIconVariant="warning"
                         actionLabel={_("Remove access")}
                         actionVariant="danger"
                         cancelLabel={_("Back")}
                         onClose={backToList}
                         onApply={async () => {
                             await client.removePassword(user.name);
                             await reload();
                         }}>
                <p>
                    {fmt_to_fragments(
                        _("$0 will no longer be able to connect to any share on this server. The account itself, and its ability to log in, are not affected."),
                        <strong>{user.name}</strong>)}
                </p>
            </DialogFrame>
        );
    }

    /* --- The list of accounts --- */

    const columns = [
        { title: _("User"), sortable: true },
        { title: _("Full name"), sortable: true },
        { title: _("Samba access"), sortable: true },
        { title: _("Shares") },
        { title: _("Connected"), sortable: true },
        { title: _("From") },
        { title: _("Connected since") },
        { title: "", props: { screenReaderText: _("Actions") } },
    ];

    /* The three connection cells, shared by account rows and guest rows.
       One person can be connected from several machines at once; the
       row is as old as the oldest of those sessions. */
    const connectionCells = (mine: Connection[]) => {
        const times = mine.map(c => c.connectedAt).filter((d): d is Date => d !== null);
        const earliest = times.length
            ? new Date(Math.min(...times.map(d => d.getTime())))
            : null;
        return [
            {
                title: mine.length > 0
                    ? <Label color="green" isCompact>{_("Yes")}</Label>
                    : <span className="samba-subtle">{_("No")}</span>,
                sortKey: mine.length > 0 ? "1" : "0",
            },
            { title: [...new Set(mine.map(c => c.machine).filter(Boolean))].join(", ") },
            { title: earliest ? timeformat.dateTime(earliest) : "" },
        ];
    };

    const userRows = filtered.map(user => ({
        props: { key: user.name, "data-row-id": user.name },
        columns: [
            { title: user.name, sortKey: user.name, props: { width: 15 as const } },
            { title: user.fullName, sortKey: user.fullName, props: { width: 20 as const } },
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
                    return <ShareLabels shares={names} />;
                })(),
            },
            ...connectionCells(connections.filter(c => c.username === user.name)),
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

    /* Sessions that belong to no listed account: guests (who arrive as
       the guest account, usually nobody) and names this machine does not
       know. They cannot be managed here, but who is on the server and
       from where belongs in this table. */
    const userNames = new Set(users.map(user => user.name));
    const guestRows = connections
            .filter(connection => !userNames.has(connection.username))
            .filter(connection => !needle ||
                (connection.username || _("Guest")).toLowerCase().includes(needle) ||
                connection.machine.toLowerCase().includes(needle))
            .map(connection => ({
                props: { key: "session-" + connection.id, "data-row-id": "session-" + connection.id },
                columns: [
                    {
                        title: <span className="samba-subtle">{connection.username || _("Guest")}</span>,
                        sortKey: connection.username || "guest",
                    },
                    { title: "" },
                    { title: <Label color="grey">{_("Guest")}</Label>, sortKey: "" },
                    { title: "" },
                    ...connectionCells([connection]),
                    { title: null, props: { className: "pf-v6-c-table__action" } },
                ],
            }));

    const rows = [...userRows, ...guestRows];

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
                            <FilterInput id="samba-access-filter"
                                         placeholder={_("Search for a user")}
                                         filter={filter}
                                         setFilter={setFilter} />
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
                                  ? <NoMatchState title={_("No matching user")} onClear={() => setFilter("")} />
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
