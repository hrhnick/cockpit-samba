/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

/* Everything that talks to the machine lives here, so the React
 * components stay declarative and the shell-facing details stay
 * testable and in one place.
 *
 * Two conventions apply to every command run from this module:
 *
 *  - err: "message" so a failure rejects with the program's own stderr
 *    rather than an opaque cockpit problem code.
 *
 *  - environ: ["LC_ALL=C"] wherever output is parsed. smbstatus, getent
 *    and ls all translate their headers and field names, and parsing
 *    them by position or by English label silently produces nonsense on
 *    a localized system.
 */

import cockpit from "cockpit";
import { fsinfo } from "cockpit/fsinfo";

import { groupEntryName, isGroupEntry, serializeConf, type SambaConf } from "./conf";
import { fcontextPattern, isProtectedPath, normalizePath } from "./paths";

const _ = cockpit.gettext;

export const SMB_CONF = "/etc/samba/smb.conf";
const SMB_CONF_BACKUP = SMB_CONF + ".bak";

/* systemd calls the Samba file server smb.service on Red Hat family
   distributions and smbd.service on Debian family ones. */
export const SERVICE_UNITS = ["smb.service", "smbd.service"];

export interface SpawnError {
    message?: string;
    problem?: string;
}

/* cockpit.spawn rejects with an object carrying .message when spawned
   with err: "message", and .problem otherwise. */
export function errorString(error: unknown): string {
    const e = error as SpawnError;
    return (e?.message || e?.problem || String(error)).trim();
}

type RunOptions = cockpit.SpawnOptions & { binary?: false };

function run(args: string[], options: RunOptions = {}): cockpit.Spawn<string> {
    return cockpit.spawn(args, { superuser: "try", err: "message", ...options, binary: false });
}

/* Run a command whose output is parsed, in the C locale. */
function runParsed(args: string[], options: RunOptions = {}): cockpit.Spawn<string> {
    return run(args, { environ: ["LC_ALL=C"], ...options });
}

/* --- Configuration ---------------------------------------------------- */

export function confFile(): cockpit.FileHandle<string> {
    return cockpit.file(SMB_CONF, { superuser: "try" });
}

/* Check a candidate smb.conf with testparm, rejecting with the reason it
 * gave. The temporary file is created next to the real one so that
 * `include` directives with relative paths and Samba's own path defaults
 * resolve exactly as they will once the config is in place.
 */
async function validateConf(text: string): Promise<void> {
    let path: string;
    try {
        path = (await run(["mktemp", "/etc/samba/.smb.conf.XXXXXX"])).trim();
    } catch {
        /* /etc/samba may not be writable, or may not exist yet. */
        path = (await run(["mktemp", "/tmp/smb.conf.XXXXXX"])).trim();
    }

    const file = cockpit.file(path, { superuser: "try" });
    try {
        await file.replace(text);
        /* -s suppresses the "Press enter" prompt; testparm reports
           problems on stderr and exits non-zero on a fatal one. */
        await runParsed(["testparm", "-s", path]);
    } catch (error) {
        throw new Error(cockpit.format(_("Validation failed: $0"), errorString(error)));
    } finally {
        file.close();
        run(["rm", "-f", path]).catch(() => null);
    }
}

/* Validate, back up and write smb.conf, then make the running server pick
 * it up.
 *
 * `expectedTag` is the cockpit file tag the caller last saw. Passing it
 * turns a concurrent edit (another admin, or a text editor on the
 * machine) into a failed write instead of a silently lost one.
 */
export async function writeRawConf(text: string, expectedTag?: string): Promise<void> {
    await validateConf(text);

    /* -a keeps mode and ownership, which matters because smb.conf is
       world readable but root owned. */
    await run(["cp", "-a", SMB_CONF, SMB_CONF_BACKUP]).catch(() => null);

    const file = confFile();
    try {
        await file.replace(text, expectedTag);
    } catch (error) {
        if ((error as SpawnError)?.problem === "change-conflict")
            throw new Error(_("The configuration was changed on the system while you were editing it. Reload the page and try again."));
        throw error;
    } finally {
        file.close();
    }

    await reloadService();
}

export async function writeConf(conf: SambaConf, expectedTag?: string): Promise<void> {
    await writeRawConf(serializeConf(conf), expectedTag);
}

