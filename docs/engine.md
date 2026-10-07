# Engine export (experimental)

> **Status: experimental in 0.x.** Any minor release (0.3 to 0.4, for example) may break the
> engine API or the snapshot shape, and every such break is listed in the
> [CHANGELOG](../CHANGELOG.md) under that minor, in an entry starting "Engine (experimental):".
> Patch releases never break it. Depend on it with a caret range (`^0.3.0`), which on 0.x pins the
> minor.

`supabase-grants-lint/engine` replays a project's migrations exactly as `supabase-grants-lint check`
does (the same config lookup, migration discovery, `since` window and platform defaults) and
returns the database they build as plain JSON: a `SchemaSnapshot`. Tools that need to know what
the migrations create (which tables have row level security, which role holds which privilege,
which tables are in a publication) can read it instead of parsing SQL themselves.

The engine reads files only: the migrations, `grants-lint.config.json` or `package.json#grantsLint`
(or the config file you name), and `supabase/schemas` only to count declarative files. It opens no
network connection and writes nothing.

## Install and use

```sh
npm install supabase-grants-lint
```

The package is ESM only. Loading the SQL parser (WebAssembly) is the only asynchronous step, so
await `loadEngine()` once, then replay synchronously as often as you need:

```ts
import { loadEngine, publicationMembership, replayProjectSync } from 'supabase-grants-lint/engine';

await loadEngine();

const snapshot = replayProjectSync({ projectDir: process.cwd() });
for (const relation of snapshot.relations) {
  if (relation.rls.enabled && relation.policies.length === 0) {
    console.log(`${relation.schema}.${relation.name}: RLS on, no policies`);
  }
}
console.log(publicationMembership(snapshot, 'supabase_realtime', 'public', 'todos'));
```

`replayProject(options)` does both steps in one call and returns a Promise.

## Functions

| Function                                             | Returns                          | Notes                                                               |
| ---------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `loadEngine()`                                       | `Promise<void>`                  | Loads the parser once; calling it again is free.                    |
| `isEngineLoaded()`                                   | `boolean`                        | Whether `loadEngine()` has resolved.                                |
| `replayProjectSync(options)`                         | `SchemaSnapshot`                 | Throws `EngineError` `not-loaded` before `loadEngine()` resolves.   |
| `replayProject(options)`                             | `Promise<SchemaSnapshot>`        | `await loadEngine()`, then `replayProjectSync(options)`.            |
| `listReplayInputs(options)`                          | `ReplayInputs`                   | The files a replay reads, without the parser: for a cache to watch. |
| `publicationMembership(snapshot, pub, schema, name)` | `'yes'` \| `'no'` \| `'unknown'` | Whether a table is in a publication, from the snapshot alone.       |
| `version`                                            | `string`                         | This package's version (also in `snapshot.meta.engineVersion`).     |

## Options

- `projectDir` (required): the project directory, where the config and the migrations are looked
  up. Every path in the snapshot is relative to it.
- `configFile`: a config file to read, relative to `projectDir`. Without it the engine reads
  `grants-lint.config.json` and `package.json#grantsLint` as the CLI does.
- `overrides`: values for the config keys that change what the replay builds (`migrations`,
  `schemas`, `since`, `platformDefaults`, `platformRevokeAtSince`, `migrationRole`, `autoRls`,
  `platformPublications`). They take precedence over every config source and are validated like
  the config file. See [configuration.md](configuration.md) for each key.

## Errors

`EngineError` has a `code`:

- `not-loaded`: `replayProjectSync` was called before `loadEngine()` resolved.
- `config`: the config file or an override is invalid, or the named config file does not exist. The
  message names the file and key; `cause` is grants-lint's config error, whose `issues` list every
  problem.
- `project`: the project directory or the migrations directory does not exist, or a `migrations`
  path or glob is invalid.

SQL never throws. A statement the parser rejects is counted in `meta.parseProblems` and a `DO`
block in `meta.dynamicSql`; the snapshot still builds. Any other exception is a bug: please report
it.

## The snapshot

The snapshot is the database after the last migration file. It is plain JSON (no classes, `Map`s
or `undefined`) and deterministic: the same inputs give byte-identical `JSON.stringify` output on
every operating system, with paths relative to `projectDir` using `/`, arrays in the orders below,
and no timings or absolute paths. PUBLIC is written `'public'` (Postgres reserves that role name,
so it cannot collide with a real role).

`snapshotVersion` is `1`. It changes only when a field is removed, renamed or changes meaning;
adding a field is not a break. Check it before reading the rest.

These are the exported types (a test checks that this block matches the source):

