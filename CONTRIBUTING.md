# Working on this repo

Everything under `src/` is generated. Don't edit it: the next release
overwrites it. Changes to the API surface come from the upstream OpenAPI
schema. Changes to the *shape* of the generated code come from
`scripts/prepare-spec.mjs`, which adjusts the schema before generation, and
`scripts/fix-generated.mjs`, which rewrites the output after it.

Hand-written and safe to edit: `scripts/`, `tests/`, `templates/`,
`package.json`, the tsconfigs, the `Makefile`, `.github/`, `README.md` and
this file.

## Prerequisites

| Tool | Needed by | Notes |
| --- | --- | --- |
| Node 20 or later | everything | Node 24 matches the release workflow |
| Java 11 or later | `make generate`, `make template-drift` | openapi-generator is a jar; the Makefile downloads it to `/tmp` |
| network | first `make generate` or `make template-drift`, `make consumer`, `make oasdiff` | the generator jar and oasdiff are downloaded once to `/tmp`, `make consumer` installs TypeScript 5.0 from npm, and `make oasdiff` fetches the live schema |

## Targets

`make help` lists them. The ones that matter:

- `make generate` regenerates `src/` from the **committed** `openapi.json` and
  runs the post-generation pass. Start here after changing anything in
  `scripts/`.
