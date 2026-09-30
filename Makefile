# Pinned deliberately. openapi-generator ships no patch releases, so every
# upgrade is a minor, which is the tier its own policy says may change
# template-bound variables, and scripts/fix-generated.mjs anchors on what the
# templates emit. Bumping this is a human-reads-the-diff operation, never
# automatic. Same version as sdk-rust, so one jar serves both.
OPENAPI_GENERATOR_VERSION := 7.25.0

# Pinned for the same reason: oasdiff decides whether we publish. The release
# workflow runs the binary this builds (see print-oasdiff), so this is the
# only pin.
OASDIFF_VERSION := 1.32.1
# Versioned, like the generator jar: an unversioned path would keep serving a
# stale binary after OASDIFF_VERSION is bumped.
OASDIFF          := /tmp/oasdiff-$(OASDIFF_VERSION)
# oasdiff ships one universal darwin build and per-arch linux builds.
OASDIFF_OS       := $(shell uname -s | tr 'A-Z' 'a-z')
OASDIFF_PLATFORM := $(if $(filter darwin,$(OASDIFF_OS)),darwin_all,$(OASDIFF_OS)_$(shell uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/'))

# The oldest TypeScript a consumer may compile against us with. The README
# promises it; `make consumer` is the only thing that checks it.
CONSUMER_TS_VERSION := 5.0.4

PACKAGE    := @incident-io/sdk
SCHEMA_URL := https://api.incident.io/v1/openapiV3.json
GENERATOR  := /tmp/openapi-generator-cli-$(OPENAPI_GENERATOR_VERSION).jar
TSC        := node_modules/.bin/tsc
# $$ so two runs on one machine do not collide.
SCRATCH    := /tmp/sdk-ts-$(shell echo $$$$)

.DEFAULT_GOAL := help
# A failed download would otherwise leave a partial jar or an empty oasdiff at
# its versioned path, which every later run then treats as already built.
.DELETE_ON_ERROR:
.PHONY: help fetch check-schema generate build verify test consumer surface template-drift oasdiff print-oasdiff clean

help:
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# -L because without it a redirect is a silent success writing zero bytes,
# which parses as an empty schema. OUT lets the release workflow fetch to a
# scratch path so it still has the previous schema to diff against.
OUT ?= openapi.json

fetch: ## Fetch the live schema (OUT= to write elsewhere)
	curl -sfSL $(SCHEMA_URL) -o $(OUT)

# curl -f fails on an HTTP error but not on a 200 with an empty or truncated
# body, and oasdiff reads an empty file as every path having been removed,
# which it rates breaking. Check the bytes are a schema before anything
# downstream trusts them.
FILE ?= openapi.json

check-schema: ## Fail unless FILE= parses as a schema with a plausible number of paths
	@node -e 'const n = Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).paths ?? {}).length; if (n < 100) { console.error(`only $${n} paths in the fetched schema`); process.exit(1) } console.log(`$${n} paths`)' $(FILE)

$(GENERATOR):
	curl -sfSL -o $@ \
		https://repo1.maven.org/maven2/org/openapitools/openapi-generator-cli/$(OPENAPI_GENERATOR_VERSION)/openapi-generator-cli-$(OPENAPI_GENERATOR_VERSION).jar

# npm ci only when the lockfile moved, so repeated make runs don't reinstall.
node_modules: package-lock.json
	npm ci --no-audit --no-fund
	@touch node_modules

# src/ is entirely generated, so it is cleared first: the generator only
# writes, never deletes, and an endpoint or model removed upstream would
# otherwise leave a stale file behind, still exported and still compiled.
#
# modelPropertyNaming and paramNaming keep the API's own snake_case names, so
# a field is spelled the same here as in the API reference, and nothing is
# renamed on the way in or out.
generate: openapi.json $(GENERATOR) ## Regenerate the client from the committed schema
	rm -rf src
	@mkdir -p $(SCRATCH)
	node scripts/prepare-spec.mjs openapi.json $(SCRATCH)/openapi.json
	java -jar $(GENERATOR) generate \
		--input-spec $(SCRATCH)/openapi.json \
		--generator-name typescript-fetch \
		--output . \
		--additional-properties=npmName=$(PACKAGE),importFileExtension=.js,modelPropertyNaming=original,paramNaming=original \
		> $(SCRATCH)/openapi-generator.log 2>&1 || (tail -40 $(SCRATCH)/openapi-generator.log && exit 1)
	node scripts/fix-generated.mjs src openapi.json
	@rm -rf $(SCRATCH)

# Two compiles from one source tree: ESM for import, CommonJS for require,
# each with its own declarations. The nested package.json is what makes Node
# and TypeScript read dist/cjs as CommonJS, since ours says "type": "module".
build: node_modules ## Compile to dist/
	@node -e 'const fs = require("fs"); const { version } = JSON.parse(fs.readFileSync("package.json", "utf8")); fs.writeFileSync("src/version.ts", "// Written by `make build` from package.json. Do not edit.\nexport const VERSION = " + JSON.stringify(version) + ";\n")'
	rm -rf dist
	$(TSC) -p tsconfig.json
	$(TSC) -p tsconfig.cjs.json
	@echo '{"type": "commonjs"}' > dist/cjs/package.json

# npm pack runs `make build` through the prepack script, so everything below
# checks the tarball that would be published rather than the working tree.
verify: node_modules ## Build and pack, check the package's types resolve, check the API surface
	rm -f *.tgz
	npm pack --silent
	# Checks that import and require each find the right code and declarations,
	# under every moduleResolution a consumer might use.
	node_modules/.bin/attw *.tgz --quiet
	node scripts/api-surface.mjs check dist/esm/index.d.ts api-surface.txt

test: verify ## Everything verify does, plus the tests
	rm -rf build
	$(TSC) -p tsconfig.test.json
	node --test build/tests/*.test.js

# The declared TypeScript floor is a promise nothing else checks: everything
# above compiles with the pinned 6.0.3. This compiles the README's examples
# against the packed tarball with the oldest TypeScript we support, under each
# module resolution mode a consumer might use.
consumer: verify ## Compile the README examples against the tarball with the oldest supported TypeScript
	rm -rf $(SCRATCH) && cp -R tests/consumer $(SCRATCH)
	node scripts/readme-examples.mjs README.md $(SCRATCH)/readme.ts
	cp $(SCRATCH)/readme.ts $(SCRATCH)/readme.cts
	tarball="$(CURDIR)/$$(ls *.tgz)" && cd $(SCRATCH) && \
		npm install --no-save --no-package-lock --no-audit --no-fund \
		"$$tarball" typescript@$(CONSUMER_TS_VERSION) >/dev/null
	cd $(SCRATCH) && for config in node16 node10 bundler; do \
		echo "tsc $(CONSUMER_TS_VERSION) -p tsconfig.$$config.json" && \
		node_modules/.bin/tsc -p tsconfig.$$config.json || exit 1; \
	done
	@rm -rf $(SCRATCH)

# Accept the current surface as the new baseline. The release records it
# itself, removals included, when it cuts a major.
surface: verify ## Rewrite api-surface.txt from the current build
	node scripts/api-surface.mjs write dist/esm/index.d.ts api-surface.txt

# We deliberately do not fork the generator's templates (see the header of
# scripts/fix-generated.mjs), so templates/pristine/ holds unmodified upstream
# copies, used for nothing but this check. The generator is never run with -t.
#
# One entry per template a pass anchors on, or whose behaviour a test relies
# on: apis.mustache for the parameterless-endpoint pass and for how it reads
# `explode`, which the filter fix in prepare-spec.mjs relies on,
# runtime.mustache for the User-Agent pass and for querystring(), which the
# filter fix hands the whole object to, and modelEnum.mustache because unknown
# enum values only survive while its FromJSON is a plain cast.
#
# `set -e` and a flag rather than `exit 1` in the loop: make runs the recipe
# under plain sh, where a loop's status is its last iteration's.
template-drift: $(GENERATOR) ## Fail if the generator's templates moved under us
	rm -rf $(SCRATCH)
	java -jar $(GENERATOR) author template --generator-name typescript-fetch --output $(SCRATCH) >/dev/null 2>&1
	@set -e; \
	drifted=""; \
	for t in apis runtime modelEnum; do \
		if ! test -f $(SCRATCH)/$$t.mustache; then \
			echo "$$t.mustache is gone from the generator: scripts/fix-generated.mjs may no longer apply"; \
			drifted="yes"; \
		elif ! diff -u templates/pristine/$$t.mustache $(SCRATCH)/$$t.mustache; then \
			echo ""; \
			echo "The generator's $$t.mustache changed. Read the diff, re-check that"; \
			echo "scripts/fix-generated.mjs still applies, then copy the new file over"; \
			echo "templates/pristine/."; \
			drifted="yes"; \
		fi; \
	done; \
	rm -rf $(SCRATCH); \
	test -z "$$drifted"

# The schema gate that makes a release a major, runnable by hand.
oasdiff: $(OASDIFF) ## Diff the live schema against the committed one, as the release does
	curl -sfSL $(SCHEMA_URL) -o /tmp/openapi.json.new
	@$(MAKE) --no-print-directory check-schema FILE=/tmp/openapi.json.new
	$(OASDIFF) breaking openapi.json /tmp/openapi.json.new \
		--severity-levels oasdiff-severity.txt --fail-on ERR

# For the release workflow, which needs oasdiff's own exit code (1 is "found
# breaking changes", anything else is "could not compare"), and make would
# turn both into 2.
print-oasdiff: $(OASDIFF)
	@echo $(OASDIFF)

$(OASDIFF):
	curl -sfSL "https://github.com/oasdiff/oasdiff/releases/download/v$(OASDIFF_VERSION)/oasdiff_$(OASDIFF_VERSION)_$(OASDIFF_PLATFORM).tar.gz" \
		| tar -xzO oasdiff > $@
	chmod +x $@

clean: ## Remove build output
	rm -rf dist build node_modules *.tgz docs
