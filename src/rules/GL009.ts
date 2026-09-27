/**
 * GL009 drift (spec T11.1): the live database and the migrations disagree. Runs only in live mode
 * (`diff`, `doctor --db-url`), where the context carries a snapshot of the database; `check` never
 * connects, so GL009 finds nothing there.
 *
 * Compared, in the configured schemas: each relation's and sequence's privileges for the client
 * roles, the service role and `PUBLIC` (one finding per relation, role and direction); relations
 * that exist on one side only; the default privileges of `migrationRole` for new tables and
 * sequences; and policies (existence, command and roles). MAINTAIN is compared only on Postgres 17
 * and later, where it exists. Relations and sequences created by extensions and identity sequences
 * are not read (see `src/live/read.ts`).
 */
import { grantSql } from '../fix/sql.js';
import type { LivePolicy, LiveSnapshot } from '../live/snapshot.js';
import { type Acl, type AclKind, type Grantee, PUBLIC, privilegesFor } from '../model/acl.js';
import type { Policy, RelationName } from '../model/relations.js';
import type { SourceLocation } from '../parse/ir.js';
import { qualified } from '../replay/context.js';
import type { Rule, RuleContext, RuleFinding } from './types.js';

const IN_DATABASE = 'In the database, not in the migrations:';
const IN_MIGRATIONS = 'In the migrations, not in the database:';

type Direction = 'database' | 'migrations';

function label(grantee: Grantee): string {
  return grantee === PUBLIC ? 'PUBLIC' : grantee;
}

/** Where findings about things no migration line created are attached: the last migration file. */
function fallback(ctx: RuleContext): SourceLocation {
  const last = ctx.files.at(-1);
  if (last !== undefined) return { file: last.file, line: 1, column: 1 };
  const { migrations } = ctx.config;
  return {
    file: typeof migrations === 'string' ? migrations : (migrations[0] ?? ''),
    line: 1,
    column: 1,
  };
}

function key({ schema, name }: RelationName): string {
  return JSON.stringify([schema, name]);
}

/** The privileges of `kind` that exist on the server: MAINTAIN only from Postgres 17. */
export function comparedPrivileges(kind: AclKind, serverVersion: number): readonly string[] {
  return privilegesFor(kind).filter((p) => p !== 'maintain' || serverVersion >= 170000);
}

/** The grantees live mode compares: client roles, the service role and `PUBLIC`. */
function grantees(ctx: RuleContext): readonly Grantee[] {
  return [...new Set([...ctx.config.clientRoles, ctx.config.serviceRole]), PUBLIC];
}

interface AclDifference {
  readonly grantee: Grantee;
  readonly direction: Direction;
  readonly privileges: readonly string[];
}

/** Per grantee, what one side holds that the other does not (own grants, any column counts). */
export function aclDifferences(
  migrations: Acl,
  database: Acl,
  who: readonly Grantee[],
  privileges: readonly string[],
): AclDifference[] {
  return who.flatMap((grantee) =>
    (['database', 'migrations'] as const).flatMap((direction): AclDifference[] => {
      const [has, lacks] =
        direction === 'database' ? [database, migrations] : [migrations, database];
      const only = privileges.filter(
        (p) => has.holdsOwn(grantee, p) && !lacks.holdsOwn(grantee, p),
      );
      return only.length === 0 ? [] : [{ grantee, direction, privileges: only }];
    }),
  );
}

function objectDrift(
  at: SourceLocation,
  relation: RelationName,
  kind: AclKind,
  difference: AclDifference,
): RuleFinding {
  const name = qualified(relation);
  const { grantee, direction, privileges } = difference;
  const held = `${label(grantee)} holds ${privileges.join(', ')} on ${kind === 'sequence' ? 'sequence ' : ''}${name}`;
  const message =
    direction === 'database'
      ? `${IN_DATABASE} ${held}. A database built from the migrations (a new project, a preview ` +
        'branch, a local reset) will not have it: add the grant to a migration, or revoke it in ' +
        'the database if it was not meant.'
      : `${IN_MIGRATIONS} the migrations give ${held.replace(' holds ', ' ')}, the database does ` +
        'not. Apply the pending migrations, or find who revoked it.';
  return {
    at,
    message,
    relation,
    role: grantee,
    privilege: privileges.join(', '),
    fix: grantSql({
      privileges,
      relation,
      grantees: [grantee],
      ...(kind === 'sequence' ? { sequence: true } : {}),
    }),
  };
}

function relationDrift(ctx: RuleContext, live: LiveSnapshot): RuleFinding[] {
  const final = ctx.replay.final;
  const who = grantees(ctx);
  const privileges = comparedPrivileges('table', live.serverVersion);
  const inDatabase = new Map(live.relations.map((r) => [key(r), r]));
  const findings: RuleFinding[] = [];
  for (const relation of final.relations()) {
    if (!ctx.inScope(relation)) continue;
    const at = relation.created ?? fallback(ctx);
    const actual = inDatabase.get(key(relation));
    if (actual === undefined) {
      findings.push({
        at,
        relation,
        message:
          `${IN_MIGRATIONS} ${qualified(relation)} does not exist in the database: a migration ` +
          'was not applied, or the relation was dropped or renamed by hand.',
      });
      continue;
    }
    for (const d of aclDifferences(relation.acl, actual.acl, who, privileges)) {
      findings.push(objectDrift(at, relation, 'table', d));
    }
  }
  for (const actual of live.relations) {
    if (!ctx.inScope(actual) || final.relation(actual) !== undefined) continue;
    findings.push({
      at: fallback(ctx),
      relation: actual,
      message:
        `${IN_DATABASE} ${actual.kind} ${qualified(actual)} exists, but no migration creates it ` +
        '(made in the dashboard or the SQL editor?), so check cannot see its grants. Capture it ' +
        'in a migration (supabase db diff).',
    });
  }
  return findings;
}

