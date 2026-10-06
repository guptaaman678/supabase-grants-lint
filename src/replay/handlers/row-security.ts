/**
 * Row level security, for the engine export: `ALTER TABLE ... ENABLE | DISABLE | FORCE | NO FORCE
 * ROW LEVEL SECURITY`, event triggers, and the function that tells whether Supabase's automatic
 * RLS trigger (`ensure_rls`, calling `public.rls_auto_enable()`) is in place.
 *
 * Everything here is catalog state that grants-lint's rules do not read: no handler records a
 * replay event, so findings, notices, `explain` and `doctor` are unchanged.
 */
import type {
  AlterTableRowSecurity,
  DropFunctions,
  EventTrigger,
  FunctionDefinition,
} from '../../parse/ir.js';
import { AUTO_RLS_FUNCTION, type RowSecurity } from '../../model/relations.js';
import { locate, qualified, type ReplayContext, resolveName } from '../context.js';

export function alterTableRowSecurity(stmt: AlterTableRowSecurity, ctx: ReplayContext): void {
  const name = resolveName(stmt.relation);
  const at = locate(stmt);
  const relation = ctx.catalog.relation(name);
  if (relation === undefined) {
    ctx.catalog = ctx.catalog.addNote({
      code: 'rls-untracked-relation',
      message: `Row level security of ${qualified(name)} is not modelled: the migrations do not create it.`,
      at,
    });
    return;
  }
  let rls: RowSecurity = relation.rls;
  for (const action of stmt.actions) {
    switch (action) {
      case 'enable':
      case 'disable':
        rls = { ...rls, enabled: action === 'enable', source: 'statement', at };
        break;
      case 'force':
      case 'no-force':
        rls = { ...rls, forced: action === 'force' };
        break;
    }
  }
  ctx.catalog = ctx.catalog.setRelationRls(name, rls);
}

export function eventTrigger(stmt: EventTrigger, ctx: ReplayContext): void {
  const { catalog } = ctx;
  switch (stmt.action) {
    case 'create':
      // A duplicate name fails in Postgres; the existing trigger is kept.
      if (catalog.eventTrigger(stmt.name) !== undefined) return;
      ctx.catalog = catalog.putEventTrigger({
        name: stmt.name,
        event: stmt.event,
        tags: stmt.tags,
        function: resolveName(stmt.function),
        state: 'O',
        created: locate(stmt),
      });
      return;
    case 'enable': {
      const trigger = catalog.eventTrigger(stmt.name);
      if (trigger === undefined) return;
      ctx.catalog = catalog.putEventTrigger({ ...trigger, state: stmt.state });
      return;
    }
    case 'rename': {
      const trigger = catalog.eventTrigger(stmt.name);
      if (trigger === undefined || catalog.eventTrigger(stmt.newName) !== undefined) return;
      ctx.catalog = catalog
        .dropEventTrigger(stmt.name)
        .putEventTrigger({ ...trigger, name: stmt.newName });
      return;
    }
    case 'drop':
      ctx.catalog = stmt.names.reduce((c, name) => c.dropEventTrigger(name), catalog);
      return;
  }
}

function isAutoRlsFunction(name: { schema: string; name: string }): boolean {
  return name.schema === AUTO_RLS_FUNCTION.schema && name.name === AUTO_RLS_FUNCTION.name;
}

/** `public.rls_auto_enable()` returning `event_trigger`: the fingerprint a pulled baseline keeps. */
export function functionDefinition(stmt: FunctionDefinition, ctx: ReplayContext): void {
  if (!stmt.returnsEventTrigger || !isAutoRlsFunction(resolveName(stmt.name))) return;
  // `CREATE OR REPLACE` keeps the first definition's location.
  if (ctx.catalog.autoRlsFunction !== null) return;
  ctx.catalog = ctx.catalog.withAutoRlsFunction(locate(stmt));
}

/** Dropping the function removes the fingerprint; `CASCADE` also drops the event triggers using it. */
export function dropFunctions(stmt: DropFunctions, ctx: ReplayContext): void {
  for (const fn of stmt.functions.map(resolveName)) {
    if (isAutoRlsFunction(fn) && ctx.catalog.autoRlsFunction !== null) {
      ctx.catalog = ctx.catalog.withAutoRlsFunction(null);
    }
    if (!stmt.cascade) continue;
    for (const trigger of ctx.catalog.eventTriggers()) {
      if (trigger.function.schema === fn.schema && trigger.function.name === fn.name) {
        ctx.catalog = ctx.catalog.dropEventTrigger(trigger.name);
      }
    }
  }
}
