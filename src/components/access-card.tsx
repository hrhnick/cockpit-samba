/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from "react";

import cockpit from "cockpit";
import { useDialogs } from "dialogs";
import { KebabDropdown } from "cockpit-components-dropdown";
import { ListingTable } from "cockpit-components-table";
import { EmptyStatePanel } from "cockpit-components-empty-state";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import {
    Card, CardExpandableContent, CardHeader, CardTitle,
} from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { SearchIcon } from "@patternfly/react-icons";
import { SortByDirection } from "@patternfly/react-table";

import { RemoveAccessDialog, SetPasswordDialog } from "../dialogs/access-dialogs";
import type { SambaUser } from "../samba/client";

const _ = cockpit.gettext;

const UserActions = ({ user, onChanged }: { user: SambaUser, onChanged: () => void }) => {
    const Dialogs = useDialogs();

    const items = [
        <DropdownItem key="password"
                      onClick={() => Dialogs.show(<SetPasswordDialog user={user} onDone={onChanged} />)}>
            {user.hasPassword ? _("Change Samba password") : _("Set Samba password")}
        </DropdownItem>,
    ];

    if (user.hasPassword)
        items.push(
            <DropdownItem key="remove" isDanger
                          onClick={() => Dialogs.show(<RemoveAccessDialog user={user} onDone={onChanged} />)}>
                {_("Remove Samba access")}
            </DropdownItem>);

    return <KebabDropdown dropdownItems={items} />;
};

export interface AccessCardProps {
    users: SambaUser[];
    isLoading: boolean;
    reload: () => void;
    canEdit: boolean;
    isExpanded: boolean;
    setExpanded: (expanded: boolean) => void;
}

/* Which accounts can connect to the shares.
 *
 * Samba authenticates against its own password database rather than the
 * system one, so an account that exists on the machine still cannot use a
 * share until it is given a Samba password. This card is where that
 * happens; creating and deleting the accounts themselves stays in the
 * Accounts page, which is linked from here.
 */
export const AccessCard = ({
    users, isLoading, reload, canEdit, isExpanded, setExpanded,
}: AccessCardProps) => {
    const [filter, setFilter] = useState("");

    const withAccess = users.filter(user => user.hasPassword);
    const needle = filter.trim().toLowerCase();
    const filtered = users.filter(user =>
        !needle || user.name.toLowerCase().includes(needle) || user.fullName.toLowerCase().includes(needle));

    const columns = [
        { title: _("User"), sortable: true },
        { title: _("Full name"), sortable: true },
        { title: _("Samba access"), sortable: true },
        { title: "", props: { screenReaderText: _("Actions") } },
    ];

    const rows = filtered.map(user => ({
        props: { key: user.name, "data-row-id": user.name },
        columns: [
            { title: user.name, sortKey: user.name, props: { width: 25 as const } },
            { title: user.fullName, sortKey: user.fullName, props: { width: 30 as const } },
            {
                title: user.hasPassword
                    ? <Label color="green">{_("Allowed")}</Label>
                    : <Label color="grey">{_("No access")}</Label>,
                sortKey: user.hasPassword ? "1" : "0",
            },
            {
                title: canEdit ? <UserActions user={user} onChanged={reload} /> : null,
                props: { className: "pf-v6-c-table__action" },
            },
        ],
    }));

    const toolbar = (
        <Toolbar>
            <ToolbarContent>
                {isExpanded && (
                    <ToolbarItem>
                        <SearchInput id="samba-access-filter"
                                     placeholder={_("Search for a user")}
                                     value={filter}
                                     onChange={(_event, value) => setFilter(value)}
                                     onClear={() => setFilter("")} />
                    </ToolbarItem>
                )}
                {isExpanded && <ToolbarItem variant="separator" />}
                <ToolbarItem align={{ md: "alignEnd" }}>
                    <Button variant="secondary" onClick={() => cockpit.jump("/users")}>
                        {_("Manage accounts")}
                    </Button>
                </ToolbarItem>
            </ToolbarContent>
        </Toolbar>
    );

    return (
        <Card className="ct-card" id="samba-access" isExpanded={isExpanded}>
            <CardHeader actions={{ actions: toolbar, hasNoOffset: true }}
                        className="ct-card-expandable-header"
                        onExpand={() => setExpanded(!isExpanded)}
                        toggleButtonProps={{
                            id: "samba-access-toggle",
                            "aria-label": _("Samba access"),
                            "aria-expanded": isExpanded,
                        }}>
                <CardTitle className="pf-v6-l-flex pf-m-align-items-center pf-m-space-items-md">
                    <Content component={ContentVariants.h2}>{_("Samba access")}</Content>
                    {!isExpanded && isLoading && (
                        <HelperText>
                            <HelperTextItem variant="indeterminate">{_("Loading…")}</HelperTextItem>
                        </HelperText>
                    )}
                    {!isExpanded && !isLoading && (
                        withAccess.length === 0
                            ? (
                                <HelperText>
                                    <HelperTextItem variant="indeterminate">
                                        {_("No user can connect yet")}
                                    </HelperTextItem>
                                </HelperText>
                            )
                            : (
                                <>
                                    {withAccess.slice(0, 3).map(user => (
                                        <Label key={user.name} color="green">{user.name}</Label>
                                    ))}
                                    {withAccess.length > 3 && (
                                        <Button variant="link" isInline onClick={() => setExpanded(true)}>
                                            {cockpit.format(_("$0 more…"), withAccess.length - 3)}
                                        </Button>
                                    )}
                                </>
                            )
                    )}
                </CardTitle>
            </CardHeader>
            <CardExpandableContent>
                <ListingTable id="samba-users"
                              aria-label={_("Samba access")}
                              variant="compact"
                              columns={columns}
                              rows={rows}
                              sortBy={{ index: 0, direction: SortByDirection.asc }}
                              loading={isLoading ? _("Loading…") : ""}
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
            </CardExpandableContent>
        </Card>
    );
};
