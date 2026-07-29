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

/* How often to re-run smbstatus where connections are shown. They come
   and go without any notification we could subscribe to, so polling is
   the only way to keep the answer current. */
export const CONNECTION_POLL_SECONDS = 15;

/* pkg/lib/service.js is untyped JavaScript; this is its contract as far
   as this page uses it. See the comment block at the top of that file. */
interface ServiceProxy extends cockpit.EventSource<{ changed(): void }> {
    exists: boolean | null;
    state?: "starting" | "running" | "stopping" | "stopped" | "failed";
    /* The raw org.freedesktop.systemd1.Unit proxy. Id is the canonical
       unit name, which differs from the name asked for when that name
       is an alias. */
    unit?: { Id?: string, ActiveEnterTimestamp?: number };
    start(): Promise<void>;
    stop(): Promise<void>;
    restart(): Promise<void>;
}

export interface ServiceState {
    /* null while still being detected, or when Samba is not installed. */
    unit: string | null;
    /* undefined while unknown; see service.proxy in pkg/lib. */
    state: "starting" | "running" | "stopping" | "stopped" | "failed" | undefined;
    /* When the unit entered the active state, or null if it is not
       running or systemd has not told us yet. */
    activeSince: Date | null;
    /* False only once we know neither unit name exists. */
    installed: boolean | null;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
}

/* Whichever of several candidate unit names this machine actually has.
 *
 * Distributions disagree about naming — smb against smbd, wsdd against
 * wsdd2 — and asking systemd for a unit that does not exist is harmless,
 * so every candidate gets a proxy and the one that turns out to exist
 * wins. Subscribing in a loop rather than naming each proxy keeps the
 * number of candidates out of the hook: a third spelling would otherwise
 * be watched by nobody, and the page would simply never notice it.
 */
function useUnitProxy(units: string[]): {
    proxy: ServiceProxy | undefined, unit: string | null, installed: boolean | null
} {
    const proxies = useObject<ServiceProxy[], []>(
        () => units.map(unit => service.proxy(unit) as unknown as ServiceProxy),
        null,
        []);

    const [, rerender] = useState(0);
    useEffect(() => {
        const changed = () => rerender(n => n + 1);
        proxies.forEach(p => p.addEventListener("changed", changed));
        return () => proxies.forEach(p => p.removeEventListener("changed", changed));
    }, [proxies]);

    /* Prefer the proxy whose canonical name is the one it was asked
       for. Debian's smbd.service carries `Alias=smb.service`, so once
       the service is enabled a unit named smb.service exists too — and
       systemd resolves the alias for state and jobs, so everything
       *looks* right, but anything that needs the real unit name (the
       Services page, enable/disable) breaks against the alias. */
    const canonical = proxies.find((p, i) => p.exists && p.unit?.Id === units[i]);
    const proxy = canonical ?? proxies.find(p => p.exists);
    /* exists starts out null and becomes a boolean once known. */
    const known = proxies.every(p => p.exists !== null);

    return {
        proxy,
        unit: proxy ? units[proxies.indexOf(proxy)] : null,
        installed: proxy ? true : (known ? false : null),
    };
}

/* The smbd unit, live over systemd's D-Bus API rather than by polling
   `systemctl is-active`. */
export function useSambaService(): ServiceState {
    const { proxy: active, unit, installed } = useUnitProxy(client.SERVICE_UNITS);

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
        unit,
        state: active?.state,
        activeSince,
        installed,
        start: () => call("start"),
        stop: () => call("stop"),
        restart: () => call("restart"),
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
    /* Deduplicated: two shares can point at one folder. A stable key, so
       re-rendering with an equal array does not re-run the checks. */
    const unique = [...new Set(paths.filter(Boolean))];
    const key = unique.join("\n");

    const load = useCallback(async () => {
        /* checkPath is a bridge channel, not a process, so per-path is
           fine; the SELinux and disk checks each cost a process and take
           every path in one run rather than one process per path. */
        const states = await Promise.all(unique.map(path => client.checkPath(path)));
        const okPaths = unique.filter((_path, i) => states[i] === "ok");

        const [selinux, disks] = await Promise.all([
            client.checkSELinuxContexts(okPaths),
            client.diskUsage(okPaths),
        ]);

        return Object.fromEntries(unique.map((path, i) => {
            const state = states[i];
            if (state !== "ok")
                return [path, { state, selinuxOk: true, disk: null }] as const;
            return [path, {
                state,
                selinuxOk: selinux.get(path) ?? true,
                disk: disks.get(path) ?? null,
            }] as const;
        }));
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