/* --- Service ---------------------------------------------------------- */

/* Ask the running server to re-read smb.conf. Failing to reload is worth
   reporting: the file is written but the change is not live yet. */
async function reloadService(): Promise<void> {
    const unit = await detectServiceUnit();
    if (!unit)
        return;
    const state = await run(["systemctl", "is-active", unit]).catch(() => "");
    if (state.trim() !== "active")
        return;
    await run(["systemctl", "reload", unit]);
}

let detected_unit: string | null | undefined;

/* Which of the two possible unit names this machine actually has.
   Cached: a unit does not appear or disappear while the page is open,
   short of installing Samba, which reloads the page. */
export async function detectServiceUnit(): Promise<string | null> {
    if (detected_unit !== undefined)
        return detected_unit;

    for (const unit of SERVICE_UNITS) {
        const state = await runParsed(["systemctl", "show", unit, "--property=LoadState", "--value"])
                .catch(() => "not-found");
        if (!state.includes("not-found")) {
            detected_unit = unit;
            return unit;
        }
    }

    detected_unit = null;
    return null;
}

export async function serverVersion(): Promise<string> {
    const out = await runParsed(["smbd", "--version"]).catch(() => "");
    return out.trim().replace(/^Version\s+/i, "");
}

/* --- Firewall ---------------------------------------------------------- */

export type FirewallState = "open" | "blocked" | "inactive";

/* Whether a running firewalld lets SMB through. "inactive" covers both
   no firewalld and one that is not running — nothing to fix either way.
   Only the default zone is checked; an admin running multiple zones is
   making decisions this page should not second-guess. */
export async function checkFirewall(): Promise<FirewallState> {
    const state = await runParsed(["firewall-cmd", "--state"]).catch(() => null);
    if (state === null || state.trim() !== "running")
        return "inactive";

    const query = await runParsed(["firewall-cmd", "--query-service=samba"]).catch(() => "no");
    return query.trim() === "yes" ? "open" : "blocked";
}

/* Allow SMB now and after the next reboot, which are two separate
   settings in firewalld. */
export async function openFirewall(): Promise<void> {
    await run(["firewall-cmd", "--add-service=samba"]);
    await run(["firewall-cmd", "--permanent", "--add-service=samba"]);
}

/* --- Configuration health ---------------------------------------------- */

/* What testparm has to say about the live configuration beyond pass or
 * fail. It warns about deprecated and insecure settings on stderr while
 * still exiting zero, and our own writes only check the exit code, so
 * these would otherwise never be seen.
 *
 * The shell line is a fixed string with nothing interpolated: it exists
 * only because testparm prints the whole config to stdout and the
 * diagnostics to stderr, and the channel can carry one merged stream.
 */
export async function configWarnings(): Promise<string[]> {
    const out = await runParsed(
        ["sh", "-ec", `exec testparm -s ${SMB_CONF} 2>&1 >/dev/null`])
            .catch(() => "");
    return filterWarnings(out);
}

/* The line filter behind configWarnings, separated so the unit tests can
   feed it captured testparm output. */
export function filterWarnings(out: string): string[] {
    const seen = new Set<string>();
    for (const line of out.split("\n")) {
        const text = line.trim();
        if (!text || /^Load(ed| smb config)/.test(text) || /^Server role/.test(text))
            continue;
        /* This page turns on vfs_fruit itself for Time Machine shares, so
           testparm's warning about mixing fruit and non-fruit shares would
           nag every user about the page's own, deliberate choice. */
        if (/vfs_fruit/i.test(text))
            continue;
        if (/warning|error|deprecated|unknown parameter|ignoring|invalid/i.test(text))
            seen.add(text);
    }
    return [...seen];
}

/* --- Connections ------------------------------------------------------ */

export interface Connection {
    /* Session identity, used to group the shares one client has open. */
    id: string;
    username: string;
    machine: string;
    connectedAt: Date | null;
    encryption: string;
    signing: string;
    shares: string[];
}

interface JsonSession {
    username?: string;
    remote_machine?: string;
    hostname?: string;
    encryption?: { cipher?: string };
    signing?: { cipher?: string };
}

interface JsonTcon {
    service?: string;
    session_id?: string;
    machine?: string;
    connected_at?: string;
    encryption?: { cipher?: string };
    signing?: { cipher?: string };
}

