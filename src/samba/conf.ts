/*
 * Copyright (C) 2026 cockpit-samba contributors
 * SPDX-License-Identifier: MIT
 */

/* smb.conf parsing and editing.
 *
 * The guiding rule here is that we never rewrite the whole file from a
 * data structure: an smb.conf routinely carries comments, `include`
 * directives, macros and parameters this UI knows nothing about, and
 * regenerating it from the handful of keys we understand throws all of
 * that away. Instead the file is parsed into sections of entries that
 * each remember their original source lines, edits replace only the
 * lines they touch, and serializing an unmodified config returns the
 * input byte for byte.
 *
 * Two smb.conf quirks matter throughout:
 *
 *  - Parameter names are case insensitive and ignore internal spaces, so
 *    `read only`, `Read Only` and `readonly` are one and the same
 *    parameter. Lookups therefore go through normalizeKey().
 *
 *  - Many parameters have synonyms (`browsable`/`browseable`) or inverses
 *    (`read only` vs `writeable`), and an unset parameter falls back to
 *    the value in [global] and then to Samba's own default rather than to
 *    "off". Reading a flag goes through resolveFlag() for that reason.
 */

export interface ConfEntry {
    /* "param" for `key = value`, "other" for comments, blanks and
       anything else we pass through untouched. */
    kind: "param" | "other";
    /* The exact source lines this entry was parsed from. More than one
       only when backslash continuations were used. */
    lines: string[];
    /* Parameter name normalized for lookup; see normalizeKey(). */
    key?: string;
    /* Parameter name as it was written, so edits keep the file's style. */
    label?: string;
    value?: string;
}

export interface ConfSection {
    /* Section name as written, without the brackets. */
    name: string;
    /* Lowercased name, for case insensitive lookup. */
    key: string;
    /* The `[name]` line. Empty for the implicit section that holds
       anything appearing before the first real section header. */
    headerLines: string[];
    entries: ConfEntry[];
}

export interface SambaConf {
    sections: ConfSection[];
    /* True when the file used CRLF line endings, so we can write them back. */
    crlf: boolean;
}

export const GLOBAL = "global";

/* Sections Samba gives a special meaning to. They are still listed and
   editable, but they have no `path` of their own and creating one by
   hand is unusual, so the UI labels them. */
export const SPECIAL_SECTIONS = ["homes", "printers", "print$"];

const SECTION_RE = /^\s*\[([^\]]*)\]/;
const COMMENT_RE = /^\s*[#;]/;

/* Samba ignores case and internal whitespace in parameter names. */
export function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/\s+/g, "");
}

/* Samba accepts yes/no, true/false, 1/0 and on/off, case insensitively. */
export function parseBool(value: string | undefined): boolean | undefined {
    if (value === undefined)
        return undefined;
    const v = value.trim().toLowerCase();
    if (["yes", "true", "1", "on"].includes(v))
        return true;
    if (["no", "false", "0", "off"].includes(v))
        return false;
    return undefined;
}

function splitParam(line: string): { label: string, value: string } | null {
    const eq = line.indexOf("=");
    if (eq === -1)
        return null;
    const label = line.slice(0, eq).trim();
    if (!label)
        return null;
    return { label, value: line.slice(eq + 1).trim() };
}

/* Join a parameter's physical lines into its logical value, dropping the
   trailing backslashes and the indentation of continuation lines. */
function joinContinuations(lines: string[]): string {
    return lines
            .map((l, i) => (i === 0 ? l : l.trimStart()))
            .map((l, i) => (i === lines.length - 1 ? l : l.replace(/\\$/, "")))
            .join("");
}

