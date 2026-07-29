/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

import React, { useCallback, useEffect, useState } from "react";

import cockpit from "cockpit";
import { EmptyStatePanel } from "cockpit-components-empty-state";
import { install_dialog } from "cockpit-components-install-dialog";

import { Alert, AlertActionLink } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { NetworkIcon } from "@patternfly/react-icons";

import { ServiceCard } from "./components/service-card";
import { SharesCard } from "./components/shares-card";
import { useAlerts } from "./components/alerts";
import * as client from "./samba/client";
import {
    guestAccount, guestLoginsAccepted, parseConf, readShares, serializeConf, type SambaConf,
} from "./samba/conf";
import {
    CONNECTION_POLL_SECONDS,
    useSambaConf, useSambaService, useServerVersion, usePathStatus, usePolled, useSuperuser,
} from "./samba/hooks";

const _ = cockpit.gettext;

export const Application = () => {
    const canEdit = useSuperuser();
    const alert = useAlerts();

    const { conf, tag, error: confError, ready } = useSambaConf();
    const service = useSambaService();
    const version = useServerVersion(service.installed);

    const [installing, setInstalling] = useState(false);
    const [serviceExpanded, setServiceExpanded] = useState(false);

    const isRunning = service.state === "running";

    /* A firewall that blocks SMB leaves every client refused while this
       page looks perfectly healthy, so it is worth an alert of its own. */
    const [firewall, setFirewall] = useState<client.FirewallState>("inactive");
    useEffect(() => {
        if (service.installed)
            client.checkFirewall().then(setFirewall, () => setFirewall("inactive"));
    }, [service.installed]);

    async function openFirewall() {
        try {
            await client.openFirewall();
            setFirewall(await client.checkFirewall());
        } catch (exception) {
            alert({
                variant: "danger",
                title: _("The firewall could not be opened for Samba"),
                detail: client.errorString(exception),
            });
        }
    }

    /* testparm's warnings about the live config — deprecated or unknown
       settings that still load. Re-read whenever the file changes. */
    const [warnings, setWarnings] = useState<string[]>([]);
    useEffect(() => {
        if (service.installed && tag)
            client.configWarnings().then(setWarnings, () => setWarnings([]));
    }, [service.installed, tag]);

    const loadConnections = useCallback(() => client.getConnections(), []);
    const { value: connections, refresh: refreshConnections } =
        usePolled<client.Connection[]>(loadConnections, [], isRunning, CONNECTION_POLL_SECONDS);

    const shares = conf ? readShares(conf) : [];
    const { status: pathStatus, refresh: refreshPaths } = usePathStatus(shares.map(s => s.path));

    /* Every configuration change goes through here: it starts from the
     * config as it is right now, applies the caller's edit to a private
     * copy, and writes it back with the tag we last saw so that a change
     * made elsewhere in the meantime is refused rather than overwritten.
     * The file watch then delivers the new content back to the page. */
    const applyConf = useCallback(async (mutate: (conf: SambaConf) => void) => {
        if (!conf)
            throw new Error(_("The Samba configuration has not been read yet."));

        /* Re-parsing the serialized form is a cheap deep copy, and keeps
           React state from being mutated in place. */
        const copy = parseConf(serializeConf(conf));
        mutate(copy);
        await client.writeConf(copy, tag ?? undefined);
    }, [conf, tag]);

    async function install() {
        setInstalling(true);
        try {
            await install_dialog("samba");
            /* The page derives everything from the service unit, which
               only exists now, so start over from a clean slate. */
            window.location.reload();
        } catch {
            /* The dialog was cancelled, or PackageKit is unavailable. */
        } finally {
            setInstalling(false);
        }
    }

    if (service.installed === null || !ready)
        return <EmptyStatePanel loading />;

    if (service.installed === false)
        return (
            <EmptyStatePanel icon={NetworkIcon}
                             title={_("Samba is not installed")}
                             paragraph={_("Samba shares folders on this machine with Windows, macOS and Linux computers on the network.")}
                             action={canEdit ? _("Install Samba") : undefined}
                             isActionInProgress={installing}
                             onAction={install} />
        );

    return (
        <Page id="samba" className="pf-m-no-sidebar">
            <PageSection hasBodyWrapper={false}>
                <Stack hasGutter>
                    {confError && (
                        <Alert isInline variant="danger" title={_("The Samba configuration could not be read")}>
                            {confError}
                        </Alert>
                    )}
                    {!canEdit && (
                        <Alert isInline variant="info" title={_("Administrative access is required to change these settings")} />
                    )}
                    {firewall === "blocked" && (
                        <Alert isInline variant="warning" id="samba-firewall-alert"
                               title={_("The firewall is blocking file sharing")}
                               actionLinks={canEdit
                                   ? (
                                       <AlertActionLink onClick={openFirewall}>
                                           {_("Open the firewall for Samba")}
                                       </AlertActionLink>
                                   )
                                   : undefined}>
                            {_("firewalld is running and does not allow the samba service, so clients cannot reach the shares from other machines.")}
                        </Alert>
                    )}
                    {warnings.length > 0 && (
                        <Alert isInline variant="warning" id="samba-config-warnings"
                               title={_("Samba has warnings about the configuration")}>
                            {warnings.map(line => <div key={line}><code>{line}</code></div>)}
                        </Alert>
                    )}

                    {conf && (
                        <ServiceCard service={service}
                                     version={version}
                                     conf={conf}
                                     tag={tag}
                                     applyConf={applyConf}
                                     connections={connections}
                                     canEdit={canEdit}
                                     isExpanded={serviceExpanded}
                                     setExpanded={setServiceExpanded} />
                    )}

                    <SharesCard shares={shares}
                                pathStatus={pathStatus}
                                connections={connections}
                                guestLoginsAllowed={conf ? guestLoginsAccepted(conf) : true}
                                guestAccount={conf ? guestAccount(conf) : "nobody"}
                                applyConf={applyConf}
                                onPathsChanged={() => { refreshPaths(); refreshConnections() }}
                                canEdit={canEdit} />
                </Stack>
            </PageSection>
        </Page>
    );
};