interface SmbstatusJson {
    sessions?: Record<string, JsonSession>;
    tcons?: Record<string, JsonTcon>;
}

/* smbstatus --json, on Samba 4.16 and later. Far more robust than
   scraping the fixed-width report, so it is tried first. Exported for the
   unit tests: it is pure, and exactly the kind of parsing that breaks
   quietly. */
export function parseConnectionsJson(text: string): Connection[] | null {
    let data: SmbstatusJson;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    if (!data || typeof data !== "object" || !data.sessions)
        return null;

    const connections = new Map<string, Connection>();

    for (const [id, session] of Object.entries(data.sessions)) {
        connections.set(id, {
            id,
            username: session.username ?? "",
            machine: session.remote_machine ?? session.hostname ?? "",
            connectedAt: null,
            encryption: session.encryption?.cipher ?? "",
            signing: session.signing?.cipher ?? "",
            shares: [],
        });
    }

    for (const tcon of Object.values(data.tcons ?? {})) {
        const connection = tcon.session_id !== undefined ? connections.get(tcon.session_id) : undefined;
        if (!connection || !tcon.service)
            continue;

        /* IPC$ is the hidden administrative pipe every client opens; it
           is not a share anyone chose to connect to. */
        if (tcon.service !== "IPC$")
            connection.shares.push(tcon.service);

        const at = tcon.connected_at ? new Date(tcon.connected_at) : null;
        /* Report when this client first connected, not when it opened
           its most recent share. */
        if (at && !isNaN(at.getTime()) && (!connection.connectedAt || at < connection.connectedAt))
            connection.connectedAt = at;
        if (!connection.encryption)
            connection.encryption = tcon.encryption?.cipher ?? "";
        if (!connection.signing)
            connection.signing = tcon.signing?.cipher ?? "";
    }

    return [...connections.values()];
}

/* Slice a fixed-width smbstatus report by the column each header starts
 * at. Splitting on whitespace does not work: values contain runs of two
 * or more spaces, most obviously the ctime-style "Connected at" stamp,
 * which pads single digit days ("Jul  6").
 */
function parseColumns(text: string, wanted: [string, string][]): Record<string, string>[] {
    const lines = text.split("\n");
    const separator = lines.findIndex(l => /^-{5,}/.test(l.trim()));
    if (separator < 1)
        return [];

    const header = lines[separator - 1];
    const columns = wanted
            .map(([label, key]) => ({ key, start: header.indexOf(label) }))
            .filter(c => c.start !== -1)
            .sort((a, b) => a.start - b.start);

    return lines.slice(separator + 1)
            .filter(line => line.trim())
            .map(line => {
                const row: Record<string, string> = {};
                columns.forEach((column, i) => {
                    const end = i + 1 < columns.length ? columns[i + 1].start : line.length;
                    row[column.key] = line.slice(column.start, end).trim();
                });
                return row;
            });
}

/* The pre-JSON fallback: join `smbstatus -p` (sessions, with the
   username) and `smbstatus -S` (the shares each process has open) by
   PID. Takes the two reports as text — the spawning lives in
   getConnections — so the tests can feed it captured output. */
export function parseConnectionsText(processes: string, tcons: string): Connection[] {
    const connections = new Map<string, Connection>();

    for (const row of parseColumns(processes, [
        ["PID", "pid"], ["Username", "username"], ["Group", "group"],
        ["Machine", "machine"], ["Protocol Version", "protocol"],
        ["Encryption", "encryption"], ["Signing", "signing"],
    ])) {
        if (!row.pid)
            continue;
        connections.set(row.pid, {
            id: row.pid,
            username: row.username ?? "",
            machine: row.machine ?? "",
            connectedAt: null,
            encryption: row.encryption ?? "",
            signing: row.signing ?? "",
            shares: [],
        });
    }

    for (const row of parseColumns(tcons, [
        ["Service", "share"], ["pid", "pid"], ["Machine", "machine"],
        ["Connected at", "connectedAt"], ["Encryption", "encryption"],
        ["Signing", "signing"],
    ])) {
        const connection = connections.get(row.pid);
        if (!connection)
            continue;
        if (row.share && row.share !== "IPC$")
            connection.shares.push(row.share);

        const at = row.connectedAt ? new Date(row.connectedAt) : null;
        if (at && !isNaN(at.getTime()) && (!connection.connectedAt || at < connection.connectedAt))
            connection.connectedAt = at;
    }

    return [...connections.values()];
}

