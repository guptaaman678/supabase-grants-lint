/**
 * `ALTER ... RENAME TO` and `ALTER ... SET SCHEMA` (spec §6.1): the ACL, the "created" marker and
 * the policies move with the object. Postgres resolves the name in the one namespace relations and
 * sequences share, so `ALTER TABLE s RENAME` on a sequence moves the sequence.
 */
import type { RenameObject, SetSchema } from '../../parse/ir.js';
import type { RelationName } from '../../model/relations.js';
import { locate, type ReplayContext, resolveName } from '../context.js';

function move(
  stmt: RenameObject | SetSchema,
  from: RelationName,
  to: RelationName,
  ctx: ReplayContext,
): void {
  const { catalog } = ctx;
  // Postgres rejects a move onto a taken name; keep the catalog as it is.
  if (catalog.relation(to) !== undefined || catalog.sequence(to) !== undefined) return;
  const at = locate(stmt);
  if (catalog.relation(from) !== undefined) {
    ctx.catalog = catalog.moveRelation(from, to);
    ctx.events.push({ kind: 'moved', at, object: 'relation', from, to });
  } else if (catalog.sequence(from) !== undefined) {
    ctx.catalog = catalog.moveSequence(from, to);
    ctx.events.push({ kind: 'moved', at, object: 'sequence', from, to });
  } else if (
    stmt.objectKind !== 'sequence' &&
    (catalog.policiesOn(from).length > 0 || catalog.listsInPublication(from))
  ) {
    // A relation created outside the migrations still takes its policies and publications along.
    ctx.catalog = catalog.moveRelation(from, to);
  }
}

export function renameObject(stmt: RenameObject, ctx: ReplayContext): void {
  const from = resolveName(stmt.object);
  move(stmt, from, { schema: from.schema, name: stmt.newName }, ctx);
}

export function setSchema(stmt: SetSchema, ctx: ReplayContext): void {
  const from = resolveName(stmt.object);
  move(stmt, from, { schema: stmt.newSchema, name: from.name }, ctx);
}
