/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

import React, { useState } from "react";

import cockpit from "cockpit";
import { useDialogs } from "dialogs";
import { KebabDropdown } from "cockpit-components-dropdown";
import { ListingTable } from "cockpit-components-table";
import { EmptyStatePanel } from "cockpit-components-empty-state";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Icon } from "@patternfly/react-core/dist/esm/components/Icon/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { ExclamationCircleIcon, ExclamationTriangleIcon, FolderIcon, SearchIcon } from "@patternfly/react-icons";
import { SortByDirection } from "@patternfly/react-table";

import { ShareDialog } from "../dialogs/share-dialog";
import {
    CreateDirectoryDialog, DeleteShareDialog, FixPermissionsDialog, FixSELinuxDialog,
    PROBLEM_SUMMARY, shareProblem,
} from "../dialogs/share-actions";
import { ShareDetailsDialog } from "../dialogs/share-details-dialog";
import type { Connection } from "../samba/client";
import type { PathStatus } from "../samba/hooks";
import { sharePrincipals, type SambaConf, type Share } from "../samba/conf";

const _ = cockpit.gettext;

const ShareActions = ({
    share, shares, status, inUse, guestLoginsAllowed, guestAccount, applyConf, onPathsChanged, canEdit,
}: {
    share: Share;
    shares: Share[];
    status: PathStatus | undefined;
    inUse: number;
    guestLoginsAllowed: boolean;
    guestAccount: string;
    applyConf: (mutate: (conf: SambaConf) => void) => Promise<void>;
    onPathsChanged: () => void;
    canEdit: boolean;
}) => {
    const Dialogs = useDialogs();
    const problem = shareProblem(share, status);

    /* Reading is for everyone; only changing anything needs admin. */
    const items = [
        <DropdownItem key="details"
                      onClick={() => Dialogs.show(
                          <ShareDetailsDialog share={share} status={status} inUse={inUse}
                                              guestLoginsAllowed={guestLoginsAllowed}
                                              guestAccount={guestAccount} />)}>
            {_("View details")}
        </DropdownItem>,
    ];

    if (canEdit) {
        items.push(
            <DropdownItem key="edit"
                          onClick={() => Dialogs.show(
                              <ShareDialog share={share} shares={shares}
                                           guestLoginsAllowed={guestLoginsAllowed}
                                           guestAccount={guestAccount}
                                           applyConf={applyConf}
                                           onPathsChanged={onPathsChanged} />)}>
                {_("Edit share")}
            </DropdownItem>);

        /* The fix for the folder problem the table flags, so it is
           reachable next to the share rather than only from a dialog.
           not-a-directory has no one-click fix — the share has to point
           somewhere else — so only these two get an item. */
        if (problem === "missing")
            items.push(
                <DropdownItem key="createfolder"
                              onClick={() => Dialogs.show(
                                  <CreateDirectoryDialog share={share} onDone={onPathsChanged} />)}>
                    {_("Create folder")}
                </DropdownItem>);
        if (problem === "selinux")
            items.push(
                <DropdownItem key="fixselinux"
                              onClick={() => Dialogs.show(
                                  <FixSELinuxDialog share={share} onDone={onPathsChanged} />)}>
                    {_("Allow Samba to use the folder")}
                </DropdownItem>);

        /* Only worth offering where there is a folder to fix and accounts
           to grant it to. */
        if (!share.isSpecial && share.path && sharePrincipals(share).length > 0)
            items.push(
                <DropdownItem key="permissions"
                              onClick={() => Dialogs.show(
                                  <FixPermissionsDialog share={share} onDone={onPathsChanged} />)}>
                    {_("Fix folder permissions")}
                </DropdownItem>);

        items.push(
            <Divider key="separator" />,
            <DropdownItem key="delete" isDanger
                          onClick={() => Dialogs.show(
                              <DeleteShareDialog share={share} applyConf={applyConf} />)}>
                {_("Delete share")}
            </DropdownItem>);
    }

    return <KebabDropdown dropdownItems={items} />;
};

export interface SharesCardProps {
    shares: Share[];
    pathStatus: Record<string, PathStatus>;
    connections: Connection[];
    guestLoginsAllowed: boolean;
    /* The account guests connect as; `valid users` gates it like anyone
       else, which is worth an alert when a share trips over it. */
    guestAccount: string;
    applyConf: (mutate: (conf: SambaConf) => void) => Promise<void>;
    onPathsChanged: () => void;
    canEdit: boolean;
}

