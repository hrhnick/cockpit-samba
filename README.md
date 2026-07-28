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
- Turn a share off without deleting it
- Restrict a share to particular users and groups, with completion from the
  accounts and groups on the machine, and name people who may write even on a
  read-only share
- Limit a share to particular client addresses or subnets
- Choose the group and permissions new files get, so several people can work in
  one folder
- Recycle bin, so a file deleted over the network is moved aside rather than
  destroyed
- Time Machine, which offers the share to macOS as a backup destination, with
  a cap on how much space the backups may take
- Warns about combinations that quietly do nothing, like a guest share whose
  user list keeps guests out
- Expand a share to see who may connect, free space, how many clients are
  connected, and the network address to copy into a client
- Detects a share whose folder is missing or which SELinux is blocking, and
  offers to fix either
- *Fix folder permissions* gives the share's users access to the folder itself,
  which changing the user list does not do on its own. Directories the system
  needs — `/`, `/etc`, `/home`, `/usr` and the rest — are refused: closing one
  of those to everyone but a share's users takes everything underneath it
  along, and on `/` that is the whole machine

**Access** — *Manage access*, in the server card's menu

- Give a local account a Samba password, change it, or take its access away
- See at a glance which accounts can connect, and which shares each one
  would reach
- Links to Cockpit's Accounts page for creating the accounts themselves

**Server**

- Status, version and uptime; start, stop and restart; start on boot
- Windows discovery: one switch installs and runs
  [wsdd](https://github.com/christgau/wsdd), without which the server never
  appears in Windows' Network view. Not every distribution packages it —
  Raspberry Pi OS and older Debian carry neither `wsdd` nor `wsdd2` — and
  where none is available the page says so instead of offering the switch
- Notices a firewalld that is blocking SMB and offers to open it, and shows
  the warnings `testparm` has about the configuration
- Who is connected, which shares they have open, and whether the connection is
  encrypted and signed; disconnect a client
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

Two things are worth knowing:

- **`include` is not followed.** Shares defined in an included file are kept as
  they are, but they are not listed here and cannot be edited from this page.
  Only shares written in `smb.conf` itself appear.
- **`vfs objects` is not additive in Samba.** A share that sets it overrides
  `[global]` rather than adding to it. When this page has to write that
  parameter on a share — for the recycle bin or Time Machine — it carries the
  modules the share was inheriting across, so file activity logging is not
  silently switched off for that one share.

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
make check-patternfly # PatternFly matches the vendored pkg/lib
make check            # browser integration tests, needs a test VM
```

Everything except `make check` runs on every push and pull request, through
`.github/workflows/checks.yml`.

`make check` is run by hand, on a machine that has libvirt. It boots a real VM
and drives a browser against the page, and the test framework it uses expects a
libvirt daemon to already be listening — which a developer's machine and
Cockpit's own CI both provide, and a GitHub Actions container does not. Running
it in Actions was tried and abandoned; the routes that would work are Packit and
Testing Farm, which provision real machines.

`pkg/lib` is checked out from the [Cockpit
repository](https://github.com/cockpit-project/cockpit) by the Makefile at the
commit pinned in `COCKPIT_REPO_COMMIT`, and its components are written against
the PatternFly release Cockpit used at that commit. `package.json` has to name
those same versions: a mismatch still builds, and shows up only as components
that are styled wrong. `make check-patternfly` compares the two.

That matters most for the `cockpit-lib-update` workflow, which moves the pin
weekly and does not touch `package.json`. Its pull request is opened with
`GITHUB_TOKEN`, which does not start the checks workflow, so run that workflow
against the branch by hand before merging.

There are no translations. `po/` is created by the Makefile when it is needed;
adding a `.po` file there is all that is required to start one.

Versions come from git tags and nowhere else. The tarball, the RPM and the deb
take theirs from `git describe`, and `packaging/sync-version.py` — which the
Makefile runs on every build — copies the newest tag into `package.json` and
`package-lock.json`. So releasing is just tagging: build once afterwards and
commit whatever the version bump touched.