export async function getConnections(): Promise<Connection[]> {
    const json = await runParsed(["smbstatus", "--json"]).catch(() => null);
    if (json !== null) {
        const parsed = parseConnectionsJson(json);
        if (parsed)
            return parsed;
    }
    const [processes, tcons] = await Promise.all([
        runParsed(["smbstatus", "-p"]).catch(() => ""),
        runParsed(["smbstatus", "-S"]).catch(() => ""),
    ]);
    return parseConnectionsText(processes, tcons);
}

/* --- Users ------------------------------------------------------------ */

export interface SambaUser {
    name: string;
    uid: number;
    fullName: string;
    hasPassword: boolean;
    /* Every group the account belongs to, for matching against the
       @group entries in a share's user lists. */
    groups: string[];
}

interface PasswdEntry {
    name: string;
    uid: number;
    gid: number;
    gecos: string;
    shell: string;
}

async function getent(database: "passwd" | "group"): Promise<string[][]> {
    const out = await runParsed(["getent", database]).catch(() => "");
    return out.split("\n")
            .filter(line => line.trim())
            .map(line => line.split(":"));
}

async function passwdEntries(): Promise<PasswdEntry[]> {
    return (await getent("passwd"))
            .filter(parts => parts.length >= 7)
            .map(parts => ({
                name: parts[0],
                uid: parseInt(parts[2], 10),
                gid: parseInt(parts[3], 10),
                gecos: parts[4] ?? "",
                shell: parts[6] ?? "",
            }));
}

interface GroupEntry {
    name: string;
    gid: number;
    members: string[];
}

async function groupEntries(): Promise<GroupEntry[]> {
    return (await getent("group"))
            .filter(parts => parts.length >= 3)
            .map(parts => ({
                name: parts[0],
                gid: parseInt(parts[2], 10),
                members: (parts[3] ?? "").split(",").filter(Boolean),
            }));
}

/* An account a person logs in with, as opposed to a system account.
   The UID range comes from login.defs so that machines which moved
   UID_MIN off the default are handled correctly. */
function isLoginShell(shell: string): boolean {
    return !/(nologin|\/false|\/sync)$/.test(shell.trim());
}

let uid_range: { min: number, max: number } | undefined;

async function loginUidRange(): Promise<{ min: number, max: number }> {
    if (uid_range)
        return uid_range;

    uid_range = { min: 1000, max: 60000 };
    for (const path of ["/etc/login.defs", "/usr/etc/login.defs"]) {
        const text = await cockpit.file(path).read().catch(() => null);
        if (!text)
            continue;
        const min = /^UID_MIN\s+(\d+)/m.exec(text);
        const max = /^UID_MAX\s+(\d+)/m.exec(text);
        if (min)
            uid_range.min = parseInt(min[1], 10);
        if (max)
            uid_range.max = parseInt(max[1], 10);
        break;
    }
    return uid_range;
}

/* The names Samba has a password database entry for. */
async function sambaAccountNames(): Promise<Set<string>> {
    const out = await runParsed(["pdbedit", "-L"]).catch(() => "");
    return new Set(out.split("\n")
            .map(line => line.split(":")[0].trim())
            .filter(Boolean));
}

export async function listUsers(): Promise<SambaUser[]> {
    const [entries, range, sambaNames, groups] = await Promise.all([
        passwdEntries(), loginUidRange(), sambaAccountNames(), groupEntries(),
    ]);

    /* Group membership from both directions: the account's primary GID,
       and the member lists of the other groups. */
    const byGid = new Map(groups.map(group => [group.gid, group.name]));
    const memberships = new Map<string, string[]>();
    for (const group of groups)
        for (const member of group.members)
            memberships.set(member, [...(memberships.get(member) ?? []), group.name]);

    return entries
            .filter(entry => entry.uid >= range.min && entry.uid <= range.max && isLoginShell(entry.shell))
            .map(entry => {
                const primary = byGid.get(entry.gid);
                return {
                    name: entry.name,
                    uid: entry.uid,
                    fullName: entry.gecos.split(",")[0],
                    hasPassword: sambaNames.has(entry.name),
                    groups: [...new Set([...(primary ? [primary] : []), ...(memberships.get(entry.name) ?? [])])],
                };
            });
}

