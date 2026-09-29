# Contributing

Thanks for considering a contribution to `supabase-grants-lint`.

## Setup

```
git clone https://github.com/guptaaman678/supabase-grants-lint.git
cd supabase-grants-lint
npm ci
npm run build
npm test
```

Node `>=22` is required (`.nvmrc` pins the version used in development).

## Commands

| Command                           | Purpose                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run build`                   | build the CLI and library with tsup                                                                                |
| `npm test`                        | run the vitest suite                                                                                               |
| `npm run test:watch`              | run tests in watch mode                                                                                            |
| `npm run lint`                    | ESLint                                                                                                             |
| `npm run typecheck`               | `tsc --noEmit` in strict mode                                                                                      |
| `npm run format` / `format:check` | Prettier                                                                                                           |
| `npm run mutation`                | Stryker mutation testing on `src/model`, `src/replay`, `src/rules`, `src/fix` and live mode's parsing (`src/live`) |
| `npm run bench`                   | cold-start `check` timings on generated projects of 100 and 500 migrations                                         |
| `npm run corpus`                  | pinned corpus regression (network: fetches the projects in `test/corpus`)                                          |

## Fixture layout

Behavioural tests live under `test/fixtures/<RULE>/<pass|fail>/<case>/`:

```
test/fixtures/GL001/fail/no-service-role-grant/
  migrations/0001_create_table.sql
  expected.json
  config.json   (optional, only if the case needs non-default config)
```

`expected.json` lists the exact findings the fixture produces: rule, file,
line, relation and role. A fixture with no matching finding belongs under
`pass/`.

GL009 (live mode) fixtures also run against a real Postgres: the test builds a
database from the fixture's migrations, then runs its optional `database.sql`
(changes made by hand). By default that is PGlite, Postgres compiled to
WebAssembly, so no Docker is needed; set `GRANTS_LINT_TEST_DB_URL` to a server
you own (for example `postgres://postgres@localhost:5432/postgres`) to use it
instead, as the `live` CI job does. Each test gets a fresh database.

## Whole-project tests

`test/e2e/apps/<app>/` holds small but complete Supabase projects (a todo
app, a chat app with serial ids, a multi-schema app, a project that starts
from a `db pull` baseline). Each `expected.json` lists runs of `check` (flags,
exit code, summary counts, resolved `since`, findings and notices), and
`test/e2e/apps.test.ts` checks every run through the built binary and
in-process. Line coverage must stay at 90% or more overall and at 100% for
`src/model`, `src/replay`, `src/rules` and `src/fix` (`npm run test:coverage`).

## Reporter golden files

Every `--format` is checked against golden files: each project in
`test/golden/projects/` is linted and its output compared with
`test/golden/<format>/<project>.txt`. After an intentional output change,
rewrite them and review the diff before committing:

```sh
UPDATE_GOLDEN=1 npx vitest run test/golden/reporters.test.ts
git diff test/golden
```

SARIF output is also validated against the SARIF 2.1.0 schema vendored in
`test/golden/sarif-schema-2.1.0-rtm.5.json`.

## Pinned corpus

`test/corpus/pins.json` lists public projects with permissive licenses, each
pinned to a commit, with the number of findings per rule the linter reported
when it was pinned. `npm run corpus` fetches each one's `supabase/` folder at
that commit, lints it and compares the counts; nothing from those projects is
stored in this repository. `.github/workflows/corpus.yml` runs it weekly, when
the pins change, and before every release step (`release.yml` calls it), but
not on pull requests. When a linter change moves a count on purpose, record
the new counts with `node scripts/corpus-regression.js --update` and explain
the difference in the pull request.

## How to add a rule

1. Read the rule's semantics in `docs/rules/` (or draft the page first if the
   rule does not exist yet).
2. Implement `src/rules/<ID>.ts` against the `Rule` interface in
   `src/rules/types.ts`. A rule reads the end-of-file snapshot; it never
   mutates the model.
3. Add fixtures: at least one failing case, one passing case, and one case
   for every exemption or edge condition named in the rule's spec.
4. Add `docs/rules/<ID>.md` with the same sections as the other pages.
   `test/golden/docs.test.ts` lints its "Failing example" SQL blocks (each
   names its file on the first line), expects the rule to report them and
   the "Fix" blocks to clear it, and compares the `text` block with the real
   output. Fill that block with
   `UPDATE_GOLDEN=1 npx vitest run test/golden/docs.test.ts`.
5. Run `npm run mutation` and either add a test for every surviving mutant in
   the rule's file, or record why the mutant is equivalent below.
6. Add a changeset (`npx changeset`) describing the user-visible change.