export function parseConf(text: string): SambaConf {
    const crlf = text.includes("\r\n");
    const lines = text.replace(/\r\n/g, "\n").split("\n");

    /* A trailing newline splits into a final empty element that is an
       artifact of the split, not a real blank line. Drop it so that
       serialize() reproduces the input exactly. */
    if (lines.length > 0 && lines[lines.length - 1] === "")
        lines.pop();

    const preamble: ConfSection = { name: "", key: "", headerLines: [], entries: [] };
    const conf: SambaConf = { sections: [preamble], crlf };
    let current = preamble;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const section = !COMMENT_RE.test(line) && SECTION_RE.exec(line);
        if (section) {
            const name = section[1].trim();
            current = { name, key: name.toLowerCase(), headerLines: [line], entries: [] };
            conf.sections.push(current);
            continue;
        }

        /* Gather backslash continuations into a single entry. */
        const group = [line];
        while (/\\$/.test(group[group.length - 1]) && i + 1 < lines.length)
            group.push(lines[++i]);

        const joined = joinContinuations(group);
        const param = COMMENT_RE.test(line) ? null : splitParam(joined);
        if (param) {
            current.entries.push({
                kind: "param",
                lines: group,
                key: normalizeKey(param.label),
                label: param.label,
                value: param.value,
            });
        } else {
            current.entries.push({ kind: "other", lines: group });
        }
    }

    return conf;
}

export function serializeConf(conf: SambaConf): string {
    const lines: string[] = [];
    for (const section of conf.sections) {
        lines.push(...section.headerLines);
        for (const entry of section.entries)
            lines.push(...entry.lines);
    }
    /* Always leave the file newline terminated. */
    const text = lines.join("\n") + (lines.length ? "\n" : "");
    return conf.crlf ? text.replace(/\n/g, "\r\n") : text;
}

export function getSection(conf: SambaConf, name: string): ConfSection | undefined {
    const key = name.toLowerCase();
    return conf.sections.find(s => s.headerLines.length > 0 && s.key === key);
}

/* Sections that represent shares: everything with a header except [global]. */
export function shareSections(conf: SambaConf): ConfSection[] {
    return conf.sections.filter(s => s.headerLines.length > 0 && s.key !== GLOBAL);
}

/* Samba lets a parameter be repeated and the last definition wins. */
export function getParam(section: ConfSection | undefined, key: string): string | undefined {
    if (!section)
        return undefined;
    const norm = normalizeKey(key);
    let found: string | undefined;
    for (const entry of section.entries)
        if (entry.kind === "param" && entry.key === norm)
            found = entry.value;
    return found;
}

/* First of `keys` that is actually set on the section. */
function getFirstParam(section: ConfSection | undefined, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = getParam(section, key);
        if (value !== undefined)
            return value;
    }
    return undefined;
}

function indentOf(line: string | undefined): string {
    const match = line ? /^\s*/.exec(line) : null;
    return match ? match[0] : "\t";
}

/* A parameter value or name becomes one line of smb.conf verbatim, so a
   line break inside one would end the parameter early and turn the rest
   into configuration — a parameter, or a whole [section], that nobody
   wrote. Every input this page offers is single-line, so nothing
   legitimate is refused; this is the model insisting on it rather than
   trusting every present and future caller to. */
function assertSingleLine(text: string, what: string): void {
    if (/[\n\r]/.test(text))
        throw new Error(`${what} must not contain line breaks`);
}

export function setParam(section: ConfSection, label: string, value: string): void {
    assertSingleLine(label, "parameter name");
    assertSingleLine(value, "parameter value");
    const norm = normalizeKey(label);

    /* Update the last definition in place and drop any earlier
       duplicates, so the file ends up with exactly one. */
    let last = -1;
    for (let i = 0; i < section.entries.length; i++) {
        const entry = section.entries[i];
        if (entry.kind === "param" && entry.key === norm)
            last = i;
    }

    if (last !== -1) {
        const entry = section.entries[last];
        const indent = indentOf(entry.lines[0]);
        section.entries[last] = {
            kind: "param",
            lines: [`${indent}${entry.label ?? label} = ${value}`],
            key: norm,
            label: entry.label ?? label,
            value,
        };
        section.entries = section.entries.filter((e, i) =>
            i === last || !(e.kind === "param" && e.key === norm));
        return;
    }

    /* Append after the section's last parameter, keeping any trailing
       blank lines or comments below the block where the author put them. */
    let insertAt = section.entries.length;
    while (insertAt > 0 && section.entries[insertAt - 1].kind !== "param")
        insertAt--;

    const indent = indentOf(section.entries.find(e => e.kind === "param")?.lines[0]);
    section.entries.splice(insertAt, 0, {
        kind: "param",
        lines: [`${indent}${label} = ${value}`],
        key: norm,
        label,
        value,
    });
}

