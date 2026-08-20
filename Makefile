# extract name from package.json
PACKAGE_NAME := $(shell awk '/"name":/ {gsub(/[",]/, "", $$2); print $$2}' package.json)
RPM_NAME := cockpit-$(PACKAGE_NAME)
# --tags because a release published from the GitHub web interface creates a
# lightweight tag, which plain `git describe` ignores; without it the version
# silently falls back to 1 and every artifact is misnamed.
VERSION := $(shell T=$$(git describe --tags 2>/dev/null) || T=1; echo $$T | tr '-' '.')
ifeq ($(TEST_OS),)
TEST_OS = centos-9-stream
endif
export TEST_OS
TARFILE=$(RPM_NAME)-$(VERSION).tar.xz
ZIPFILE=$(RPM_NAME)-$(VERSION).zip
NODE_CACHE=$(RPM_NAME)-node-$(VERSION).tar.xz
SPEC=$(RPM_NAME).spec
PREFIX ?= /usr/local
APPSTREAMFILE=org.cockpit_project.$(subst -,_,$(PACKAGE_NAME)).metainfo.xml
VM_IMAGE=$(CURDIR)/test/images/$(TEST_OS)
# stamp file to check for node_modules/: npm ci leaves this behind, so a
# fresh checkout installs and an up-to-date tree does not
NODE_MODULES_TEST=node_modules/.package-lock.json
# build.js ran in non-watch mode
DIST_TEST=runtime-npm-modules.txt
# one example file in pkg/lib to check if it was already checked out
COCKPIT_REPO_STAMP=pkg/lib/cockpit-po-plugin.js
# common arguments for tar, mostly to make the generated tarballs reproducible
TAR_ARGS = --sort=name --mtime "@$(shell git show --no-patch --format='%at')" --mode=go=rX,u+rw,a-s --numeric-owner --owner=0 --group=0

all: $(DIST_TEST)

# checkout common files from Cockpit repository required to build this project;
# this has no API stability guarantee, so check out a stable tag when you start
# a new project, use the latest release, and update it from time to time
COCKPIT_REPO_FILES = \
	pkg/lib \
	test/common \
	tools/node-modules \
	$(NULL)

COCKPIT_REPO_URL = https://github.com/cockpit-project/cockpit.git
COCKPIT_REPO_COMMIT = dc336f08357f570f17012a1e15bf36a7303d7fc4 # 366 + 18 commits

$(COCKPIT_REPO_FILES): $(COCKPIT_REPO_STAMP)
COCKPIT_REPO_TREE = '$(strip $(COCKPIT_REPO_COMMIT))^{tree}'
$(COCKPIT_REPO_STAMP): Makefile
	@git rev-list --quiet --objects $(COCKPIT_REPO_TREE) -- 2>/dev/null || \
	    git fetch --no-tags --no-write-fetch-head --depth=1 $(COCKPIT_REPO_URL) $(COCKPIT_REPO_COMMIT)
	git archive $(COCKPIT_REPO_TREE) -- $(COCKPIT_REPO_FILES) | tar x

#
# i18n
#

