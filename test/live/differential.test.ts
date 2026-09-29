/**
 * Differential test (spec T11.4): every rule fixture's migrations are applied to a real Postgres
 * (the CI service containers run Postgres 15 and 17; locally PGlite, see
 * `test/support/database.ts`), and after **each file** the replay model must equal the database:
 * the same relations and sequences in the configured schemas, the same privileges on each for
 * every role except the owner (object and column level), the same default privileges and the same
 * policies. Rules evaluate at the end of each file, so each file's state is compared, not only the
 * last.
 *
 * What the database is given, so that it starts where the model starts:
 * - the roles the fixture's config names, and the legacy platform defaults unless config
 *   `platformDefaults` is `"explicit"`;
 * - each file runs as config `migrationRole` (a `SET ROLE` lasts until the end of its file, as in
 *   the model);
 * - the announced platform revoke, before the file where the replay assumes it (ADR-002 item 1);
 * - not the statements the replay reports and skips: unparseable ones (PARSE001, which Postgres
 *   rejects too) and dynamic SQL (PARSE002). They are blanked, keeping every line where it was.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { type Config } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/load.js';
import { readLive } from '../../src/drift.js';
import type { LiveSnapshot } from '../../src/live/snapshot.js';
import { discoverMigrations } from '../../src/load/discover.js';
import { type Acl, type AclKind, type Grantee, PUBLIC } from '../../src/model/acl.js';
import type { DefaultPrivileges } from '../../src/model/defaults.js';
import type { Catalog } from '../../src/model/relations.js';
import { loadParser } from '../../src/parse/adapter.js';
import type { FileReplay } from '../../src/replay/engine.js';
import { PLATFORM_REVOKE } from '../../src/replay/platform-revoke.js';
import { replayWithWindow } from '../../src/replay/since.js';
import { comparedPrivileges } from '../../src/rules/GL009.js';
import { startDatabase, type TestDatabase } from '../support/database.js';

const ROOT = fileURLToPath(new URL('../fixtures', import.meta.url));

const parser = await loadParser();

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const FIXTURES = subdirs(ROOT).flatMap((rule) =>
  ['fail', 'pass'].flatMap((kind) =>
    subdirs(path.join(ROOT, rule, kind)).map((name) => `${rule}/${kind}/${name}`),
  ),
);

const open: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

function quote(role: string): string {
  return `"${role.replaceAll('"', '""')}"`;
}

function label(grantee: Grantee): string {
  return grantee === PUBLIC ? 'PUBLIC' : grantee;
}

/** Blanks the statements the replay skips, keeping every line and column where it was. */
function modelledOnly(text: string, file: string): string {
  const lines = text.split('\n');
  for (const statement of parser.parse(text, file).statements) {
    if (statement.kind !== 'Unparseable' && statement.kind !== 'DynamicSql') continue;
    const first = statement.line - 1;
    const blank = statement.text.split('\n').map((l) => l.replace(/\S/g, ' '));
    blank.forEach((replacement, i) => {
      const at = first + i;
      const line = lines[at] ?? '';
      const start = i === 0 ? statement.column - 1 : 0;
      lines[at] = line.slice(0, start) + replacement + line.slice(start + replacement.length);
    });
  }
  return lines.join('\n');
}

/** Everything a role holds on an object, as comparable strings (owner excluded). */
function describeAcl(acl: Acl, privileges: readonly string[], skip: ReadonlySet<string>): string[] {
  return acl
    .grantees()
    .filter((grantee) => grantee === PUBLIC || !skip.has(grantee))
    .flatMap((grantee) =>
      privileges
        .filter((p) => acl.holdsOwn(grantee, p))
        // `columnScoped` also looks at PUBLIC's grant, which is compared too.
        .map((p) => `${label(grantee)} ${p}${acl.columnScoped(grantee, p) ? ' (columns)' : ''}`),
    )
    .sort();
}

interface State {
  readonly relations: Record<string, string[]>;
  readonly sequences: Record<string, string[]>;
  readonly defaults: Record<string, string[]>;
  readonly policies: string[];
}