export function deleteParam(section: ConfSection, key: string): void {
    const norm = normalizeKey(key);
    section.entries = section.entries.filter(e => !(e.kind === "param" && e.key === norm));
}

/* Remove a whole family of parameters, e.g. every `recycle:...` setting.
   The module they configure is being switched off, so leaving them behind
   would be dead weight that reappears if it is switched on again. */
function deleteParamFamily(section: ConfSection, prefix: string): void {
    section.entries = section.entries.filter(e =>
        !(e.kind === "param" && e.key?.startsWith(prefix)));
}

/* Set the parameter when `value` is non-empty, remove it otherwise. */
export function setOrDeleteParam(section: ConfSection, label: string, value: string): void {
    if (value)
        setParam(section, label, value);
    else
        deleteParam(section, label);
}

/* A section name becomes the `[name]` header line, so "]" would end the
   name early and a line break would end the line; either way the rest
   becomes configuration nobody wrote. The share dialog refuses these
   before they get here; the model refuses them regardless of who calls. */
function assertSectionName(name: string): void {
    assertSingleLine(name, "section name");
    if (name.includes("]"))
        throw new Error("section name must not contain \"]\"");
}

export function addSection(conf: SambaConf, name: string): ConfSection {
    assertSectionName(name);
    const existing = getSection(conf, name);
    if (existing)
        return existing;

    /* Separate the new section from whatever precedes it. */
    const last = conf.sections[conf.sections.length - 1];
    const lastEntry = last?.entries[last.entries.length - 1];
    const needsBlank = (last?.headerLines.length ?? 0) > 0 || (last?.entries.length ?? 0) > 0;
    if (needsBlank && lastEntry?.lines.join("").trim() !== "")
        last.entries.push({ kind: "other", lines: [""] });

    const section: ConfSection = {
        name,
        key: name.toLowerCase(),
        headerLines: [`[${name}]`],
        entries: [],
    };
    conf.sections.push(section);
    return section;
}

export function removeSection(conf: SambaConf, name: string): void {
    const key = name.toLowerCase();
    const index = conf.sections.findIndex(s => s.headerLines.length > 0 && s.key === key);
    if (index === -1)
        return;

    conf.sections.splice(index, 1);

    /* Removing a section can leave two blank lines where its separator
       and its successor's separator meet; collapse the leftover. */
    const previous = conf.sections[index - 1];
    const previousLast = previous?.entries[previous.entries.length - 1];
    const next = conf.sections[index];
    if (previousLast && previousLast.lines.join("").trim() === "" &&
        next && next.headerLines.length === 0 && next.entries.length === 0)
        previous.entries.pop();
}

export function renameSection(section: ConfSection, name: string): void {
    assertSectionName(name);
    section.headerLines = [`[${name}]`];
    section.name = name;
    section.key = name.toLowerCase();
}

/* --- Share model ------------------------------------------------------ */

export interface Share {
    name: string;
    path: string;
    comment: string;
    readOnly: boolean;
    browseable: boolean;
    guestOk: boolean;
    validUsers: string[];
    /* True for [homes], [printers] and [print$], which Samba handles
       specially and which have no directory of their own. */
    isSpecial: boolean;
    /* False turns the share off without deleting its configuration. */
    available: boolean;
    /* Users and groups that may write even on a read-only share. */
    writeList: string[];
    /* Client addresses, names or subnets, in smb.conf's own syntax.
       Kept as written: the syntax has more forms (EXCEPT clauses, netgroups,
       partial addresses) than a structured editor would do justice to. */
    hostsAllow: string;
    hostsDeny: string;
    /* Ownership and permissions given to files clients create. */
    forceGroup: string;
    createMask: string;
    directoryMask: string;
    /* Deleted files are moved aside instead of being destroyed. */
    recycleBin: boolean;
    /* The share is offered to macOS as a Time Machine backup target. */
    timeMachine: boolean;
    /* How large the backups may grow, e.g. "500G". Empty for no limit —
       which on a backup target means "until the disk is full". */
    timeMachineMaxSize: string;
}

