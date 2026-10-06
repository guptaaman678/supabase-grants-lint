/**
 * `CREATE TABLE | VIEW | MATERIALIZED VIEW | FOREIGN TABLE` and `CREATE SEQUENCE` (spec §6.1).
 * A new object receives the creator role's default privileges; a serial column also creates its
 * owned sequence `<table>_<column>_seq` with the creator's sequence defaults.
 */
import type { CreateRelation, CreateSequence } from '../../parse/ir.js';
import { RLS_OFF, type RelationName, type RowSecurity } from '../../model/relations.js';
import { DEFAULT_SCHEMA, locate, type ReplayContext, resolveName } from '../context.js';

function isTracked(ctx: ReplayContext, name: RelationName): boolean {
  return ctx.catalog.relation(name) !== undefined || ctx.catalog.sequence(name) !== undefined;
}

/**
 * RLS is off at `CREATE`, except for a table (or partition, or `CREATE TABLE AS`) in `public`
 * while automatic RLS applies: the template's trigger enables it there and nowhere else.
 */
function initialRls(stmt: CreateRelation, name: RelationName, ctx: ReplayContext): RowSecurity {
  const auto = ctx.catalog.autoRls();
  if (auto === null || stmt.relationKind !== 'table' || name.schema !== DEFAULT_SCHEMA) {
    return RLS_OFF;
  }
  return { enabled: true, forced: false, source: 'auto-rls', at: auto === 'start' ? null : auto };
}

export function createRelation(stmt: CreateRelation, ctx: ReplayContext): void {
  if (stmt.temporary) return;
  const name = resolveName(stmt.relation);
  // `IF NOT EXISTS` on an existing relation is a no-op, and `OR REPLACE` keeps the view's ACL.
  // A plain duplicate CREATE fails in Postgres; the existing relation is kept either way.
  if (isTracked(ctx, name)) return;
  const at = locate(stmt);
  ctx.catalog = ctx.catalog.createRelation(
    name,
    stmt.relationKind,
    ctx.creator,
    at,
    initialRls(stmt, name, ctx),
  );
  ctx.events.push({
    kind: 'created',
    at,
    object: 'relation',
    name,
    relationKind: stmt.relationKind,
    creator: ctx.creator,
    acl: ctx.catalog.defaults.effective(ctx.creator, name.schema, 'table'),
    ownedBy: null,
  });
  for (const { column } of stmt.serialColumns) {
    const sequence = { schema: name.schema, name: `${name.name}_${column}_seq` };
    // Postgres picks another name when this one is taken; that sequence is not modelled.
    if (isTracked(ctx, sequence)) continue;
    const ownedBy = { relation: name, column };
    ctx.catalog = ctx.catalog.createSequence(sequence, ctx.creator, at, ownedBy);
    ctx.events.push({
      kind: 'created',
      at,
      object: 'sequence',
      name: sequence,
      relationKind: null,
      creator: ctx.creator,
      acl: ctx.catalog.defaults.effective(ctx.creator, name.schema, 'sequence'),
      ownedBy,
    });
  }
}

export function createSequence(stmt: CreateSequence, ctx: ReplayContext): void {
  if (stmt.temporary) return;
  const name = resolveName(stmt.sequence);
  if (isTracked(ctx, name)) return;
  const at = locate(stmt);
  ctx.catalog = ctx.catalog.createSequence(name, ctx.creator, at);
  ctx.events.push({
    kind: 'created',
    at,
    object: 'sequence',
    name,
    relationKind: null,
    creator: ctx.creator,
    acl: ctx.catalog.defaults.effective(ctx.creator, name.schema, 'sequence'),
    ownedBy: null,
  });
}
