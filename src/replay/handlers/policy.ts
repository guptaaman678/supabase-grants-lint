/**
 * `CREATE POLICY`, `ALTER POLICY [... TO ...]`, `ALTER POLICY ... RENAME TO` and `DROP POLICY`
 * (spec §6.1), and the policy statements the replay cannot read (`DO` blocks, unparseable ones). Policies are recorded on any relation, including one the replay never saw created,
 * so the rules can warn about it.
 */
import type {
  AlterPolicy,
  CreatePolicy,
  DropPolicy,
  DynamicSql,
  RenamePolicy,
  Unparseable,
} from '../../parse/ir.js';
import type { RelationName } from '../../model/relations.js';
import { locate, type ReplayContext, resolveName, resolveRoles } from '../context.js';

export function createPolicy(stmt: CreatePolicy, ctx: ReplayContext): void {
  const at = locate(stmt);
  const relation = resolveName(stmt.relation);
  const roles = resolveRoles(stmt.roles, ctx);
  ctx.catalog = ctx.catalog.putPolicy({
    name: stmt.name,
    relation,
    command: stmt.command,
    roles,
    permissive: stmt.permissive,
    using: stmt.using,
    withCheck: stmt.withCheck,
    created: at,
    altered: null,
  });
  ctx.events.push({
    kind: 'policy',
    at,
    action: 'create',
    relation,
    name: stmt.name,
    newName: stmt.name,
    known: true,
    command: stmt.command,
    roles,
  });
}

export function alterPolicy(stmt: AlterPolicy, ctx: ReplayContext): void {
  const at = locate(stmt);
  const relation = resolveName(stmt.relation);
  const existing = ctx.catalog.policy(relation, stmt.name);
  const roles = stmt.roles === null ? null : resolveRoles(stmt.roles, ctx);
  if (existing !== undefined) {
    ctx.catalog = ctx.catalog.putPolicy({
      ...existing,
      roles: roles ?? existing.roles,
      using: stmt.using ?? existing.using,
      withCheck: stmt.withCheck ?? existing.withCheck,
      altered: at,
    });
  }
  ctx.events.push({
    kind: 'policy',
    at,
    action: 'alter',
    relation,
    name: stmt.name,
    newName: stmt.name,
    known: existing !== undefined,
    command: existing?.command ?? null,
    roles: roles ?? existing?.roles ?? null,
  });
}

export function renamePolicy(stmt: RenamePolicy, ctx: ReplayContext): void {
  const relation = resolveName(stmt.relation);
  const existing = ctx.catalog.policy(relation, stmt.name);
  if (existing !== undefined && ctx.catalog.policy(relation, stmt.newName) === undefined) {
    ctx.catalog = ctx.catalog
      .dropPolicy(relation, stmt.name)
      .putPolicy({ ...existing, name: stmt.newName });
  }
  ctx.events.push({
    kind: 'policy',
    at: locate(stmt),
    action: 'rename',
    relation,
    name: stmt.name,
    newName: stmt.newName,
    known: existing !== undefined,
    command: existing?.command ?? null,
    roles: existing?.roles ?? null,
  });
}

export function dropPolicy(stmt: DropPolicy, ctx: ReplayContext): void {
  const relation = resolveName(stmt.relation);
  const existing = ctx.catalog.policy(relation, stmt.name);
  ctx.catalog = ctx.catalog.dropPolicy(relation, stmt.name);
  ctx.events.push({
    kind: 'policy',
    at: locate(stmt),
    action: 'drop',
    relation,
    name: stmt.name,
    newName: stmt.name,
    known: existing !== undefined,
    command: existing?.command ?? null,
    roles: existing?.roles ?? null,
  });
}

/**
 * A `DO` block whose body creates, alters or drops a policy makes that relation's policies unknown
 * from the block on (engine only): the replay does not run the body, which often only creates the
 * policy `if not exists`. A relation name built at run time marks every relation that exists at that
 * point. No replay event is recorded, so grants-lint's rules are unaffected.
 */
export function dynamicSqlPolicies(stmt: DynamicSql, ctx: ReplayContext): void {
  if (stmt.policyMentions.length === 0) return;
  const relations = stmt.policyMentions.flatMap((mention): readonly RelationName[] =>
    mention === '*' ? ctx.catalog.relations() : [resolveName(mention)],
  );
  ctx.catalog = ctx.catalog.markPoliciesUncertain(relations, locate(stmt));
}

/**
 * A policy statement the parser rejected (`CREATE POLICY IF NOT EXISTS ... ON t`) makes that
 * relation's policies unknown from the statement on (engine only): no database runs the file as
 * written, so the policies it meant to define are in place, or the file never ran. No replay event
 * is added to the PARSE001 skip, so grants-lint's rules are unaffected.
 */
export function unparseablePolicies(stmt: Unparseable, ctx: ReplayContext): void {
  if (stmt.policyMentions.length === 0) return;
  ctx.catalog = ctx.catalog.markPoliciesUncertain(
    stmt.policyMentions.map(resolveName),
    locate(stmt),
  );
}