/* A share with nothing configured, which is both what the create dialog
   starts from and Samba's own behaviour for a section that sets nothing. */
export function emptyShare(): Share {
    return {
        name: "",
        path: "",
        comment: "",
        readOnly: false,
        browseable: true,
        guestOk: false,
        validUsers: [],
        isSpecial: false,
        available: true,
        writeList: [],
        hostsAllow: "",
        hostsDeny: "",
        forceGroup: "",
        createMask: "",
        directoryMask: "",
        recycleBin: false,
        timeMachine: false,
        timeMachineMaxSize: "",
    };
}

/* Parameters this UI writes, with the synonyms and inverses Samba
   accepts for each. Reading has to consider all of them; writing uses
   the first spelling and clears the others so the two can't disagree. */
const PATH_KEYS = ["path", "directory"];
const READ_ONLY_KEYS = ["read only"];
const WRITEABLE_KEYS = ["writeable", "writable", "write ok"];
const BROWSEABLE_KEYS = ["browseable", "browsable"];
const GUEST_KEYS = ["guest ok", "public"];
const AVAILABLE_KEYS = ["available"];
const WRITE_LIST_KEYS = ["write list"];
const HOSTS_ALLOW_KEYS = ["hosts allow", "allow hosts"];
const HOSTS_DENY_KEYS = ["hosts deny", "deny hosts"];
const FORCE_GROUP_KEYS = ["force group", "group"];
const CREATE_MASK_KEYS = ["create mask", "create mode"];
const DIRECTORY_MASK_KEYS = ["directory mask", "directory mode"];
const VFS_KEYS = ["vfs objects", "vfs object"];

/* --- VFS modules ------------------------------------------------------ */

/* `vfs objects` is not additive: a share that sets it overrides the
 * [global] list outright rather than adding to it. Writing a bare
 * `vfs objects = recycle` on a share would therefore quietly take file
 * activity logging off that one share, so anything written here starts
 * from the list the share would otherwise have inherited.
 */
export const AUDIT_MODULE = "full_audit";
const RECYCLE_MODULE = "recycle";
/* catia maps the characters macOS allows and Windows does not, fruit
   speaks the Apple extensions, and streams_xattr stores the metadata
   fruit produces. All three are needed, in this order. */
const FRUIT_MODULES = ["catia", "fruit", "streams_xattr"];
const MANAGED_MODULES = [RECYCLE_MODULE, ...FRUIT_MODULES];

function vfsObjects(section: ConfSection | undefined): string[] {
    return (getFirstParam(section, VFS_KEYS) ?? "")
            .split(/\s+/)
            .filter(Boolean);
}

/* The modules that actually apply to a section: its own list if it has
   one, otherwise whatever [global] sets. */
function effectiveVfsObjects(conf: SambaConf, section: ConfSection | undefined): string[] {
    if (getFirstParam(section, VFS_KEYS) !== undefined)
        return vfsObjects(section);
    return vfsObjects(getSection(conf, GLOBAL));
}

/* Where deleted files go, and how the copy is kept. keeptree preserves
   the folder structure so a restore lands back where it came from, and
   versions keeps an older copy rather than overwriting it. */
const RECYCLE_PARAMS: Record<string, string> = {
    "recycle:repository": ".recycle/%U",
    "recycle:keeptree": "yes",
    "recycle:versions": "yes",
    "recycle:touch": "no",
    "recycle:directory_mode": "0770",
    "recycle:exclude": "*.tmp *.temp *.o *.obj ~$*",
};

/* Only the per-share fruit options are written here. The module also has
   global-only ones (fruit:model, fruit:aapl, fruit:nfs_aces); putting
   those in a share section has no effect, so they are left to whoever
   wants them in [global]. */
const FRUIT_PARAMS: Record<string, string> = {
    "fruit:time machine": "yes",
    "fruit:metadata": "stream",
    "fruit:posix_rename": "yes",
    "fruit:veto_appledouble": "no",
    "fruit:wipe_intentionally_left_blank_rfork": "yes",
    "fruit:delete_empty_adfiles": "yes",
};