function defaultsState(
  defaults: DefaultPrivileges,
  schemas: readonly string[],
  version: number,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { creator, schema, kind, acl } of defaults.entries()) {
    if (schema !== null && !schemas.includes(schema)) continue;
    const held = describeAcl(acl, comparedPrivileges(kind, version), new Set([creator]));
    if (held.length > 0) out[`${creator} ${schema ?? '*'} ${kind}`] = held;
  }
  return out;
}

function modelState(catalog: Catalog, config: Config, version: number, owners: Owners): State {
  const inScope = (schema: string) => config.schemas.includes(schema);
  const object = (kind: AclKind, name: string, acl: Acl) =>
    describeAcl(acl, comparedPrivileges(kind, version), new Set([owners.get(name) ?? '']));
  return {
    relations: Object.fromEntries(
      catalog
        .relations()
        .filter((r) => inScope(r.schema))
        .map((r) => {
          const name = `${r.schema}.${r.name}`;
          return [`${name} (${r.kind})`, object('table', name, r.acl)];
        }),
    ),
    sequences: Object.fromEntries(
      catalog
        .sequences()
        .filter((s) => inScope(s.schema))
        .map((s) => {
          const name = `${s.schema}.${s.name}`;
          return [name, object('sequence', name, s.acl)];
        }),
    ),
    defaults: defaultsState(catalog.defaults, config.schemas, version),
    policies: catalog
      .policies()
      .filter((p) => inScope(p.relation.schema))
      .map((p) => policyText(p.relation, p.name, p.command, p.roles))
      .sort(),
  };
}

function policyText(
  relation: { schema: string; name: string },
  name: string,
  command: string,
  roles: readonly Grantee[],
): string {
  return `${relation.schema}.${relation.name} "${name}" ${command} to ${roles.map(label).sort().join(', ')}`;
}

function databaseState(live: LiveSnapshot, schemas: readonly string[], owners: Owners): State {
  const version = live.serverVersion;
  const object = (kind: AclKind, name: string, acl: Acl) =>
    describeAcl(acl, comparedPrivileges(kind, version), new Set([owners.get(name) ?? '']));
  return {
    relations: Object.fromEntries(
      live.relations.map((r) => {
        const name = `${r.schema}.${r.name}`;
        return [`${name} (${r.kind})`, object('table', name, r.acl)];
      }),
    ),
    sequences: Object.fromEntries(
      live.sequences.map((s) => {
        const name = `${s.schema}.${s.name}`;
        return [name, object('sequence', name, s.acl)];
      }),
    ),
    defaults: defaultsState(live.defaults, schemas, version),
    policies: live.policies.map((p) => policyText(p.relation, p.name, p.command, p.roles)).sort(),
  };
}

/** Owner of each relation and sequence (`schema.name`), whose own privileges are not modelled. */
type Owners = ReadonlyMap<string, string>;

async function readOwners(url: string, schemas: readonly string[]): Promise<Owners> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql<{ name: string; owner: string }[]>`
      select n.nspname || '.' || c.relname as name, pg_catalog.pg_get_userbyid(c.relowner) as owner
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${[...schemas]}::text[])`;
    return new Map(rows.map((r) => [r.name, r.owner]));
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** The roles the config and the migrations name, which the project's database already has. */
function rolesNamed(config: Config, files: readonly FileReplay[]): string[] {
  const roles = new Set([...config.clientRoles, config.serviceRole, config.migrationRole]);
  for (const event of files.flatMap((file) => file.events)) {
    const named: readonly Grantee[] =
      event.kind === 'grant'
        ? event.grantees
        : event.kind === 'defaultPrivileges'
          ? [...event.creators, ...event.grantees]
          : event.kind === 'policy'
            ? (event.roles ?? [])
            : event.kind === 'creator'
              ? [event.role]
              : [];
    for (const role of named) if (role !== PUBLIC) roles.add(role);
  }
  return [...roles];
}

/** The platform revoke the replay assumes before a file (ADR-002 item 1), as SQL. */
function platformRevokeSql(creator: string): string {
  const from = 'from anon, authenticated, service_role';
  return [
    `alter default privileges for role ${quote(creator)} in schema public revoke ${PLATFORM_REVOKE.table.join(', ')} on tables ${from};`,
    `alter default privileges for role ${quote(creator)} in schema public revoke ${PLATFORM_REVOKE.sequence.join(', ')} on sequences ${from};`,
  ].join('\n');
}

