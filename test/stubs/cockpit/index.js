const gettext = (s, s2) => (s2 === undefined ? s : s2);
const format = (fmt, ...args) => String(fmt).replace(/\$(\d)/g, (_m, i) => String(args[i] ?? ''));
const spawn = () => { const p = Promise.resolve(""); p.stream = () => p; p.input = () => p; p.close = () => {}; return p };
export default {
    gettext, format, spawn,
    ngettext: (a, b, n) => (n === 1 ? a : b),
    file: () => ({ read: () => Promise.resolve(""), replace: () => Promise.resolve(""), watch: () => ({ remove() {} }), close() {} }),
    jump: () => {}, transport: { host: "localhost" }, location: { go() {}, replace() {} },
    addEventListener: () => {}, removeEventListener: () => {},
    user: () => Promise.resolve({ name: "test" }),
    dbus: () => ({ proxy: () => ({ wait: () => {}, addEventListener: () => {} }), subscribe: () => ({ remove() {} }), call: () => Promise.resolve([]), close() {} }),
};
export { gettext, format, spawn };