/* Resolve a boolean parameter the way Samba does: the share's own
   setting, else the [global] setting, else Samba's built-in default. */
function resolveFlag(conf: SambaConf, section: ConfSection | undefined,
    keys: string[], fallback: boolean): boolean {
    const global = getSection(conf, GLOBAL);
    for (const source of [section, global]) {
        const value = parseBool(getFirstParam(source, keys));
        if (value !== undefined)
            return value;
    }
    return fallback;
}

function resolveReadOnly(conf: SambaConf, section: ConfSection | undefined): boolean {
    const global = getSection(conf, GLOBAL);
    for (const source of [section, global]) {
        const readOnly = parseBool(getFirstParam(source, READ_ONLY_KEYS));
        if (readOnly !== undefined)
            return readOnly;
        const writeable = parseBool(getFirstParam(source, WRITEABLE_KEYS));
        if (writeable !== undefined)
            return !writeable;
    }
    /* Samba's default really is read only = yes. */
    return true;
}

export function parseValidUsers(raw: string | undefined): string[] {
    if (!raw)
        return [];
    return raw.split(/[,\s]+/).map(s => s.trim())
            .filter(Boolean);
}

export function readShare(conf: SambaConf, section: ConfSection): Share {
    const modules = effectiveVfsObjects(conf, section);

    return {
        name: section.name,
        path: getFirstParam(section, PATH_KEYS) ?? "",
        comment: getParam(section, "comment") ?? "",
        readOnly: resolveReadOnly(conf, section),
        browseable: resolveFlag(conf, section, BROWSEABLE_KEYS, true),
        guestOk: resolveFlag(conf, section, GUEST_KEYS, false),
        validUsers: parseValidUsers(getParam(section, "valid users")),
        isSpecial: SPECIAL_SECTIONS.includes(section.key),
        available: resolveFlag(conf, section, AVAILABLE_KEYS, true),
        writeList: parseValidUsers(getFirstParam(section, WRITE_LIST_KEYS)),
        hostsAllow: getFirstParam(section, HOSTS_ALLOW_KEYS) ?? "",
        hostsDeny: getFirstParam(section, HOSTS_DENY_KEYS) ?? "",
        forceGroup: getFirstParam(section, FORCE_GROUP_KEYS) ?? "",
        createMask: getFirstParam(section, CREATE_MASK_KEYS) ?? "",
        directoryMask: getFirstParam(section, DIRECTORY_MASK_KEYS) ?? "",
        recycleBin: modules.includes(RECYCLE_MODULE),
        /* The module alone only adds Apple metadata support; it is the
           option that turns the share into a backup target. */
        timeMachine: modules.includes("fruit") &&
            parseBool(getParam(section, "fruit:time machine")) === true,
        timeMachineMaxSize: getParam(section, "fruit:time machine max size") ?? "",
    };
}

export function readShares(conf: SambaConf): Share[] {
    return shareSections(conf).map(section => readShare(conf, section));
}

/* Turn the VFS modules this page manages on or off for one share,
   preserving both the modules it does not manage and the ones the share
   inherits from [global]. */
function writeShareVfs(conf: SambaConf, section: ConfSection, share: Share): void {
    const inherited = effectiveVfsObjects(conf, section);
    const modules = inherited.filter(m => !MANAGED_MODULES.includes(m));

    if (share.recycleBin) {
        modules.push(RECYCLE_MODULE);
        for (const [key, value] of Object.entries(RECYCLE_PARAMS))
            setParam(section, key, value);
    } else {
        deleteParamFamily(section, "recycle:");
    }

    if (share.timeMachine) {
        modules.push(...FRUIT_MODULES);
        for (const [key, value] of Object.entries(FRUIT_PARAMS))
            setParam(section, key, value);
        setOrDeleteParam(section, "fruit:time machine max size", share.timeMachineMaxSize.trim());
    } else {
        deleteParamFamily(section, "fruit:");
    }

    /* A share with no list of its own keeps inheriting, rather than
       gaining a copy of [global]'s that would then drift out of step. */
    const hasOwnList = getFirstParam(section, VFS_KEYS) !== undefined;
    const globalModules = vfsObjects(getSection(conf, GLOBAL));
    const sameAsGlobal = [...modules].sort().join(" ") === [...globalModules].sort().join(" ");
    if (!hasOwnList && sameAsGlobal)
        return;

    /* An empty list removes the parameter rather than writing a blank one,
       so the share goes back to inheriting [global] — which is what
       turning off the last module this page manages should mean. */
    setOrDeleteParam(section, VFS_KEYS[0], modules.join(" "));
    deleteParam(section, VFS_KEYS[1]);
}