export async function setPassword(user: string, password: string): Promise<void> {
    /* smbpasswd reads the new password twice from stdin with -s.
       Passing it as an argument would put it in the process list. */
    await run(["smbpasswd", "-a", "-s", user], { directory: "/" })
            .input(`${password}\n${password}\n`);
}

export async function removePassword(user: string): Promise<void> {
    await run(["pdbedit", "-x", "-u", user]);
}

/* Users and groups offered in the "valid users" field. Groups are
 * prefixed with @, which is how smb.conf names them.
 *
 * Only accounts and groups that belong to real people are suggested:
 * everything else on a typical machine is service accounts, and a list
 * of eighty of those helps nobody.
 */
export async function listUserGroupSuggestions(): Promise<string[]> {
    /* systemd's dynamic users get IDs from this range; they exist only
       while a unit is running. */
    const DYNAMIC_MIN = 61184;
    const DYNAMIC_MAX = 65519;
    const isDynamic = (id: number) => id >= DYNAMIC_MIN && id <= DYNAMIC_MAX;
    const NOISE = new Set(["nobody", "nogroup"]);
    const ADMIN_GROUPS = new Set(["wheel", "sudo", "admin", "adm"]);

    const [entries, groups] = await Promise.all([passwdEntries(), groupEntries()]);

    const users: string[] = [];
    const names = new Set<string>();
    const primaryGids = new Set<number>();

    for (const entry of entries) {
        /* root is offered because it is a real login, unlike the rest of
           the sub-1000 range. */
        if ((entry.uid !== 0 && entry.uid < 1000) || isDynamic(entry.uid) || !isLoginShell(entry.shell))
            continue;
        users.push(entry.name);
        names.add(entry.name);
        primaryGids.add(entry.gid);
    }

    const groupNames: string[] = [];
    for (const { name, gid, members } of groups) {
        if (isDynamic(gid) || NOISE.has(name))
            continue;
        if (members.some(m => names.has(m)) || primaryGids.has(gid) || ADMIN_GROUPS.has(name))
            groupNames.push("@" + name);
    }

    return [...users, ...groupNames];
}

/* --- Directories and permissions -------------------------------------- */

/* "unknown" means the check itself could not be made — an old bridge
   without the fsinfo channel, or a permission problem reading the parent
   directory. The UI reports nothing rather than a wrong warning. */
export type PathState = "ok" | "missing" | "not-a-directory" | "unknown";

export async function checkPath(path: string): Promise<PathState> {
    if (!path.startsWith("/"))
        return "unknown";

    try {
        const info = await fsinfo(path, ["type"]);
        return info.type === "dir" ? "ok" : "not-a-directory";
    } catch (error) {
        const { problem, errno } = error as { problem?: string, errno?: string };
        if (errno === "ENOENT" || problem === "not-found")
            return "missing";
        return "unknown";
    }
}

export async function createDirectory(path: string): Promise<void> {
    await run(["mkdir", "-p", "--", path]);
}

export interface DiskUsage {
    total: number;
    available: number;
}

/* How much room each share has left, in one df run for every path
 * rather than one per path — the answers are refreshed together, and on
 * the small machines this runs on the processes are the expensive part.
 *
 * -P is the POSIX single-line-per-filesystem format, so a long device
 * name cannot wrap and shift the columns; -B1 asks for bytes. Null for
 * a path whose answer could not be read, which the caller reports as
 * nothing rather than as zero.
 */
export async function diskUsage(paths: string[]): Promise<Map<string, DiskUsage | null>> {
    if (paths.length === 0)
        return new Map();
    const out = await runParsed(["df", "-B1", "-P", "--", ...paths]).catch(() => "");
    return parseDiskUsage(out, paths);
}

/* Pure, exported for the unit tests. df prints one line per operand in
   operand order, but the line names the filesystem and mount point, not
   the operand — so the mapping is positional, and a missing line (a
   path that vanished since it was checked) would shift every mapping
   after it. The count check turns that into "no answer" rather than
   into wrong answers. */