async function compare(fixture: string): Promise<void> {
  const dir = path.join(ROOT, fixture);
  const configFile = existsSync(path.join(dir, 'config.json')) ? 'config.json' : undefined;
  const { config } = loadConfig({
    cwd: dir,
    projectDir: dir,
    ...(configFile === undefined ? {} : { configFile }),
  });
  const { files } = discoverMigrations({ migrations: 'migrations', projectDir: dir, cwd: dir });
  const texts = files.map((file) => readFileSync(file.path, 'utf8'));
  const replay = replayWithWindow(
    files.map((file, i) => ({
      file: file.relPath,
      version: file.version,
      statements: parser.parse(texts[i] ?? '', file.relPath).statements,
    })),
    config,
  );

  const db = await startDatabase();
  open.push(db);
  for (const role of rolesNamed(config, replay.files)) {
    // Schema privileges are not modelled; any role a file switches to may create in `public`.
    await db.exec(
      `do $$ begin create role ${quote(role)} nologin; ` +
        'exception when duplicate_object then null; end $$;' +
        `grant create on schema public to ${quote(role)};`,
    );
  }
  if (config.platformDefaults === 'explicit') {
    await db.exec(
      'alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;' +
        'alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;',
    );
  }
  const outside = MADE_OUTSIDE_MIGRATIONS[fixture] ?? [];
  for (const name of outside) await db.exec(`create table ${name} (id int);`);

  for (const [i, file] of replay.files.entries()) {
    if (file.events.some((event) => event.kind === 'platformRevoke')) {
      await db.exec(platformRevokeSql(config.migrationRole));
    }
    const sql = modelledOnly(texts[i] ?? '', file.file);
    await db.exec(`set role ${quote(config.migrationRole)};\n${sql}\n;reset role;`);
    const live = await readLive(db.url, config.schemas);
    const owners = await readOwners(db.url, config.schemas);
    const state = databaseState(live, config.schemas, owners);
    const skipped = new Set(outside.map((name) => `${name} (table)`));
    const actual = {
      ...state,
      relations: Object.fromEntries(
        Object.entries(state.relations).filter(([key]) => !skipped.has(key)),
      ),
    };
    expect(actual, `${fixture}: the database after ${file.file}`).toEqual(
      modelState(file.after, config, live.serverVersion, owners),
    );
  }
}

/**
 * Relations a fixture's project made outside its migrations (in the dashboard): created before the
 * first file, and left out of the comparison because the replay cannot know their grants.
 */
const MADE_OUTSIDE_MIGRATIONS: Readonly<Record<string, readonly string[]>> = {
  'GL003/fail/policy-on-unknown-relation': ['public.orders'],
  'GL003/pass/unknown-relation-ignored': ['public.orders'],
};

/** Fixtures whose migrations fail on Postgres on purpose, with the error they must fail with. */
const REJECTED_BY_POSTGRES: Readonly<Record<string, RegExp>> = {
  // The policy's file sorts before the table's (ADR-006 order), as a replay would find out.
  'GL003/fail/policy-before-table-created': /relation "public\.orders" does not exist/,
};

describe('the replay model equals a real Postgres after every file', () => {
  it('covers every rule fixture', () => {
    expect(FIXTURES.length).toBeGreaterThan(200);
    for (const fixture of [
      ...Object.keys(MADE_OUTSIDE_MIGRATIONS),
      ...Object.keys(REJECTED_BY_POSTGRES),
    ]) {
      expect(FIXTURES).toContain(fixture);
    }
  });

  it('runs on the Postgres major CI asks for', async () => {
    const db = await startDatabase();
    open.push(db);
    const { serverVersion } = await readLive(db.url, ['public']);
    const major = process.env.GRANTS_LINT_TEST_PG_MAJOR;
    if (major === undefined) expect(serverVersion).toBeGreaterThanOrEqual(150000);
    else expect(Math.floor(serverVersion / 10000)).toBe(Number(major));
  });

  it.each(FIXTURES)('%s', async (fixture) => {
    const rejected = REJECTED_BY_POSTGRES[fixture];
    if (rejected === undefined) await compare(fixture);
    else await expect(compare(fixture)).rejects.toThrow(rejected);
  });
});