/* Write a share back into the config, creating or renaming its section as
   needed and leaving every parameter this UI doesn't manage alone. */
export function writeShare(conf: SambaConf, share: Share, previousName?: string): void {
    let section = previousName ? getSection(conf, previousName) : undefined;
    if (section && previousName && previousName.toLowerCase() !== share.name.toLowerCase())
        renameSection(section, share.name);
    if (!section)
        section = addSection(conf, share.name);

    const write = (keys: string[], value: string) => {
        setParam(section, keys[0], value);
        /* Drop synonyms so they can't contradict what we just wrote. */
        for (const key of keys.slice(1))
            deleteParam(section, key);
    };

    /* The same, but for parameters that are simply absent when unset,
       rather than having a value for "off". */
    const writeOptional = (keys: string[], value: string) => {
        setOrDeleteParam(section, keys[0], value);
        for (const key of keys.slice(1))
            deleteParam(section, key);
    };

    if (!share.isSpecial)
        write(PATH_KEYS, share.path);
    setOrDeleteParam(section, "comment", share.comment);

    write(READ_ONLY_KEYS, share.readOnly ? "yes" : "no");
    for (const key of WRITEABLE_KEYS)
        deleteParam(section, key);
    write(BROWSEABLE_KEYS, share.browseable ? "yes" : "no");
    write(GUEST_KEYS, share.guestOk ? "yes" : "no");

    /* `available` defaults to yes, so an available share needs no
       parameter at all; only turning one off has to be recorded. */
    writeOptional(AVAILABLE_KEYS, share.available ? "" : "no");

    setOrDeleteParam(section, "valid users", share.validUsers.join(", "));
    writeOptional(WRITE_LIST_KEYS, share.writeList.join(", "));
    writeOptional(HOSTS_ALLOW_KEYS, share.hostsAllow.trim());
    writeOptional(HOSTS_DENY_KEYS, share.hostsDeny.trim());
    writeOptional(FORCE_GROUP_KEYS, share.forceGroup.trim());
    writeOptional(CREATE_MASK_KEYS, share.createMask.trim());
    writeOptional(DIRECTORY_MASK_KEYS, share.directoryMask.trim());

    writeShareVfs(conf, section, share);

    /* Samba's `map to guest` defaults to Never, which rejects the
       anonymous login `guest ok` is supposed to allow. Ticking the box
       would otherwise produce a share that looks configured for guests
       and turns every one of them away. */
    if (share.guestOk && !guestLoginsAccepted(conf))
        acceptGuestLogins(conf);
}

/* --- Guest logins ----------------------------------------------------- */

/* Whether the server maps an unknown user to the guest account at all.
   Without this no `guest ok` share can be opened anonymously. */
export function guestLoginsAccepted(conf: SambaConf): boolean {
    const value = getParam(getSection(conf, GLOBAL), "map to guest") ?? "never";
    return normalizeKey(value) !== "never";
}

export function acceptGuestLogins(conf: SambaConf): void {
    const section = getSection(conf, GLOBAL) ?? addSection(conf, GLOBAL);
    /* "Bad User" maps an unknown name to the guest account, and leaves a
       wrong password for a known name as the failure it is. */
    setParam(section, "map to guest", "Bad User");
}

/* The account a guest connection runs as. `valid users` is checked
   against this account like any other, which is easy to trip over: a
   share that allows guests but lists particular users turns guests away
   unless this account is on the list. */
