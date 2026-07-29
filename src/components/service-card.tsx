/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

import React from "react";

import cockpit from "cockpit";
import { useDialogs } from "dialogs";
import { KebabDropdown } from "cockpit-components-dropdown";
import * as timeformat from "timeformat";

import {
    Card, CardBody, CardExpandableContent, CardHeader, CardTitle,
} from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm,
} from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import { useAlerts } from "./alerts";
import { GlobalSettingsDialog, BackupRestoreDialog } from "../dialogs/config-dialogs";
import { LogsDialog } from "../dialogs/logs-dialog";
import { ManageAccessDialog } from "../dialogs/manage-access-dialog";
import { errorString, type Connection } from "../samba/client";
import type { ServiceState } from "../samba/hooks";
import { readShares, type SambaConf } from "../samba/conf";

const _ = cockpit.gettext;

type LabelColor = "green" | "red" | "grey" | "blue";

function stateLabel(state: ServiceState["state"]): { text: string, color: LabelColor } {
    switch (state) {
    case "running":
        return { text: _("Running"), color: "green" };
    case "failed":
        return { text: _("Failed"), color: "red" };
    case "starting":
        return { text: _("Starting"), color: "blue" };
    case "stopping":
        return { text: _("Stopping"), color: "blue" };
    case "stopped":
        return { text: _("Not running"), color: "grey" };
    default:
        return { text: _("Unknown"), color: "grey" };
    }
}

export interface ServiceCardProps {
    service: ServiceState;
    version: string;
    conf: SambaConf;
    tag: string | null;
    applyConf: (mutate: (conf: SambaConf) => void) => Promise<void>;
    /* Only the count is shown here; the list itself lives in the
       Manage access dialog. */
    connections: Connection[];
    canEdit: boolean;
    isExpanded: boolean;
    setExpanded: (expanded: boolean) => void;
}

export const ServiceCard = ({
    service, version, conf, tag, applyConf,
    connections, canEdit, isExpanded, setExpanded,
}: ServiceCardProps) => {
    const Dialogs = useDialogs();
    const alert = useAlerts();
    const status = stateLabel(service.state);
    const isRunning = service.state === "running";

    /* Report a failed service action, which otherwise leaves the button
       looking as though nothing happened. */
    const attempt = (what: string, action: () => Promise<void>) => async () => {
        try {
            await action();
        } catch (exception) {
            alert({ variant: "danger", title: what, detail: errorString(exception) });
        }
    };

    const actions = [
        <DropdownItem key="access" onClick={() => Dialogs.show(
            <ManageAccessDialog canEdit={canEdit} shares={readShares(conf)} />)}>
            {_("Manage access")}
        </DropdownItem>,
        <DropdownItem key="settings" onClick={() => Dialogs.show(
            <GlobalSettingsDialog conf={conf} applyConf={applyConf} />)}>
            {_("Global settings")}
        </DropdownItem>,
        <DropdownItem key="logs" onClick={() => Dialogs.show(
            <LogsDialog conf={conf} unit={service.unit} applyConf={applyConf} canEdit={canEdit} />)}>
            {_("View logs")}
        </DropdownItem>,
        <DropdownItem key="backup" onClick={() => Dialogs.show(
            <BackupRestoreDialog conf={conf} tag={tag} />)}>
            {_("Back up or restore configuration")}
        </DropdownItem>,
    ];

    /* Everything about the unit itself — start on boot, dependencies,
       the full journal — lives on Cockpit's own Services page, which is
       readable without administrative access too. */
    if (service.unit)
        actions.push(
            <DropdownItem key="manage-service"
                          onClick={() => cockpit.jump("/system/services#/" + service.unit)}>
                {_("Manage service")}
            </DropdownItem>);

    if (canEdit) {
        actions.push(<Divider key="separator" />);
        if (isRunning)
            actions.push(
                <DropdownItem key="restart"
                              onClick={attempt(_("Failed to restart Samba"), service.restart)}>
                    {_("Restart")}
                </DropdownItem>,
                <DropdownItem key="stop" isDanger
                              onClick={attempt(_("Failed to stop Samba"), service.stop)}>
                    {_("Stop")}
                </DropdownItem>);
        else
            actions.push(
                <DropdownItem key="start"
                              onClick={attempt(_("Failed to start Samba"), service.start)}>
                    {_("Start")}
                </DropdownItem>);
    }

    const toolbar = (
        <Toolbar>
            <ToolbarContent>
                <ToolbarItem>
                    <KebabDropdown toggleButtonId="samba-service-actions" dropdownItems={actions} />
                </ToolbarItem>
            </ToolbarContent>
        </Toolbar>
    );

    return (
        <Card className="ct-card" id="samba-service" isExpanded={isExpanded}>
            <CardHeader actions={{ actions: toolbar, hasNoOffset: true }}
                        className="ct-card-expandable-header"
                        onExpand={() => setExpanded(!isExpanded)}
                        toggleButtonProps={{
                            id: "samba-service-toggle",
                            "aria-label": _("Samba server"),
                            "aria-expanded": isExpanded,
                        }}>
                <CardTitle>
                    <Flex spaceItems={{ default: "spaceItemsMd" }}
                          alignItems={{ default: "alignItemsCenter" }}>
                        <Content component={ContentVariants.h2}>{_("Samba server")}</Content>
                        <Label color={status.color} id="samba-service-state">{status.text}</Label>
                        {isRunning && connections.length > 0 && (
                            <Label color="blue">
                                {cockpit.format(cockpit.ngettext("$0 connection", "$0 connections", connections.length),
                                                connections.length)}
                            </Label>
                        )}
                    </Flex>
                </CardTitle>
            </CardHeader>
            <CardExpandableContent>
                <CardBody>
                    <DescriptionList isHorizontal isFluid>
                        {version && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Version")}</DescriptionListTerm>
                                <DescriptionListDescription>{version}</DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                        {service.activeSince && (
                            <DescriptionListGroup>
                                <DescriptionListTerm>{_("Running since")}</DescriptionListTerm>
                                <DescriptionListDescription>
                                    {timeformat.dateTime(service.activeSince)}
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                        )}
                    </DescriptionList>
                </CardBody>
            </CardExpandableContent>
        </Card>
    );
};