export const SharesCard = ({
    shares, pathStatus, connections, guestLoginsAllowed, guestAccount,
    applyConf, onPathsChanged, canEdit,
}: SharesCardProps) => {
    const Dialogs = useDialogs();
    const [filter, setFilter] = useState("");

    const needle = filter.trim().toLowerCase();
    const filtered = shares.filter(share =>
        !needle ||
        share.name.toLowerCase().includes(needle) ||
        share.comment.toLowerCase().includes(needle) ||
        share.path.toLowerCase().includes(needle));

    const columns = [
        { title: _("Name"), sortable: true },
        { title: _("Folder"), sortable: true },
        { title: _("Access") },
        { title: _("Description") },
        { title: "", props: { screenReaderText: _("Actions") } },
    ];

    const rows = filtered.map(share => {
        const problem = shareProblem(share, pathStatus[share.path]);
        const inUse = connections.filter(c => c.shares.includes(share.name)).length;

        const folder = (
            <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
                {share.path
                    ? <code>{share.path}</code>
                    : <span className="samba-subtle">{_("Managed by Samba")}</span>}
                {problem && (
                    <Tooltip content={PROBLEM_SUMMARY[problem]()}>
                        <Icon status={problem === "selinux" ? "warning" : "danger"}
                              aria-label={PROBLEM_SUMMARY[problem]()}>
                            {problem === "selinux" ? <ExclamationTriangleIcon /> : <ExclamationCircleIcon />}
                        </Icon>
                    </Tooltip>
                )}
            </Flex>
        );

        const access = (
            <Flex spaceItems={{ default: "spaceItemsSm" }}>
                {!share.available && <Label color="red" isCompact>{_("Off")}</Label>}
                <Label color={share.readOnly ? "orange" : "blue"} isCompact>
                    {share.readOnly ? _("Read only") : _("Read and write")}
                </Label>
                {share.guestOk && <Label color="orange" isCompact>{_("Guests")}</Label>}
                {!share.browseable && <Label color="grey" isCompact>{_("Hidden")}</Label>}
                {share.isSpecial && <Label color="purple" isCompact>{_("Special")}</Label>}
                {share.timeMachine && <Label color="teal" isCompact>{_("Time Machine")}</Label>}
                {share.recycleBin && <Label color="teal" isCompact>{_("Recycle bin")}</Label>}
            </Flex>
        );

        return {
            props: { key: share.name, "data-row-id": share.name },
            columns: [
                { title: share.name, sortKey: share.name, props: { width: 20 as const } },
                { title: folder, sortKey: share.path, props: { width: 30 as const } },
                { title: access },
                { title: share.comment, props: { width: 20 as const } },
                {
                    title: (
                        <ShareActions share={share} shares={shares}
                                      status={pathStatus[share.path]}
                                      inUse={inUse}
                                      guestLoginsAllowed={guestLoginsAllowed}
                                      guestAccount={guestAccount}
                                      applyConf={applyConf}
                                      onPathsChanged={onPathsChanged}
                                      canEdit={canEdit} />
                    ),
                    props: { className: "pf-v6-c-table__action" },
                },
            ],
        };
    });

    const toolbar = (
        <Toolbar>
            <ToolbarContent>
                <ToolbarItem>
                    <SearchInput id="samba-shares-filter"
                                 placeholder={_("Search for a share")}
                                 value={filter}
                                 onChange={(_event, value) => setFilter(value)}
                                 onClear={() => setFilter("")} />
                </ToolbarItem>
                {canEdit && (
                    <>
                        <ToolbarItem variant="separator" />
                        <ToolbarItem align={{ md: "alignEnd" }}>
                            <Button id="samba-share-create"
                                    onClick={() => Dialogs.show(
                                        <ShareDialog share={null} shares={shares}
                                                     guestLoginsAllowed={guestLoginsAllowed}
                                                     guestAccount={guestAccount}
                                                     applyConf={applyConf}
                                                     onPathsChanged={onPathsChanged} />)}>
                                {_("Create share")}
                            </Button>
                        </ToolbarItem>
                    </>
                )}
            </ToolbarContent>
        </Toolbar>
    );

    return (
        <Card className="ct-card" id="samba-shares" isPlain>
            <CardHeader actions={{ actions: toolbar }}>
                <CardTitle component="h2">{_("Shares")}</CardTitle>
            </CardHeader>
            <ListingTable id="samba-shares-list"
                          aria-label={_("Shares")}
                          variant="compact"
                          columns={columns}
                          rows={rows}
                          sortBy={{ index: 0, direction: SortByDirection.asc }}
                          isEmptyStateInTable={needle !== "" && filtered.length !== shares.length}
                          emptyComponent={needle
                              ? (
                                  <EmptyStatePanel title={_("No matching share")}
                                                   icon={SearchIcon}
                                                   action={_("Clear filter")}
                                                   actionVariant="link"
                                                   onAction={() => setFilter("")} />
                              )
                              : (
                                  <EmptyStatePanel title={_("No shares yet")}
                                                   icon={FolderIcon}
                                                   paragraph={_("A share makes a folder on this machine available to other computers on the network.")}
                                                   {...canEdit && {
                                                       action: _("Create share"),
                                                       onAction: () => Dialogs.show(
                                                           <ShareDialog share={null} shares={shares}
                                                                        guestLoginsAllowed={guestLoginsAllowed}
                                                                        guestAccount={guestAccount}
                                                                        applyConf={applyConf}
                                                                        onPathsChanged={onPathsChanged} />),
                                                   }} />
                              )} />
        </Card>
    );
};
