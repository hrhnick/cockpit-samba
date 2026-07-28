#!/usr/bin/python3
# Copyright (C) 2026 cockpit-samba contributors
# SPDX-License-Identifier: MIT

"""Put the version from the newest git tag into package.json and package-lock.json.

Everything that ships already takes its version from `git describe`: the
tarball name, the RPM, the deb. package.json was the one place carrying a
number a human had to remember to bump, so it spent most of its life
disagreeing with the release it sat in. This removes the remembering.

The newest tag rather than a full `git describe`: between releases the
latter produces something like 2.0.6-3-gabc1234, which is not a version
npm accepts. Naming the last release is both valid and true.

Rewrites only the version strings, rather than reserialising the JSON, so
a 260 KB lockfile keeps its formatting and this stays reviewable as a
one-line diff. Does nothing at all when the version is already right,
when the tree has no tags, or when it is not a git checkout — a source
tarball unpacked somewhere must still build.
"""

import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION_RE = re.compile(r'^\d+(\.\d+)*$')


def newest_tag() -> str | None:
    try:
        tag = subprocess.run(["git", "describe", "--tags", "--abbrev=0"],
                             cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        # No tags yet, or no git: leave whatever is written alone.
        return None

    if not VERSION_RE.match(tag):
        print(f"sync-version: {tag} is not a plain version number, leaving package.json alone",
              file=sys.stderr)
        return None
    return tag


def replace_version(path: pathlib.Path, version: str, count: int) -> bool:
    """Set the first `count` version strings in the file. Returns whether it changed."""
    text = path.read_text()
    # The root version fields come first in both files; a dependency that
    # happens to share the old version number appears further down.
    updated, changed = re.subn(r'"version": "[^"]*"', f'"version": "{version}"', text, count=count)
    if not changed or updated == text:
        return False
    path.write_text(updated)
    return True


def main() -> int:
    version = newest_tag()
    if version is None:
        return 0

    package = ROOT / "package.json"
    lock = ROOT / "package-lock.json"

    if json.loads(package.read_text()).get("version") == version:
        return 0

    changed = replace_version(package, version, count=1)
    # The lockfile repeats it: once at the top, once for the root package.
    if lock.exists():
        changed |= replace_version(lock, version, count=2)

    if changed:
        print(f"sync-version: package.json is now {version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
