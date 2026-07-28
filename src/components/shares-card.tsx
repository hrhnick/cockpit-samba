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
import { fmt_to_fragments } from "utils";

import { Alert, AlertActionLink } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { ClipboardCopy } from "@patternfly/react-core/dist/esm/components/ClipboardCopy/index.js";
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm,
} from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Icon } from "@patternfly/react-core/dist/esm/components/Icon/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { ExclamationCircleIcon, ExclamationTriangleIcon, FolderIcon, SearchIcon } from "@patternfly/react-icons";
import { SortByDirection } from "@patternfly/react-table";

import { ShareDialog } from "../dialogs/share-dialog";
import {
    CreateDirectoryDialog, DeleteShareDialog, FixPermissionsDialog, FixSELinuxDialog,
    sharePrincipals,
} from "../dialogs/share-actions";
import type { Connection } from "../samba/client";
import type { PathStatus } from "../samba/hooks";
import type { SambaConf, Share } from "../samba/conf";

const _ = cockpit.gettext;

/* The address a client types to reach the share. Cockpit may be managing a
   different machine than the one serving the page, in which case the
   transport knows its name. */
function serverAddress(): string {
    const host = cockpit.transport.host;
    return !host || host === "localhost" ? window.location.hostname : host;
}

type Problem = "missing" | "not-a-directory" | "selinux" | null;

function shareProblem(share: Share, status: PathStatus | undefined): Problem {
    if (share.isSpecial || !share.path || !status)
        return null;
    if (status.state === "missing")
        return "missing";
    if (status.state === "not-a-directory")
        return "not-a-directory";
    if (!status.selinuxOk)
        return "selinux";
    return null;
}

const PROBLEM_SUMMARY: Record<Exclude<Problem, null>, () => string> = {
    missing: () => _("The folder does not exist"),
    "not-a-directory": () => _("The path is not a folder"),
    selinux: () => _("SELinux is blocking access to the folder"),
};

/* The banner shown inside an expanded row when the share cannot work as
   configured, with the fix next to the explanation. */
const ProblemAlert = ({ share, problem, canEdit, onFixed }: {
    share: Share;
    problem: Exclude<Problem, null>;
    canEdit: boolean;
    onFixed: () => void;
}) => {
    const Dialogs = useDialogs();

    if (problem === "not-a-directory")
        return (
            <Alert isInline variant="danger" title={PROBLEM_SUMMARY[problem]()}>
                {cockpit.format(_("$0 exists but is a file, so it cannot be shared. Point the share at a folder instead."),
                                share.path)}
            </Alert>
        );

    const isMissing = problem === "missing";
    return (
        <Alert isInline
               variant={isMissing ? "danger" : "warning"}
               title={PROBLEM_SUMMARY[problem]()}
               actionLinks={canEdit
                   ? (
                       <AlertActionLink onClick={() => Dialogs.show(isMissing
                           ? <CreateDirectoryDialog share={share} onDone={onFixed} />
                           : <FixSELinuxDialog share={share} onDone={onFixed} />)}>
                           {isMissing ? _("Create folder") : _("Fix it")}
                       </AlertActionLink>
                   )
                   : undefined}>
            {isMissing
                ? cockpit.format(_("Clients connecting to this share get an error until $0 exists."), share.path)
                : cockpit.format(_("Samba is not allowed to read $0, so clients get a permission error."), share.path)}
        </Alert>
    );
};

const ShareActions = ({ share, shares, guestLoginsAllowed, guestAccount, applyConf, onPathsChanged }: {
    share: Share;
    shares: Share[];
    guestLoginsAllowed: boolean;
    guestAccount: string;
    applyConf: (mutate: (conf: SambaConf) => void) => Promise<void>;
    onPathsChanged: () => void;
}) => {
    const Dialogs = useDialogs();

    const items = [
        <DropdownItem key="edit"
                      onClick={() => Dialogs.show(
                          <ShareDialog share={share} shares={shares}
                                       guestLoginsAllowed={guestLoginsAllowed}
                                       guestAccount={guestAccount}
                                       applyConf={applyConf}
                                       onPathsChanged={onPathsChanged} />)}>
            {_("Edit share")}
        </DropdownItem>,
    ];

    /* Only worth offering where there is a folder to fix and accounts to
       grant it to. */
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

    return <KebabDropdown dropdownItems={items} />;
};

/* A list of users or groups as the chips the Accounts page uses. */
const PrincipalLabels = ({ principals }: { principals: string[] }) => (
    <Flex spaceItems={{ default: "spaceItemsSm" }}>
        {principals.map(name => (
            <Label key={name} color={name.startsWith("@") ? "yellow" : "blue"} isCompact>
                {name}
            </Label>
        ))}
    </Flex>
);

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

        const disk = pathStatus[share.path]?.disk;

        return {
            props: { key: share.name, "data-row-id": share.name },
            columns: [
                { title: share.name, sortKey: share.name, props: { width: 20 as const } },
                { title: folder, sortKey: share.path, props: { width: 30 as const } },
                { title: access },
                { title: share.comment, props: { width: 20 as const } },
                {
                    title: canEdit
                        ? (
                            <ShareActions share={share} shares={shares}
                                          guestLoginsAllowed={guestLoginsAllowed}
                                          guestAccount={guestAccount}
                                          applyConf={applyConf}
                                          onPathsChanged={onPathsChanged} />
                        )
                        : null,
                    props: { className: "pf-v6-c-table__action" },
                },
            ],
            expandedContent: (
                <Stack hasGutter>
                    {problem && (
                        <ProblemAlert share={share} problem={problem} canEdit={canEdit}
                                      onFixed={onPathsChanged} />
                    )}
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
                    {share.guestOk && guestLoginsAllowed && share.validUsers.length > 0 &&
                        !share.validUsers.includes(guestAccount) && (
                        <Alert isInline variant="warning" title={_("Guests are allowed but the user list keeps them out")}>
                            {cockpit.format(
                                _("Guests connect as the $0 account, and \"Who can connect\" does not include it. Edit the share and add $0, or clear the list."),
                                guestAccount)}
                        </Alert>
                    )}
                    <DescriptionList isHorizontal isCompact>
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
            ),
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