/** Sequences on both sides only: identity and extension sequences are not read. */
function sequenceDrift(ctx: RuleContext, live: LiveSnapshot): RuleFinding[] {
  const who = grantees(ctx);
  const privileges = comparedPrivileges('sequence', live.serverVersion);
  const inDatabase = new Map(live.sequences.map((s) => [key(s), s]));
  return ctx.replay.final.sequences().flatMap((sequence) => {
    const actual = inDatabase.get(key(sequence));
    if (!ctx.inScope(sequence) || actual === undefined) return [];
    const at = sequence.created ?? fallback(ctx);
    return aclDifferences(sequence.acl, actual.acl, who, privileges).map((d) =>
      objectDrift(at, sequence, 'sequence', d),
    );
  });
}

function defaultsDrift(ctx: RuleContext, live: LiveSnapshot): RuleFinding[] {
  const creator = ctx.config.migrationRole;
  const who = grantees(ctx);
  return ctx.config.schemas.flatMap((schema) =>
    (['table', 'sequence'] as const).flatMap((kind) =>
      aclDifferences(
        ctx.replay.final.defaults.effective(creator, schema, kind),
        live.defaults.effective(creator, schema, kind),
        who,
        comparedPrivileges(kind, live.serverVersion),
      ).map(({ grantee, direction, privileges }): RuleFinding => {
        const what =
          `new ${kind}s that ${creator} creates in schema ${schema} give ${label(grantee)} ` +
          `${privileges.join(', ')} automatically`;
        return {
          at: fallback(ctx),
          role: grantee,
          privilege: privileges.join(', '),
          message:
            direction === 'database'
              ? `${IN_DATABASE} ${what}. The migrations do not: new relations in production get ` +
                'grants that a database built from the migrations will not give them.'
              : `${IN_MIGRATIONS} ${what}, the database does not (opted in from the dashboard, ` +
                'or the 2026-10-30 change). A local reset or preview branch still grants them; ' +
                'add the opt-in migration that supabase-grants-lint doctor prints.',
        };
      }),
    ),
  );
}

function policyKey(relation: RelationName, name: string): string {
  return JSON.stringify([relation.schema, relation.name, name]);
}

function describe(name: string, relation: RelationName): string {
  return `policy "${name}" on ${qualified(relation)}`;
}

function policyDrift(ctx: RuleContext, live: LiveSnapshot): RuleFinding[] {
  const inMigrations = ctx.replay.final.policies().filter((p) => ctx.inScope(p.relation));
  const inDatabase = new Map<string, LivePolicy>(
    live.policies
      .filter((p) => ctx.inScope(p.relation))
      .map((p) => [policyKey(p.relation, p.name), p]),
  );
  const findings: RuleFinding[] = [];
  const seen = new Set<string>();
  for (const policy of inMigrations) {
    const k = policyKey(policy.relation, policy.name);
    seen.add(k);
    const at = policy.altered ?? policy.created;
    const actual = inDatabase.get(k);
    const what = describe(policy.name, policy.relation);
    if (actual === undefined) {
      findings.push({
        at,
        relation: policy.relation,
        message: `${IN_MIGRATIONS} ${what} does not exist in the database.`,
      });
      continue;
    }
    findings.push(...policyDifferences(at, policy, actual));
  }
  for (const [k, actual] of inDatabase) {
    if (seen.has(k)) continue;
    findings.push({
      at: fallback(ctx),
      relation: actual.relation,
      message:
        `${IN_DATABASE} ${describe(actual.name, actual.relation)} exists, but no migration ` +
        'creates it. Capture it in a migration, or drop it if it was not meant.',
    });
  }
  return findings;
}

function policyDifferences(at: SourceLocation, policy: Policy, actual: LivePolicy): RuleFinding[] {
  const what = describe(policy.name, policy.relation);
  const findings: RuleFinding[] = [];
  if (policy.command !== actual.command) {
    findings.push({
      at,
      relation: policy.relation,
      message:
        `${what} is for ${actual.command.toUpperCase()} in the database and for ` +
        `${policy.command.toUpperCase()} in the migrations.`,
    });
  }
  const sides: [Direction, readonly Grantee[], readonly Grantee[]][] = [
    ['database', actual.roles, policy.roles],
    ['migrations', policy.roles, actual.roles],
  ];
  for (const [direction, has, lacks] of sides) {
    for (const role of has.filter((r) => !lacks.includes(r))) {
      findings.push({
        at,
        relation: policy.relation,
        role,
        message: `${direction === 'database' ? IN_DATABASE : IN_MIGRATIONS} ${what} applies to ${label(role)}.`,
      });
    }
  }
  return findings;
}

export const GL009: Rule = {
  id: 'GL009',
  name: 'drift',
  defaultSeverity: 'warn',
  docs: 'The live database has grants, default privileges or policies the migrations do not, or the reverse (diff and doctor --db-url only).',
  check(ctx) {
    const live = ctx.live;
    if (live === undefined) return [];
    return [
      ...relationDrift(ctx, live),
      ...sequenceDrift(ctx, live),
      ...defaultsDrift(ctx, live),
      ...policyDrift(ctx, live),
    ];
  },
};