```ts
export type EngineErrorCode = 'not-loaded' | 'config' | 'project';

export declare class EngineError extends Error {
  readonly code: EngineErrorCode;
}

export declare const version: string;
export declare function loadEngine(): Promise<void>;
export declare function isEngineLoaded(): boolean;
export declare function replayProjectSync(options: ReplayProjectOptions): SchemaSnapshot;
export declare function replayProject(options: ReplayProjectOptions): Promise<SchemaSnapshot>;
export declare function listReplayInputs(options: ReplayProjectOptions): ReplayInputs;
export declare function publicationMembership(
  snapshot: SchemaSnapshot,
  pub: string,
  schema: string,
  name: string,
): 'yes' | 'no' | 'unknown';

export interface ReplayProjectOptions {
  readonly projectDir: string;
  readonly configFile?: string;
  readonly overrides?: {
    readonly migrations?: string | readonly string[];
    readonly schemas?: readonly string[];
    readonly since?: string;
    readonly platformDefaults?: 'legacy' | 'explicit';
    readonly platformRevokeAtSince?: boolean;
    readonly migrationRole?: string;
    readonly autoRls?: 'auto' | 'on' | 'off';
    readonly platformPublications?: readonly string[];
  };
}

export interface ReplayInputs {
  readonly projectDir: string;
  /** The config file with the highest precedence (absolute), or `null` for the defaults. */
  readonly configFile: string | null;
  /** That source as grants-lint names it (`package.json#grantsLint`, for example), or `defaults`. */
  readonly configSource: string;
  /** Absolute paths, in replay order. */
  readonly migrations: readonly string[];
  /** Absolute directories whose listing can change the inputs, sorted. */
  readonly watchDirs: readonly string[];
}

export interface SchemaSnapshot {
  readonly snapshotVersion: 1;
  /** Every tracked relation, in every schema, in creation order. */
  readonly relations: readonly SnapshotRelation[];
  /** In creation order. */
  readonly sequences: readonly SnapshotSequence[];
  /** Sorted by name. */
  readonly publications: readonly SnapshotPublication[];
  readonly meta: SnapshotMeta;
}

export interface SnapshotLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface SnapshotName {
  readonly schema: string;
  readonly name: string;
}

export interface SnapshotRelation {
  readonly schema: string;
  readonly name: string;
  readonly kind: 'table' | 'view' | 'materialized view' | 'foreign table';
  readonly created: SnapshotLocation | null;
  readonly rls: {
    readonly enabled: boolean;
    readonly forced: boolean;
    /** Why `enabled` has its value. */
    readonly source: 'default' | 'statement' | 'auto-rls';
    /** The statement, or the automatic RLS trigger or function that applied. */
    readonly at: SnapshotLocation | null;
  };
  /**
   * Grantee, then privilege: `'table'` when held on the whole relation, `'columns'` when held
   * only on some columns. Grantee `'public'` is PUBLIC. Keys sorted.
   */
  readonly privileges: Readonly<Record<string, Readonly<Record<string, 'table' | 'columns'>>>>;
  /** Sorted by name. */
  readonly policies: readonly SnapshotPolicy[];
}

export interface SnapshotPolicy {
  readonly name: string;
  readonly command: 'all' | 'select' | 'insert' | 'update' | 'delete';
  /** `'public'` for PUBLIC. */
  readonly roles: readonly string[];
  readonly permissive: boolean;
  readonly using: 'service_role' | 'false' | 'other' | null;
  readonly withCheck: 'service_role' | 'false' | 'other' | null;
  readonly created: SnapshotLocation;
  readonly altered: SnapshotLocation | null;
}

export interface SnapshotSequence {
  readonly schema: string;
  readonly name: string;
  /** Grantee to sorted privileges; grantee `'public'` is PUBLIC. Keys sorted. */
  readonly privileges: Readonly<Record<string, readonly string[]>>;
  readonly ownedBy: {
    readonly schema: string;
    readonly name: string;
    readonly column: string;
  } | null;
}

export interface SnapshotPublication {
  readonly name: string;
  /** The platform's initial state, a `create` statement, or first seen in an `alter`. */
  readonly origin: 'platform' | 'migration' | 'unseen';
  readonly allTables: boolean;
  /** `FOR TABLES IN SCHEMA`, sorted. */
  readonly schemas: readonly string[];
  /** Explicit members, sorted. */
  readonly tables: readonly SnapshotName[];
  /** Where a change the replay cannot follow made membership unknown. */
  readonly uncertain: SnapshotLocation | null;
  /** Tables explicitly removed after the `uncertain` mark, sorted. */
  readonly excluded: readonly SnapshotName[];
}