- `make test` packs the package and checks the tarball: the types resolve
  under every module mode ([attw](https://github.com/arethetypeswrong/arethetypeswrong.github.io)),
  the API surface lost nothing, and the tests pass against the built package.
  CI runs it on Node 20, 22 and 24, alongside `make consumer`,
  `make template-drift` and a check that `make generate` changes nothing.
- `make consumer` compiles every TypeScript block in the README against the
  tarball with TypeScript 5.0, the oldest the README promises, under node16
  (ESM and CommonJS), node10 and bundler resolution.
- `make template-drift` fails if the generator's templates changed under the
  anchors `scripts/fix-generated.mjs` matches on.
- `make oasdiff` runs the schema gate that stops a release, by hand.
- `make surface` accepts the current API surface as the new baseline, after a
  deliberate breaking change.

## How a release happens

`.github/workflows/sync.yml`, hourly. When the live schema differs from the
committed one it regenerates, verifies, bumps the **minor** version, commits,
tags, and publishes to npm. No human is involved unless a gate trips.

Two gates stop it. `oasdiff` compares the schemas, and
`scripts/api-surface.mjs` compares the package's exported names, properties
and parameters against `api-surface.txt`, which each release extends. Either
one reporting a break halts the run and files an issue. A halted run does
**not** commit the new schema, so every later run sees the same diff and halts
the same way until someone acts. That is deliberate, and it is why the issues
are deduped.

## When a release stops

The workflow files one of four issues. Close each as soon as it is resolved:
while a `release-stuck` issue is open, a new pre-commit failure files nothing,
and while a `breaking-change` issue is open, the next break files nothing.

**Breaking API change detected — manual release required** (`breaking-change`).
oasdiff found a change that breaks callers. If it is a mistake upstream, get
the schema fixed; the loop keeps halting, without filing again, until the live
schema is compatible. If it is intended, run the workflow from the Actions tab
with **bump: major** and **acknowledge_breaking: true**. Both are required
together. The run then accepts the new API surface itself, so there is nothing
to commit first.

**Release is stuck — regeneration or verification is failing**
(`release-stuck`). The schema changed and something after it failed, before
anything was committed, so the next hourly run fails the same way. Reproduce
it:

```
make fetch && make template-drift generate test consumer
```

- If the job log lists entries that left the public surface and the change is
  intended, it is a breaking release: dispatch with **bump: major** and
  **acknowledge_breaking: true**, as above.
- If it failed in **Decide next version** or **Set the release version**, the
  cause is not the code and the reproduction above passes. `already exists`
  or `already on npm` means a tag or version from an earlier run is in the
  way: publish or delete it by hand. `Could not ask npm` is a registry outage,
  and `too old for trusted publishing` a runner image problem; both clear on a
  later run. Close the issue once a run succeeds.
- If a download failed (the generator jar from Maven Central, or oasdiff from
  GitHub), it clears on the next run. Close the issue once one succeeds.
- If `make template-drift` failed, follow
  [Upgrading openapi-generator](#upgrading-openapi-generator).
- If a README example no longer compiles, the schema removed or renamed what
  it uses: update `README.md`.
- Otherwise fix the cause in `scripts/`, or get the schema fixed upstream.
  Then put the committed schema back and regenerate from it:
  `git checkout openapi.json && make generate`. Commit the fix and whatever
  `src/` change that makes. Do **not** commit the new `openapi.json`: the next
  run would see no schema change and release nothing.

**Release vX is tagged but not published** (`release-stuck`). The commit and
tag were pushed, then `npm publish` failed. The version is spent and nothing
retries. The issue has the commands to publish by hand from the tag; check
with `npm view` first, as it says, since a cancelled run may have finished the
publish. Fix the cause first, most often the npm trusted-publishing
configuration.

**Release vX is published but has no GitHub release** (`release-stuck`). Only
the GitHub release is missing; run the `gh release create` command in the
issue.

### What makes an API change additive here

Our API compatibility policy treats adding a response property, a request
property, an enum value or an optional parameter as backwards-compatible, and
those ship without a human. TypeScript absorbs most of that without help:
properties are structural, and a new optional field breaks nobody. The rest is
handled here:

- Enum values pass through as strings. The generator's `FromJSON` for an enum
  is a cast, not a check, so a value added after a build doesn't fail the
  response. `make template-drift` watches that template.
- Every endpoint takes a parameters object, even those with no parameters
  today, so the first one added is a new optional field rather than a new
  first argument. See `scripts/fix-generated.mjs`.
- Request bodies are passed as `body` rather than under the payload schema's
  name, so renaming a component upstream doesn't rename a key callers write.
  See `scripts/prepare-spec.mjs`.
- Parameters are passed as one object, so adding one never shifts the position
  of another.

## Why TypeScript is pinned to 6.0.3

`typescript` is an exact version in `package.json`, and should stay one:

- TypeScript 7 has no programmatic API yet, and `scripts/api-surface.mjs` is
  built on it.
- TypeScript 7 removes `moduleResolution: node10`, which is the only resolution
  that pairs with CommonJS output, and the CJS build uses it. Moving to 7 means
  building CJS from `.cts` sources under `module: node16`, or dropping CJS in
  favour of `require(esm)`, which Node supports from 20.19.
- The compiler writes the declarations every consumer reads. A version bump
  that changes them should arrive as a pull request someone reads, not inside
  an hourly release.

The TypeScript *consumers* can use is a separate question, answered by
`make consumer`.

## First release checklist

Done once, for v1.0.0, and kept for setting up a repo the same way. Until a
package exists on npm, keep the `schedule:` block in
`.github/workflows/sync.yml` commented out. In order:

1. **Create `incident-io/sdk-ts` on GitHub, public.** npm attaches provenance
   to trusted publishes only from a public repository. Leave `master`
   unprotected, or make sure no ruleset stops GitHub Actions pushing commits
   and tags to it: the release pushes with the workflow's own token, and a
   refused push files a misleading "regeneration or verification is failing"
   issue.
2. **Set the first version, check it, commit and tag.**
   `npm version 1.0.0 --no-git-tag-version`, then `make test consumer`, then
   commit everything including `openapi.json` and `src/`, `git tag v1.0.0`,
   and push the branch and the tag. The tag is the baseline
   `Decide next version` counts from.
3. **Publish once by hand**, from that clean, tagged tree: `npm publish`,
   logged in to npm as a member of the `@incident-io` org. Trusted publishing
   cannot create a package, only publish to one that exists.
   `publishConfig` makes it public.
4. **Register trusted publishing** on npmjs.com, under the package's settings,
   against this repository **and the workflow filename `sync.yml`**. Renaming
   that file breaks publishing. **Allow direct `npm publish`** when creating
   it: a configuration can be limited to
   [staged publishing](https://docs.npmjs.com/staged-publishing/), which holds
   every release for a maintainer's 2FA approval, and an hourly loop would
   wait forever.
5. **Require 2FA and disallow tokens** under the package's publishing access.
   Trusted publishing keeps working, and nothing else should be publishing.
6. **Run the workflow once by hand** with `dry_run: true`. If the live schema
   has not changed since your commit it stops at "Schema unchanged", which is
   as far as it can go. A dry run never reaches `npm publish`, so a mistake in
   step 4 first shows on the first real release, as "tagged but not
   published", and costs that version number.
7. **Uncomment the `schedule:` block** at the top of
   `.github/workflows/sync.yml`, commit and push. Nothing else enables the
   loop, and nothing checks that you did: until this happens the repo looks
   healthy and publishes nothing.
8. **Watch the first real release** through to npm.

## Keeping the loop alive

Everything that reports a problem here is a `failure()` hook, and a loop that
never runs never fails. Two ways it can go quiet:

- GitHub **disables a scheduled workflow after 60 days** with no repository
  activity, and emails only whoever last edited the cron. This repo's activity
  is its own release commits, which stop exactly when the schema stops
  changing, so the disable lands when nothing else would show it.
- Someone reverts or never enables the cron.

To turn a disabled loop back on: Actions tab, **sync**, **Enable workflow**.

Each run that gets as far as fetching the schema writes a line to its job
summary saying what it decided, so "when did this last sync?" is answerable
from the Actions run list. If the run list is empty for a week, the loop is
off, not quiet.

## Upgrading openapi-generator

`OPENAPI_GENERATOR_VERSION` in the `Makefile` is pinned deliberately. The
project ships no patch releases, so every available upgrade is a minor, which
its own policy says may change template-bound variables, and those variables
are what `scripts/fix-generated.mjs` anchors on.

Bumping it is a read-the-diff operation:

1. Change the version and run `make template-drift`. It will fail and print
   the diff against `templates/pristine/`.
2. Read the diff. Decide whether each pass in `scripts/fix-generated.mjs`
   still matches.
3. Copy the new templates over `templates/pristine/`, run `make generate`, and
   check every pass still reports its expected count.
4. `make test` and `make consumer`.