export function parseDiskUsage(out: string, paths: string[]): Map<string, DiskUsage | null> {
    const result = new Map<string, DiskUsage | null>(paths.map(path => [path, null]));

    /* Drop the header; blank lines would break the positional mapping,
       and df does not produce them. */
    const lines = out.split("\n").filter(line => line.trim()).slice(1);
    if (lines.length !== paths.length)
        return result;

    lines.forEach((line, i) => {
        /* Matched from the right, because the device name in the first
           column may itself contain spaces. */
        const fields = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s/.exec(line);
        if (fields)
            result.set(paths[i], { total: parseInt(fields[1], 10), available: parseInt(fields[3], 10) });
    });
    return result;
}

/* Give the share's users access to the directory on the filesystem.
 * Samba enforces `valid users` on top of the ordinary Unix permissions,
 * so a share whose directory is only readable by root lets nobody in
 * however it is configured.
 *
 * Returns true when per-user ACLs were wanted but setfacl was not
 * available, in which case access is limited to the owner and group.
 */
export type PermissionPlan =
    /* Nobody in particular was named, so there is no permission to grant.
       Widening the folder to everyone would hand it to every local account
       as well, which is a good deal more than the share asked for. */
    | { kind: "none" }
    /* Ordinary ownership covers up to one user and one group, which is what
       most shares are. Only beyond that are ACLs needed, and setfacl is not
       installed by default on Debian and its derivatives — it comes from the
       acl package — so it is worth avoiding when it buys nothing. */
    | { kind: "ownership", owner: string, group: string }
    | { kind: "acl", users: string[], groups: string[] };

/* What applyPermissions would do, so that a dialog can say so before the
   user agrees to it rather than after. Group entries keep their smb.conf
   markers (@, +, &) until here; classifying "+staff" as a user named
   +staff would put that on a chown command line. */
export function permissionPlan(principals: string[]): PermissionPlan {
    const users = principals.filter(entry => !isGroupEntry(entry));
    const groups = principals.filter(isGroupEntry).map(groupEntryName)
            .filter(Boolean);

    if (users.length === 0 && groups.length === 0)
        return { kind: "none" };
    if (users.length <= 1 && groups.length <= 1)
        return { kind: "ownership", owner: users[0] ?? "", group: groups[0] ?? "" };
    return { kind: "acl", users, groups };
}

/* Where a path really leads. chown and chmod follow symlinks, so a share
   at /srv/data pointing at / has to be judged as /, not as /srv/data. */
async function realPath(path: string): Promise<string> {
    const out = await runParsed(["readlink", "-f", "--", path]).catch(() => "");
    return out.trim() || normalizePath(path);
}

export async function applyPermissions(path: string, principals: string[]): Promise<boolean> {
    const plan = permissionPlan(principals);

    if (plan.kind === "none")
        return false;

    /* The last line of defence rather than the first: the dialogs do not
       offer this for a system directory. See samba/paths.ts for what goes
       wrong if it happens anyway. */
    const target = await realPath(path);
    if (isProtectedPath(target))
        throw new Error(cockpit.format(
            _("Refusing to change the permissions of $0, which the system needs as it is."), target));

    /* "--" throughout: names and paths here come from smb.conf and the
       dialogs, and GNU tools accept options anywhere on the command line,
       so an argument starting with "-" would otherwise be read as one.
       Today every such parse fails outright, but option injection into
       chown or chmod is not something to leave to how getopt happens to
       behave.

       setgid in the group cases keeps files created inside the share in
       the share's group, so members keep seeing each other's files. */
    if (plan.kind === "ownership") {
        await run(["chown", "--", `${plan.owner}:${plan.group}`, path]);
        await run(["chmod", "--", plan.group ? "2770" : "0700", path]);
        return false;
    }

    await run(["chmod", "--", "770", path]);

    /* Default (d:) entries as well as access entries, so files created
       inside the share inherit them. */
    const acl = [
        ...plan.users.flatMap(u => [`u:${u}:rwx`, `d:u:${u}:rwx`]),
        ...plan.groups.flatMap(g => [`g:${g}:rwx`, `d:g:${g}:rwx`]),
    ];

    try {
        await run(["setfacl", "-m", acl.join(","), "--", path]);
        return false;
    } catch {
        return true;
    }
}

/* --- SELinux ---------------------------------------------------------- */