export interface SnapshotMeta {
  /** grants-lint's version. */
  readonly engineVersion: string;
  /** The config source with the highest precedence, or `defaults`. */
  readonly configSource: string;
  /** Migration files replayed. */
  readonly files: number;
  readonly since: {
    readonly value: string | null;
    readonly source: 'cli' | 'config' | 'auto' | null;
  };
  /** Statements the parser could not read. */
  readonly parseProblems: number;
  /** `DO` blocks. */
  readonly dynamicSql: number;
  /** Declarative schema files found (not replayed). */
  readonly declarativeFiles: number;
  readonly autoRls: {
    readonly mode: 'auto' | 'on' | 'off';
    readonly active: SnapshotLocation | 'start' | null;
  };
  readonly notes: readonly {
    readonly code: string;
    readonly message: string;
    readonly at: SnapshotLocation;
  }[];
}
```

Policies on relations the migrations never create are not in the snapshot.

### Publication membership

`publicationMembership(snapshot, pub, schema, name)` answers in this order:

1. No publication `pub` in the snapshot: `'no'`.
2. The table is in `tables`, or `allTables` is set (tables only, not views), or `schema` is in
   `schemas`: `'yes'`.
3. The table is in `excluded`: `'no'`.
4. `uncertain` is set: `'unknown'`.
5. Otherwise: `'no'`.

## What is modelled

On top of what grants-lint's rules read (relations, sequences, grants, default privileges and
policies, see [how-it-works.md](how-it-works.md)), the replay tracks for the engine:

- **Row level security:** `alter table ... enable | disable | force | no force row level security`
  (with `if exists`, `only` and other subcommands in the same statement). Off at `create table`.
  On a relation the migrations never create, the statement leaves a note in `meta.notes`.
- **Automatic RLS:** Supabase's opt-in template, event trigger `ensure_rls` calling
  `public.rls_auto_enable()`. While it is active, a new table in `public` starts with RLS on
  (`source: 'auto-rls'`); a later explicit `disable` wins. When it counts as active is the config key
  [`autoRls`](configuration.md#autorls). Event triggers are tracked by `create`, `alter ... enable |
disable`, `rename` and `drop`; their bodies are not read.
- **Publications:** `create publication` (a list of tables, `for all tables`, `for tables in
schema`), `alter publication ... add | drop | set` (tables, `table only`, `tables in schema`),
  `rename to` and `drop publication`. `owner to` and `set (publish ...)` change nothing. A
  `create publication` of an existing name redefines it and leaves a note. A dropped table leaves
  every publication; a renamed table keeps its membership. The publications in the config key
  [`platformPublications`](configuration.md#platformpublications) exist, empty, before the first
  migration; an `alter` of a publication never seen creates it with `origin: 'unseen'` and marks it
  uncertain.
- **Publication changes the replay cannot follow:** when a `DO` block, or the body of a function a
  migration then calls (`select f()`, `perform f()` or `call f()`), contains `alter`, `create` or
  `drop publication <name>`, publication `<name>` becomes `uncertain` from that statement on. A name
  that is not a plain or quoted identifier (such as `%I` in `format()`) marks every publication that
  exists at that point. A later plain `create publication <name>` or `drop publication <name>`
  clears the mark; a later plain `add`, `drop` or `set table` keeps it, but a table it adds is a
  known member and a table it removes is listed in `excluded` (as is a table dropped while the mark
  is set, so a table recreated with the same name is a known non-member).

## What stays unmodelled

- Function and trigger bodies, apart from the publication scan above. Function calls are matched
  by name only (no overloads), not transitively (a function calling a function), and not through
  triggers.
- Any statement inside a `DO` block apart from the publication scan.
- Non-event triggers; `alter table` subcommands other than the four RLS ones; ownership changes;
  role creation and membership; `security_invoker` and `security_barrier` views; `drop schema ...
cascade`.
- Publication `publish` options, row filters and column lists (membership only).
- `select ... into` creates no tracked relation, so automatic RLS cannot apply to it.
- Partition inheritance of RLS: partitions start with RLS off, as in Postgres.
- Anything done outside migrations: tables published or given RLS from the dashboard after the last
  `supabase db pull` are not seen. Declarative schema files are counted but not replayed (the
  database is built from migrations).

## Watching the inputs

`listReplayInputs(options)` returns the config file and the migrations `replayProjectSync` would
read, and `watchDirs`: the project directory, each migrations directory, the fixed directory of
each glob, and every directory that holds a migration. A cache can compare these files' sizes and
modification times, and these directories' listings, to decide when to replay again. When both
`grants-lint.config.json` and `package.json#grantsLint` exist, `configFile` is the former (it wins
key by key); `package.json` is in the project directory.
