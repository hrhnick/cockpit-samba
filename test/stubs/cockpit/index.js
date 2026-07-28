const gettext = (s, s2) => (s2 === undefined ? s : s2);
const format = (fmt, ...args) => String(fmt).replace(/\$(\d)/g, (_m, i) => String(args[i] ?? ''));
const spawn = () => { const p = Promise.resolve(""); p.stream = () => p; p.input = () => p; p.close = () => {}; return p };

/* Cockpit turns plain objects into event emitters with this, and the
   modules that use it (superuser, and so anything reaching PackageKit)
   call it while they are being imported — so leaving it out does not fail
   a test, it stops the bundle loading at all. */
const event_target = obj => Object.assign(obj, {
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
});

const format_bytes = bytes => `${bytes} B`;

export default {
    gettext, format, spawn, event_target, format_bytes,
    ngettext: (a, b, n) => (n === 1 ? a : b),
    file: () => ({ read: () => Promise.resolve(""), replace: () => Promise.resolve(""), watch: () => ({ remove() {} }), close() {} }),
    jump: () => {}, transport: { host: "localhost" }, location: { go() {}, replace() {} },
    addEventListener: () => {}, removeEventListener: () => {},
    hidden: false,
    user: () => Promise.resolve({ name: "test" }),
    dbus: () => ({ proxy: () => ({ wait: () => {}, addEventListener: () => {} }), subscribe: () => ({ remove() {} }), call: () => Promise.resolve([]), close() {} }),
};
export { gettext, format, spawn, event_target, format_bytes };