let selinux_enabled: Promise<boolean> | undefined;

/* Cached, and deliberately for the life of the page: SELinux cannot be
   turned on or off without a reboot, and this is asked once per share
   every time the share list is refreshed. */
export function isSELinuxEnabled(): Promise<boolean> {
    selinux_enabled ??= (async () => {
        try {
            const mode = (await runParsed(["getenforce"])).trim();
            return mode === "Enforcing" || mode === "Permissive";
        } catch {
            /* getenforce may be missing, or not on the bridge's PATH, even
               where SELinux is active; ask the kernel directly. */
            const enforce = await cockpit.file("/sys/fs/selinux/enforce", { superuser: "try" })
                    .read()
                    .catch(() => null);
            return enforce !== null;
        }
    })();
    return selinux_enabled;
}

/* Whether Samba is allowed to serve files from each path, in one
   `ls -Zd` run for the lot rather than one per path. True means nothing
   to fix, including when we could not tell. */
export async function checkSELinuxContexts(paths: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>(paths.map(path => [path, true]));

    const checkable = paths.filter(path => path.trim() && path.trim() !== "/");
    if (checkable.length === 0 || !await isSELinuxEnabled())
        return result;

    const out = await runParsed(["ls", "-Zd", "--", ...checkable]).catch(() => "");
    for (const [path, ok] of parseSELinuxContexts(out, checkable))
        result.set(path, ok);
    return result;
}

/* Pure, exported for the unit tests. ls prints one line per path in
   argument order; as with df, the mapping is positional and a count
   mismatch means "could not tell" for everything rather than the wrong
   answer for something. */
export function parseSELinuxContexts(out: string, paths: string[]): Map<string, boolean> {
    const result = new Map<string, boolean>(paths.map(path => [path, true]));

    const lines = out.split("\n").filter(line => line.trim());
    if (lines.length !== paths.length)
        return result;

    lines.forEach((line, i) => {
        /* A leading "?" means no context is recorded, e.g. on a
           filesystem that does not support labels. */
        if (line.trim().startsWith("?"))
            return;
        result.set(paths[i], /samba_share_t|public_content(_rw)?_t/.test(line));
    });
    return result;
}

export async function fixSELinuxContext(path: string): Promise<void> {
    /* Trailing slashes would make the semanage regex malformed, and
       restorecon follows symlinks the same way chown does. */
    const clean = await realPath(path);

    /* This one relabels the whole tree and records a permanent rule, so
       aiming it at a system directory does more damage than the
       permission change does. */
    if (isProtectedPath(clean))
        throw new Error(cockpit.format(
            _("Refusing to change the SELinux context of $0, which the system needs as it is."), clean));

    /* semanage takes a regular expression, and the path has to be escaped
       into one: folder names contain regex metacharacters often enough
       ("/srv/media (public)"), and a wrong rule here is permanent and
       re-applied at every relabel. */
    const pattern = fcontextPattern(clean);

    try {
        /* Register a persistent rule first so the label survives a
           filesystem relabel, which would silently undo a bare chcon.
           -a fails when a rule for the path already exists, so fall
           back to modifying it. */
        await run(["semanage", "fcontext", "-a", "-t", "samba_share_t", pattern])
                .catch(() => run(["semanage", "fcontext", "-m", "-t", "samba_share_t", pattern]));
        await run(["restorecon", "-R", "--", clean]);
    } catch {
        /* policycoreutils-python-utils may not be installed. chcon
           relabels now but does not survive a relabel. */
        await run(["chcon", "-R", "-t", "samba_share_t", "--", clean]);
    }
}

/* --- Logs ------------------------------------------------------------- */

/* Follow the journal for Samba: the service unit's own messages plus the
 * full_audit lines, which journald tags smbd_audit because the module
 * logs through syslog. "+" is journalctl's OR between match groups.
 *
 * The caller owns the returned process and must close() it.
 */
export function followLogs(unit: string | null, identifier: string,
    onData: (chunk: string) => void): cockpit.Spawn<string> {
    const args = ["journalctl", "--follow", "--lines=200", "--no-pager", `SYSLOG_IDENTIFIER=${identifier}`];
    if (unit)
        args.push("+", `_SYSTEMD_UNIT=${unit}`);

    const proc = run(args);
    proc.stream(onData);
    return proc;
}