export function guestAccount(conf: SambaConf): string {
    return getParam(getSection(conf, GLOBAL), "guest account") || "nobody";
}

/* Whether this share's user list shuts out the guests it claims to
   allow. `guest` is the account guests connect as, from guestAccount();
   taking it as an argument rather than re-deriving it lets the dialog
   ask about a share it is still editing, which has no config yet. */
export function guestsShutOut(share: Share, guest: string): boolean {
    return share.guestOk && share.validUsers.length > 0 && !share.validUsers.includes(guest);
}

/* The accounts a share names, and so the ones its folder has to let in:
   whoever may connect, plus anyone who may write even when it is read
   only. */
export function sharePrincipals(share: Share): string[] {
    return [...new Set([...share.validUsers, ...share.writeList])];
}

/* --- [global] --------------------------------------------------------- */

/* The [global] body as editable text, without the `[global]` header. */
export function globalText(conf: SambaConf): string {
    const section = getSection(conf, GLOBAL);
    if (!section)
        return "";
    return section.entries.flatMap(e => e.lines).join("\n")
            .replace(/\n+$/, "");
}

/* Replace the whole [global] body with the given text. */
export function setGlobalText(conf: SambaConf, text: string): void {
    const section = getSection(conf, GLOBAL) ?? addSection(conf, GLOBAL);
    const parsed = parseConf(text);
    section.entries = parsed.sections.flatMap(s => [
        ...s.headerLines.map(line => ({ kind: "other" as const, lines: [line] })),
        ...s.entries,
    ]);
}

/* --- Advanced logging (the full_audit VFS module) --------------------- */

/* A deliberately narrow set of operations: session lifecycle plus the
 * calls that actually change file content or structure.
 *
 *   connect / disconnect  session lifecycle, including failed logins
 *   mkdirat               directory created
 *   renameat              renamed or moved
 *   unlinkat              deleted (covers files and directories both;
 *                         there is no separate rmdir operation)
 *   pwrite                bytes written
 *   ftruncate             truncate/resize, which is how many applications
 *                         save a file, so this catches writes pwrite alone
 *                         would miss
 *   offload_write_recv    server-side copy, which never streams bytes
 *                         through pwrite
 *
 * openat and create_file are left out on purpose: in SMB every file
 * access is an open, so auditing them fires on plain reads, directory
 * listings and thumbnailing, which is where full_audit noise comes from.
 * A newly written file still shows up through pwrite/ftruncate.
 *
 * Every name above must exist in the running Samba's vfs_full_audit(8):
 * an unrecognized operation makes full_audit fail to build the VFS stack
 * at connect time, which silently breaks every client connection.
 *
 * Messages go to syslog, and so to the journal tagged smbd_audit, which
 * means no Samba log file settings have to change.
 */
const AUDIT_PARAMS: Record<string, string> = {
    "full_audit:prefix": "%u|%I|%S",
    "full_audit:success": "connect disconnect mkdirat renameat unlinkat pwrite ftruncate offload_write_recv",
    "full_audit:failure": "connect",
    "full_audit:facility": "LOCAL5",
    "full_audit:priority": "NOTICE",
};

export const AUDIT_IDENTIFIER = "smbd_audit";

export function isAuditEnabled(conf: SambaConf): boolean {
    return vfsObjects(getSection(conf, GLOBAL)).includes(AUDIT_MODULE);
}

export function setAuditEnabled(conf: SambaConf, enabled: boolean): void {
    const section = getSection(conf, GLOBAL) ?? addSection(conf, GLOBAL);
    const modules = vfsObjects(section).filter(m => m !== AUDIT_MODULE);

    if (enabled) {
        modules.push(AUDIT_MODULE);
        for (const [key, value] of Object.entries(AUDIT_PARAMS))
            setParam(section, key, value);
    } else {
        deleteParamFamily(section, "full_audit:");
    }

    /* Leave any other VFS modules (recycle, shadow_copy2, ...) in place. */
    setOrDeleteParam(section, VFS_KEYS[0], modules.join(" "));
    deleteParam(section, VFS_KEYS[1]);
}