## Commits and releases

This project uses [Conventional Commits](https://www.conventionalcommits.org/)
and [Changesets](https://github.com/changesets/changesets). Every
user-visible change needs a changeset (`npx changeset`); internal-only changes
do not. Releases follow SemVer and stay `0.x` until the project's stability
promise is published.

## Release procedure

Every push to `main` runs `.github/workflows/release.yml`
([Changesets](https://github.com/changesets/changesets) via
`changesets/action`), after the pinned corpus regression passes:

1. If unreleased changesets exist, the workflow opens or updates a
   "Version Packages" pull request. That PR runs `changeset version`: it
   bumps `package.json`, writes `CHANGELOG.md` and deletes the consumed
   changeset files. Nothing is published yet.
2. A maintainer reviews and merges the Version Packages PR like any other
   PR.
3. That merge re-runs the workflow. With no changesets left to version and
   the new version neither on npm nor tagged yet, it runs `npm stage publish
--provenance --access public`. This uploads the package to npm's staging
   queue through trusted publishing (OIDC, `id-token: write`, no npm token in
   the repository). The trusted publisher is configured as stage-only, so CI
   cannot make a version live by itself. The workflow then pushes the git tag
   `vX.Y.Z` at the merge commit.
4. A maintainer reviews the staged version on npmjs.com (or with `npm stage
list` and `npm stage view`) and approves it with 2FA (`npm stage approve`
   works too). Only then is the version live on npm.
5. The next run of the workflow after approval (any push to `main`, or a
   manual run from the Actions tab) sees the version live on npm and moves the
   floating major-version tag used by the GitHub Action (for example `v0`,
   later `v1`) to the release tag, so `uses:
guptaaman678/supabase-grants-lint@v0` always runs a version that is on
   npm.
6. A maintainer creates the GitHub Release for `vX.Y.Z` from its
   `CHANGELOG.md` entry, with "Publish this Action to the GitHub Marketplace"
   ticked.

If a staged version is rejected, delete its `vX.Y.Z` tag before fixing and
releasing again; the workflow skips staging while that tag exists.

The very first publish (0.1.0) was done by hand, because npm trusted
publishing can only be configured once the package already exists on the
registry. That version has no provenance; 0.1.1 onward is staged by this
workflow with provenance.

## Maintenance policy

### Triage

Reports are triaged in the order: internal errors and crashes, then false
positives and parser failures, then everything else. The target for a first
response is 72 hours during the first two months after the 0.1.0 release,
and one week after that. Security reports go through private vulnerability
reporting (see `SECURITY.md`), not public issues.

### False positives

Every confirmed false positive becomes a fixture first: a case under
`test/fixtures/<RULE>/pass/` (or an updated `expected.json`) that reproduces
the report and fails on the current code. The fix follows in the same pull
request, and the fixture stays so the false positive cannot come back.

### Rule IDs and removals

- Rule IDs (`GL000`, `GL001`, ..., `PARSE001`, ...) are never reused, even
  after a rule is removed.
- A rule, config key, CLI flag or output field is removed only in a major
  release, and only after an earlier release has printed a deprecation
  warning for it.

### Scope

This project checks grants and whether RLS policies are reachable through the
Data API, from a project's migrations. Requests
outside that are out of scope and are pointed elsewhere:

- lock safety and general migration linting:
  [squawk](https://github.com/sbdchd/squawk)
- advisories on a live database (security and performance):
  [splinter](https://github.com/supabase/splinter), which powers the Supabase
  dashboard's advisors

## Mutation testing

`npm run mutation` runs [Stryker](https://stryker-mutator.io/) with the vitest
runner over `src/model`, `src/replay`, `src/rules` and `src/fix`, using
`vitest.mutation.config.ts` (the in-process unit and golden suites; tests that
run the built CLI in a child process cannot see a mutant). The run fails below
a mutation score of 80 (`thresholds.break` in `stryker.config.json`); the
project's target is 85 or more, with no unexplained survivor in `src/rules`.
The HTML report is written to `reports/mutation/`, and a weekly workflow
(`.github/workflows/mutation.yml`) runs it on `main`.

`test/stryker-name-filter.ts` works around a mismatch between Stryker's vitest
runner 10.0.0 and vitest 5: Stryker selects each mutant's tests by a name
pattern joined with spaces, vitest 5 matches it against names joined with
`" > "`, so no test inside a `describe` ran and every mutant survived. Remove
the file once Stryker matches vitest 5 names itself.

## Mutation notes

Surviving mutants judged equivalent (no behavioural difference, so no test can
kill them) are listed here. Every other surviving mutant gets a test.

| Where                                                                                                | Mutant                                                                                                                                     | Why it is equivalent                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/model/acl.ts` `union`                                                                           | `hold.columns.size > 0` to `true` or `>= 0`                                                                                                | Granting a privilege with an empty column list adds no column and keeps the object-level flag, so the ACL is unchanged.                                      |
| `src/model/relations.ts` `dropPolicy`                                                                | always keep the relation's policy map, even when empty                                                                                     | Every reader (`policy`, `policiesOn`, `policies`, `moveRelation`) treats an empty map like a missing one.                                                    |
| `src/parse/adapter.ts` service-role-only classifier (ADR-012, run with `--mutate` on its line range) | `?? []` fallbacks for `A_Expr.name`, `FuncCall.funcname`, `TypeName.names`, `?? ''` for `SQLValueFunction.op`, `typeName?.` to `typeName.` | The parser always fills these fields, so the fallbacks and optional chains are never taken.                                                                  |
| `src/parse/adapter.ts` `scalarSelect`                                                                | `select === undefined \|\| !('SelectStmt' in select)` or `target === undefined` to `false`                                                 | An `EXPR_SUBLINK` always has a `SelectStmt` subselect, and `targets.length !== 1` is checked first, so the guards only narrow types.                         |
| `src/parse/adapter.ts` `operands`                                                                    | `name.length !== 1` to `false`                                                                                                             | A qualified operator name starts with its schema, so `name[0] !== op` already rejects it.                                                                    |
| `src/live/acl-text.ts` `parseAclItem`                                                                | `bare = ''` or `letters = ''` defaults to another string                                                                                   | The pattern always sets `letters` (possibly empty), and sets `bare` whenever the grantee is not quoted, so neither default is ever used.                     |
| `src/replay/engine.ts` `case 'Unknown'`                                                              | case removed or relabelled                                                                                                                 | The case only breaks out of the switch, which is what an unmatched statement does too.                                                                       |
| `src/replay/handlers/move.ts` untracked move                                                         | `catalog.policiesOn(from).length > 0` to `true` or `>= 0`                                                                                  | With no relation, sequence or policy under the old name, `moveRelation` returns an equal catalog (owned sequences always belong to a tracked relation).      |
| `src/replay/since.ts` `compareVersions`                                                              | `x.length < y.length` to `<=`                                                                                                              | Only reached when the lengths differ.                                                                                                                        |
| `src/replay/since.ts` `optInStatement`                                                               | skip the `typeof grantee !== 'string'` guard                                                                                               | `PUBLIC` is then recorded under its symbol, which the opt-in check (`anon`, `authenticated`, `service_role`) never reads.                                    |
| `src/replay/since.ts` `replayWithWindow`                                                             | `first >= 0` to `true`                                                                                                                     | With no enforced file `first` is `-1`, which is never a file index, so no platform revoke is applied either way.                                             |
| `src/rules/GL003.ts` `anchor`                                                                        | `policy.altered !== null` to `true`                                                                                                        | A file's policies were created or altered in it, so a policy created in another file always has `altered` set.                                               |
| `src/rules/GL005.ts` `fixSql`                                                                        | `e.object === object` to `true`; `[]` to a placeholder string                                                                              | Relations and sequences share one namespace, so a created name of the other kind, or a placeholder, never equals a target's qualified name.                  |
| `src/rules/GL005.ts` `finding`                                                                       | always set `fix`, even to `undefined`                                                                                                      | `runRules` copies `fix` into the report only when it has a value.                                                                                            |
| `src/rules/GL007.ts` `fromFiles`                                                                     | also list revokes as candidate anchors                                                                                                     | A revoke removes what it names from its own entry, so it is only still in effect if a later grant restored it, and `findLast` then returns that later grant. |
| `src/rules/PARSE001.ts`, `PARSE002.ts`, `index.ts` `replayNotices`                                   | `event.kind === 'skipped'` to `true`                                                                                                       | Only `skipped` events have a `reason`; for the others it is `undefined`.                                                                                     |
| `src/rules/index.ts` `isClientRole`                                                                  | `typeof role === 'string'` to `true`                                                                                                       | `clientRoles` holds strings, so it never includes `PUBLIC`.                                                                                                  |
| `src/rules/index.ts` `runRules`                                                                      | `inlineUsed.get(suppression)?.add` to `.add`                                                                                               | Every suppression is a key of `inlineUsed`, which is built from the same list.                                                                               |
| `src/rules/index.ts` `preferGL002`                                                                   | `relation === undefined` or `role === undefined` to `false`                                                                                | GL002 findings always have a relation and a role, so a GL003 finding without one never matches their key.                                                    |
