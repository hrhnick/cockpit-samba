/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useEffect, useState } from "react";

import cockpit from "cockpit";
import { useInit, useObject, useEvent } from "hooks";
import * as service from "service";
import { superuser } from "superuser";

import { parseConf, type SambaConf } from "./conf";
import * as client from "./client";

export interface ConfState {
    conf: SambaConf | null;
    /* cockpit's file tag for what we last read, passed back on write so a
       concurrent edit fails loudly instead of being overwritten. */
    tag: string | null;
    error: string | null;
    ready: boolean;
}

/* Follow smb.conf. The page never has to re-read it by hand: an edit
   made here, by another Cockpit session, or in a text editor on the
   machine all arrive through the same watch. */
export function useSambaConf(): ConfState {
    const [state, setState] = useState<ConfState>({ conf: null, tag: null, error: null, ready: false });

    useInit(() => {
        const handle = client.confFile();
        const watch = handle.watch((content, tag, error) => {
            if (error)
                setState({ conf: null, tag: null, error: error.message || error.problem, ready: true });
            else
                setState({ conf: parseConf(content ?? ""), tag, error: null, ready: true });
        });
        return { handle, watch };
    }, [], undefined, handles => {
        handles.watch.remove();
        handles.handle.close();
    });

    return state;
}

/* pkg/lib/service.js is untyped JavaScript; this is its contract as far
   as this page uses it. See the comment block at the top of that file. */
interface ServiceProxy extends cockpit.EventSource<{ changed(): void }> {
    exists: boolean | null;
    state?: "starting" | "running" | "stopping" | "stopped" | "failed";
    enabled?: boolean;
    /* The raw org.freedesktop.systemd1.Unit proxy. */
    unit?: { ActiveEnterTimestamp?: number };
    start(): Promise<void>;
    stop(): Promise<void>;
    restart(): Promise<void>;
    enable(): Promise<void>;
    disable(): Promise<void>;
}

export interface ServiceState {
    /* null while still being detected, or when Samba is not installed. */
    unit: string | null;
    /* undefined while unknown; see service.proxy in pkg/lib. */
    state: "starting" | "running" | "stopping" | "stopped" | "failed" | undefined;
    enabled: boolean | undefined;
    /* When the unit entered the active state, or null if it is not
       running or systemd has not told us yet. */
    activeSince: Date | null;
    /* False only once we know neither unit name exists. */
    installed: boolean | null;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
    setEnabled: (enabled: boolean) => Promise<void>;
}

/* The smbd unit, live over systemd's D-Bus API rather than by polling
   `systemctl is-active`. */
export function useSambaService(): ServiceState {
    /* Both candidate unit names get a proxy; whichever exists wins.
       Creating a proxy for a unit that does not exist is harmless. */
    const proxies = useObject<ServiceProxy[], []>(
        () => client.SERVICE_UNITS.map(unit => service.proxy(unit) as unknown as ServiceProxy),
        null,
        []);

    useEvent(proxies[0], "changed");
    useEvent(proxies[1], "changed");

    const active = proxies.find(p => p.exists);
    /* exists starts out null and becomes a boolean once known. */
    const known = proxies.every(p => p.exists !== null);
    const installed = active ? true : (known ? false : null);

    const call = useCallback(async (method: "start" | "stop" | "restart") => {
        if (active)
            await active[method]();
    }, [active]);

    /* systemd reports the timestamp in microseconds, and uses 0 for
       "never". */
    const startedAt = active?.unit?.ActiveEnterTimestamp;
    const activeSince = active?.state === "running" && startedAt
        ? new Date(startedAt / 1000)
        : null;

    return {
        unit: active ? client.SERVICE_UNITS[proxies.indexOf(active)] : null,
        state: active?.state,
        enabled: active?.enabled,
        activeSince,
        installed,
        start: () => call("start"),
        stop: () => call("stop"),
        restart: () => call("restart"),
        setEnabled: async (enabled: boolean) => {
            if (active)
                await (enabled ? active.enable() : active.disable());
        },
    };
}

/* The WS-Discovery responder, which is what makes this server appear in
   Windows' Network view. Same two-candidate-unit pattern as the Samba
   service itself: whichever of wsdd and wsdd2 exists wins. */
export interface DiscoveryState {
    unit: string | null;
    running: boolean;
    /* False only once we know neither unit exists. */
    installed: boolean | null;
}

