# Cockpit Samba

A [Cockpit](https://cockpit-project.org/) page for managing Samba file shares:
create and edit shares, give local accounts access to them, watch who is
connected, and keep the server configuration in order — without leaving the web
console.

<img width="1731" height="748" alt="Screenshot" src="https://github.com/user-attachments/assets/38a35565-a132-4190-b91c-66120f9ae022" />

## Requirements

- Cockpit
- Samba (`smbd`), plus `smbpasswd`, `pdbedit`, `testparm` and `smbstatus`, which
  ship with it

If Samba is not installed, the page offers to install it through PackageKit.

## Installing

Every release carries a Debian package, an RPM, a zip of the built page, and a
source tarball, on the [releases
page](https://github.com/hrhnick/cockpit-samba/releases).

The packages are named without a version, so the newest one always has the same
address and can be fetched by a script:

```sh
BASE=https://github.com/hrhnick/cockpit-samba/releases/latest/download

# Debian, Ubuntu
curl -LO $BASE/cockpit-samba-latest.deb && sudo apt install ./cockpit-samba-latest.deb

# Fedora, RHEL, CentOS
sudo dnf install $BASE/cockpit-samba-latest.rpm
```

Which version you actually got is recorded in the package itself:
`dpkg-deb -f cockpit-samba-latest.deb Version`, or `rpm -qp --qf '%{VERSION}\n'`.

On a distribution without a package, use the zip, which unpacks to a single
`samba` directory:

```sh
curl -LO $BASE/cockpit-samba-latest.zip

# for everyone on the machine
sudo unzip cockpit-samba-latest.zip -d /usr/share/cockpit/

# or for the current user only
unzip cockpit-samba-latest.zip -d ~/.local/share/cockpit/
```

Reload the browser and the page appears under *Samba shares*.

## Features

**Shares**

- Create, edit, rename and delete shares
- Read-only or read-write, guest access, and whether the share is visible when
  browsing the server
- Restrict a share to particular users and groups, with completion from the
  accounts and groups on the machine
- Expand a share to see who may connect, how many clients are connected, and the
  network address to use from a client
- Detects a share whose folder is missing or which SELinux is blocking, and
  offers to fix either

**Access** — *Manage access*, in the server card's menu

- Give a local account a Samba password, change it, or take its access away
- See at a glance which accounts can connect
- Links to Cockpit's Accounts page for creating the accounts themselves

**Server**

- Status, version and uptime; start, stop and restart; start on boot
- Who is connected, which shares they have open, and whether the connection is
  encrypted and signed
- Edit the `[global]` section, with `testparm` validating every change
- Download the configuration, or restore one from a file
- Follow the Samba journal, and optionally log file activity through the
  `full_audit` VFS module

## How it treats your configuration

`/etc/samba/smb.conf` is parsed into sections that remember their original text,
and a change rewrites only the lines it touches. Comments, `include` directives
and parameters this page does not manage are left exactly as they were.

Every write is checked with `testparm` first, the previous file is copied to
`/etc/samba/smb.conf.bak`, and the running server is asked to reload. The page
follows the file, so a change made in a text editor, or by another Cockpit
session, shows up here without a refresh.

## Development

```sh
make                  # fetch Cockpit's shared components and build into dist/
npm run watch         # rebuild on change
make devel-install    # symlink dist/ into ~/.local/share/cockpit
```

Packages, if you want to build them by hand:

```sh
make zip              # the built page, ready to unpack into /usr/share/cockpit
make deb              # needs build-essential, debhelper, fakeroot, gettext
make rpm              # needs rpm-build and the spec's BuildRequires
```

Then open Cockpit at `https://localhost:9090` and go to *Samba shares*.

Checks:

```sh
npm test              # smb.conf model, and every dialog mounts
npm run typecheck     # tsc
npm run eslint
npm run stylelint
make check            # browser integration tests, needs a test VM
```

`pkg/lib` is checked out from the [Cockpit
repository](https://github.com/cockpit-project/cockpit) by the Makefile at the
commit pinned in `COCKPIT_REPO_COMMIT`; the PatternFly versions in
`package.json` are kept in step with the ones that checkout is built against.

## License

LGPL-2.1-or-later
