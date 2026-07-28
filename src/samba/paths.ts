/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

/* Which directories this page refuses to take over.
 *
 * Setting a share folder's permissions means giving it to the share's
 * users and closing it to everyone else. Neither that nor creating a
 * folder is recursive, so the files inside a share are never touched —
 * but a directory nobody else may traverse takes everything underneath it
 * along, because reaching any path means being allowed through every
 * directory on the way. Doing it to / is doing it to the machine: every
 * process not running as root loses the ability to resolve any path at
 * all. Doing it to /home locks every user out of their own files.
 *
 * Applying the SELinux label is worse again, since that one is recursive
 * and records a permanent fcontext rule.
 *
 * These are exact paths and not prefixes on purpose. A share at
 * /srv/media or /var/www/files is an ordinary thing to want, and only the
 * shared directory itself is ever modified — so there is no reason to
 * refuse anything but the directories the system needs as they are.
 */
const PROTECTED_PATHS = new Set([
    "/",

    /* The top level of the filesystem hierarchy. */
    "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64",
    "/libx32", "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin",
    "/srv", "/sys", "/tmp", "/usr", "/var",

    /* Second-level directories with the same problem. */
    "/usr/bin", "/usr/lib", "/usr/lib64", "/usr/local", "/usr/sbin", "/usr/share",
    "/var/cache", "/var/lib", "/var/log", "/var/spool", "/var/tmp",
]);

/* Collapse a path to one form so it can be compared: repeated and
 * trailing slashes go, "." goes, and ".." takes the segment before it.
 *
 * This is lexical, so it does not follow symlinks; the caller resolves
 * those first where it matters. Anything that does not name a directory
 * at all collapses to "/", which is refused, and refusing is the right
 * way to be wrong here.
 */
export function normalizePath(path: string): string {
    const parts: string[] = [];

    for (const part of path.trim().split("/")) {
        if (!part || part === ".")
            continue;
        if (part === "..")
            parts.pop();
        else
            parts.push(part);
    }

    return "/" + parts.join("/");
}

export function isProtectedPath(path: string): boolean {
    return PROTECTED_PATHS.has(normalizePath(path));
}

/* The pattern registered with `semanage fcontext` for a share folder.
 *
 * semanage takes a regular expression, and folder names contain regex
 * metacharacters more often than one would think — "/srv/media (public)"
 * is a perfectly ordinary path. Interpolated raw, that writes a rule
 * which matches the wrong set of paths, or none; and fcontext rules are
 * permanent and re-applied at every filesystem relabel, so a wrong one
 * does not stay harmless.
 */
export function fcontextPattern(path: string): string {
    const escaped = normalizePath(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `${escaped}(/.*)?`;
}