export function useDiscoveryService(): DiscoveryState {
    const proxies = useObject<ServiceProxy[], []>(
        () => client.DISCOVERY_UNITS.map(unit => service.proxy(unit) as unknown as ServiceProxy),
        null,
        []);

    useEvent(proxies[0], "changed");
    useEvent(proxies[1], "changed");

    const active = proxies.find(p => p.exists);
    const known = proxies.every(p => p.exists !== null);

    return {
        unit: active ? client.DISCOVERY_UNITS[proxies.indexOf(active)] : null,
        running: active?.state === "running",
        installed: active ? true : (known ? false : null),
    };
}

/* Whether anyone can see the page. cockpit.hidden covers both a
   background browser tab and the Cockpit shell showing another page,
   neither of which the document's own visibility API reports on its
   own. */
function usePageVisible(): boolean {
    const [visible, setVisible] = useState(!cockpit.hidden);

    useEffect(() => {
        const update = () => setVisible(!cockpit.hidden);
        cockpit.addEventListener("visibilitychange", update);
        /* In case it changed between the first render and here. */
        update();
        return () => cockpit.removeEventListener("visibilitychange", update);
    }, []);

    return visible;
}

/* Read a value that has no change notification, with a manual refresh and
 * optional polling. Used for smbstatus, which has to be re-run to see
 * clients coming and going.
 *
 * Polling stops while the page is in a background tab or the Cockpit
 * shell is showing something else: nobody is watching the answer, and
 * running smbstatus every few seconds forever is not free on the small
 * machines this tends to run on.
 */
export function usePolled<T>(load: () => Promise<T>, initial: T,
    enabled: boolean, intervalSeconds = 0): {
    value: T, refresh: () => Promise<void>, refreshing: boolean
} {
    const [value, setValue] = useState<T>(initial);
    const [refreshing, setRefreshing] = useState(false);

    const visible = usePageVisible();
    const active = enabled && visible;

    const refresh = useCallback(async () => {
        if (!enabled) {
            setValue(initial);
            return;
        }
        setRefreshing(true);
        try {
            setValue(await load());
        } finally {
            setRefreshing(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, load]);

    useInit(() => {
        if (!active) {
            /* Being hidden is not the same as having nothing to show:
               keep the last reading, and only clear it when whatever
               produced it has actually stopped. */
            if (!enabled)
                setValue(initial);
            return null;
        }

        refresh();
        return intervalSeconds ? window.setInterval(refresh, intervalSeconds * 1000) : null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, enabled, refresh, intervalSeconds], undefined,
            timer => { if (timer !== null) window.clearInterval(timer); });

    return { value, refresh, refreshing };
}

/* Samba's version string, read once. */
export function useServerVersion(installed: boolean | null): string {
    const [version, setVersion] = useState("");

    useEffect(() => {
        if (installed)
            client.serverVersion().then(setVersion, () => setVersion(""));
    }, [installed]);

    return version;
}

/* Whether each share's directory exists and carries an SELinux label
   that lets Samba serve it. Recomputed whenever the set of paths
   changes, and on demand after a fix is applied. */
export interface PathStatus {
    state: client.PathState;
    selinuxOk: boolean;
    /* Room left on the filesystem holding the share, or null when it
       could not be read. */
    disk: client.DiskUsage | null;
}

export function usePathStatus(paths: string[]): {
    status: Record<string, PathStatus>, refresh: () => Promise<void>
} {
    /* Deduplicated: two shares can point at one folder, and the checks
       cost a process each. A stable key, so re-rendering with an equal
       array does not re-run them. */
    const unique = [...new Set(paths.filter(Boolean))];
    const key = unique.join("\n");

    const load = useCallback(async () => {
        const entries = await Promise.all(unique.map(async path => {
            const state = await client.checkPath(path);
            if (state !== "ok")
                return [path, { state, selinuxOk: true, disk: null }] as const;

            const [selinuxOk, disk] = await Promise.all([
                client.checkSELinuxContext(path),
                client.diskUsage(path),
            ]);
            return [path, { state, selinuxOk, disk }] as const;
        }));
        return Object.fromEntries(entries);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    const { value, refresh } = usePolled<Record<string, PathStatus>>(load, {}, true);
    return { status: value, refresh };
}

/* True when this session is allowed to change anything. The page shows a
   read-only view otherwise, rather than buttons that fail when pressed. */
export function useSuperuser(): boolean {
    useEvent(superuser, "changed");
    return superuser.allowed === true;
}