# There are no translations yet, so po/ holds nothing git can track and is
# not there in a fresh checkout; every rule that writes into it makes it.
LINGUAS=$(basename $(notdir $(wildcard po/*.po)))

po/$(PACKAGE_NAME).js.pot:
	mkdir -p po
	xgettext --default-domain=$(PACKAGE_NAME) --output=- --language=C --keyword= \
		--add-comments=Translators: \
		--keyword=_:1,1t --keyword=_:1c,2,2t --keyword=C_:1c,2 \
		--keyword=N_ --keyword=NC_:1c,2 \
		--keyword=gettext:1,1t --keyword=gettext:1c,2,2t \
		--keyword=ngettext:1,2,3t --keyword=ngettext:1c,2,3,4t \
		--keyword=gettextCatalog.getString:1,3c --keyword=gettextCatalog.getPlural:2,3,4c \
		--from-code=UTF-8 $$(find src/ -name '*.[jt]s' -o -name '*.[jt]sx') | \
		sed '/^#/ s/, c-format//' > $@

po/$(PACKAGE_NAME).html.pot: $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP)
	mkdir -p po
	pkg/lib/html2po -o $@ $$(find src -name '*.html')

po/$(PACKAGE_NAME).manifest.pot: $(COCKPIT_REPO_STAMP)
	mkdir -p po
	pkg/lib/manifest2po -o $@ src/manifest.json

po/$(PACKAGE_NAME).metainfo.pot: $(APPSTREAMFILE)
	mkdir -p po
	xgettext --default-domain=$(PACKAGE_NAME) --output=$@ $<

po/$(PACKAGE_NAME).pot: po/$(PACKAGE_NAME).html.pot po/$(PACKAGE_NAME).js.pot po/$(PACKAGE_NAME).manifest.pot po/$(PACKAGE_NAME).metainfo.pot
	msgcat --sort-output --output-file=$@ $^

po/LINGUAS:
	mkdir -p po
	echo $(LINGUAS) | tr ' ' '\n' > $@

#
# Build/Install/dist
#

$(SPEC): packaging/$(SPEC).in $(DIST_TEST)
	provides=$$(awk '{print "Provides: bundled(npm(" $$1 ")) = " $$2}' runtime-npm-modules.txt); \
	awk -v p="$$provides" '{gsub(/%{VERSION}/, "$(VERSION)"); gsub(/%{NPM_PROVIDES}/, p)}1' $< > $@

packaging/arch/PKGBUILD: packaging/arch/PKGBUILD.in
	sed 's/VERSION/$(VERSION)/; s/SOURCE/$(TARFILE)/' $< > $@

# Dated from the last commit rather than "now", so that rebuilding the same
# commit produces the same changelog.
packaging/debian/changelog: packaging/debian/changelog.in
	sed 's/VERSION/$(VERSION)/; s/DATE/$(shell date -R -d @$$(git show --no-patch --format=%at))/' $< > $@

$(DIST_TEST): $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP) $(shell find src/ -type f) package.json build.js
	NODE_ENV=$(NODE_ENV) ./build.js

watch: $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP)
	NODE_ENV=$(NODE_ENV) ./build.js --watch

clean:
	rm -rf dist/
	rm -f $(SPEC) packaging/arch/PKGBUILD packaging/debian/changelog
	rm -f *.deb *.zip
	rm -f po/LINGUAS
	rm -f metafile.json runtime-npm-modules.txt

install: $(DIST_TEST) po/LINGUAS
	mkdir -p $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)
	cp -r dist/* $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)
	mkdir -p $(DESTDIR)$(PREFIX)/share/metainfo/
	msgfmt --xml -d po \
		--template $(APPSTREAMFILE) \
		-o $(DESTDIR)$(PREFIX)/share/metainfo/$(APPSTREAMFILE)

# this requires a built source tree and avoids having to install anything system-wide
devel-install: $(DIST_TEST)
	mkdir -p ~/.local/share/cockpit
	ln -s `pwd`/dist ~/.local/share/cockpit/$(PACKAGE_NAME)

# assumes that there was symlink set up using the above devel-install target,
# and removes it
devel-uninstall:
	rm -f ~/.local/share/cockpit/$(PACKAGE_NAME)

print-version:
	@echo "$(VERSION)"

dist: $(TARFILE)
	@ls -1 $(TARFILE)

# when building a distribution tarball, call bundler with a 'production' environment
# we don't ship node_modules for license and compactness reasons; we ship a
# pre-built dist/ (so it's not necessary) and ship package-lock.json (so that
# node_modules/ can be reconstructed if necessary)
$(TARFILE): export NODE_ENV=production
$(TARFILE): $(DIST_TEST) $(SPEC) packaging/arch/PKGBUILD packaging/debian/changelog
	if type appstream-util >/dev/null 2>&1; then appstream-util validate-relax --nonet *.metainfo.xml; fi
	tar --xz $(TAR_ARGS) -cf $(TARFILE) --transform 's,^,$(RPM_NAME)/,' \
		--exclude packaging/$(SPEC).in --exclude node_modules \
		$$(git ls-files) $(COCKPIT_REPO_FILES) $(DIST_TEST) \
		$(SPEC) packaging/arch/PKGBUILD packaging/debian/changelog dist/

$(NODE_CACHE): $(NODE_MODULES_TEST)
	tools/node-modules runtime-tar $(NODE_CACHE)

node-cache: $(NODE_CACHE)

# convenience target for developers
srpm: $(TARFILE) $(NODE_CACHE) $(SPEC)
	rpmbuild -bs \
	  --define "_sourcedir `pwd`" \
	  --define "_srcrpmdir `pwd`" \
	  $(SPEC)

# convenience target for developers
rpm: $(TARFILE) $(NODE_CACHE) $(SPEC)
	mkdir -p "`pwd`/output"
	mkdir -p "`pwd`/rpmbuild"
	rpmbuild -bb \
	  --define "_sourcedir `pwd`" \
	  --define "_specdir `pwd`" \
	  --define "_builddir `pwd`/rpmbuild" \
	  --define "_srcrpmdir `pwd`" \
	  --define "_rpmdir `pwd`/output" \
	  --define "_buildrootdir `pwd`/build" \
	  $(SPEC)
	find `pwd`/output -name '*.rpm' -printf '%f\n' -exec mv {} . \;
	# -f because rpm removes the buildroot itself once the package is built,
	# so `build` is often already gone by the time we get here
	rm -rf "`pwd`/rpmbuild" "`pwd`/output" "`pwd`/build"

# A zip of the built page, for installing by hand on a distribution we do not
# package for. It unpacks to a single "samba" directory, so extracting it into
# /usr/share/cockpit (system wide) or ~/.local/share/cockpit (one user) is the
# whole installation. python3's zipfile is used rather than zip(1), which is
# not installed everywhere this runs.
$(ZIPFILE): $(DIST_TEST)
	rm -f $@
	rm -rf tmp/zip
	mkdir -p tmp/zip
	cp -r dist tmp/zip/$(PACKAGE_NAME)
	cd tmp/zip && python3 -m zipfile -c $(CURDIR)/$@ $(PACKAGE_NAME)
	rm -rf tmp/zip
	@ls -1 $@

zip: $(ZIPFILE)

# convenience target for developers: build a .deb from the release tarball,
# which is the same source a distribution would build from
deb: $(TARFILE)
	rm -rf tmp/deb
	mkdir -p tmp/deb
	tar -C tmp/deb -xf $(TARFILE)
	mv tmp/deb/$(RPM_NAME)/packaging/debian tmp/deb/$(RPM_NAME)/debian
	rm -f tmp/deb/$(RPM_NAME)/debian/changelog.in
	cd tmp/deb/$(RPM_NAME) && dpkg-buildpackage --build=binary --no-sign
	mv tmp/deb/*.deb .
	rm -rf tmp/deb
	@ls -1 *.deb

# build a VM with locally built distro pkgs installed
# disable networking, VM images have mock/pbuilder with the common build dependencies pre-installed
$(VM_IMAGE): export XZ_OPT=-0
$(VM_IMAGE): $(TARFILE) $(NODE_CACHE) bots test/vm.install
	bots/image-customize --no-network --fresh \
		--upload $(NODE_CACHE):/var/tmp/ --build $(TARFILE) \
		--script $(CURDIR)/test/vm.install $(TEST_OS)

# convenience target for the above
vm: $(VM_IMAGE)
	@echo $(VM_IMAGE)

# convenience target to print the filename of the test image
print-vm:
	@echo $(VM_IMAGE)

# convenience target to setup all the bits needed for the integration tests
# without actually running them
prepare-check: $(NODE_MODULES_TEST) $(VM_IMAGE) test/common

# run the browser integration tests
# this will run all tests/check-* and format them as TAP
check: prepare-check
	test/common/run-tests ${RUN_TESTS_OPTIONS}

# run the unit tests for the smb.conf model; these need no VM
unit-tests: $(NODE_MODULES_TEST)
	npm test

# Our PatternFly has to match the one pkg/lib was built against; see the
# script for why a mismatch is worth failing over.
check-patternfly: $(COCKPIT_REPO_STAMP)
	node test/check-patternfly.js

# checkout Cockpit's bots for standard test VM images and API to launch them
bots: $(COCKPIT_REPO_STAMP)
	test/common/make-bots

# package.json's version comes from the newest git tag rather than from
# anyone remembering to bump it. Order-only (after the |) so that running
# it cannot by itself make anything rebuild; the script writes nothing
# when the version is already right.
.PHONY: sync-version
sync-version:
	@packaging/sync-version.py

# Install exactly what the committed package-lock.json pins, so every
# checkout, CI run and release builds from the same dependency tree. To
# update dependencies, edit package.json, run `npm install`, and commit
# the changed lockfile with it.
$(NODE_MODULES_TEST): package.json package-lock.json | sync-version
	# unset NODE_ENV, skips devDependencies otherwise; this often hangs, so try a few times
	for _ in `seq 3`; do timeout 10m env -u NODE_ENV npm ci && exit 0; done; exit 1

.PHONY: all clean install sync-version devel-install devel-uninstall print-version dist node-cache rpm prepare-check check check-patternfly vm print-vm
