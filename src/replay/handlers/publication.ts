/**
 * Publication membership, for the engine export: `CREATE | ALTER | DROP PUBLICATION`, and the
 * bodies the replay does not interpret that may change it (`DO` blocks and called functions,
 * ADR-015). Membership only: row filters, column lists and `publish` options are not kept.
 *
 * Everything here is catalog state that grants-lint's rules do not read: no handler records a
 * replay event, so findings, notices, `explain` and `doctor` are unchanged.
 */
import type {
  DropFunctions,
  DynamicSql,
  FunctionCall,
  FunctionDefinition,
  Publication,
  PublicationMention,
  PublicationObjects,
  SourceLocation,
} from '../../parse/ir.js';
import {
  type Catalog,
  type PublicationState,
  type RelationName,
  sameName,
} from '../../model/relations.js';
import { DEFAULT_SCHEMA, locate, type ReplayContext, resolveName } from '../context.js';

function union(list: readonly RelationName[], more: readonly RelationName[]): RelationName[] {
  const all = [...list];
  for (const t of more) if (!all.some((u) => sameName(t, u))) all.push(t);
  return all;
}

function minus(list: readonly RelationName[], less: readonly RelationName[]): RelationName[] {
  return list.filter((t) => !less.some((u) => sameName(t, u)));
}

function objects(stmt: PublicationObjects): { tables: RelationName[]; schemas: string[] } {
  return {
    tables: union([], stmt.tables.map(resolveName)),
    schemas: [...new Set(stmt.schemas.map((schema) => schema ?? DEFAULT_SCHEMA))],
  };
}

/** A publication the migrations change without creating it: it exists, membership unknown. */
function unseen(name: string, at: SourceLocation): PublicationState {
  return {
    name,
    origin: 'unseen',
    allTables: false,
    schemas: [],
    tables: [],
    uncertain: at,
    excluded: [],
  };
}

export function publication(stmt: Publication, ctx: ReplayContext): void {
  const at = locate(stmt);
  const { catalog } = ctx;
  switch (stmt.action) {
    case 'create': {
      // Postgres rejects a duplicate name; the image's own `supabase_realtime` is the usual case,
      // so the statement is read as a redefinition (ADR-009 item 4) and noted.
      const next =
        catalog.publication(stmt.name) === undefined
          ? catalog
          : catalog.addNote({
              code: 'publication-redefined',
              message: `CREATE PUBLICATION ${stmt.name} redefines a publication that already exists; its earlier membership is replaced.`,
              at,
            });
      ctx.catalog = next.putPublication({
        name: stmt.name,
        origin: 'migration',
        allTables: stmt.allTables,
        ...objects(stmt),
        uncertain: null,
        excluded: [],
      });
      return;
    }
    case 'alter': {
      const current = catalog.publication(stmt.name) ?? unseen(stmt.name, at);
      const { tables, schemas } = objects(stmt);
      // Explicit statements change known members but keep the uncertain mark (ADR-015).
      const removed = (gone: readonly RelationName[]): RelationName[] =>
        current.uncertain === null ? [] : union(current.excluded, gone);
      switch (stmt.op) {
        case 'add':
          ctx.catalog = catalog.putPublication({
            ...current,
            tables: union(current.tables, tables),
            schemas: [...new Set([...current.schemas, ...schemas])],
            excluded: minus(current.excluded, tables),
          });
          return;
        case 'drop':
          ctx.catalog = catalog.putPublication({
            ...current,
            tables: minus(current.tables, tables),
            schemas: current.schemas.filter((s) => !schemas.includes(s)),
            excluded: removed(tables),
          });
          return;
        case 'set':
          ctx.catalog = catalog.putPublication({
            ...current,
            tables,
            schemas,
            excluded: minus(removed(current.tables), tables),
          });
          return;
      }
      return;
    }
    case 'rename': {
      // Postgres rejects a rename onto a taken name; keep the catalog as it is.
      if (catalog.publication(stmt.newName) !== undefined) return;
      const current = catalog.publication(stmt.name) ?? unseen(stmt.name, at);
      ctx.catalog = catalog
        .dropPublication(stmt.name)
        .putPublication({ ...current, name: stmt.newName });
      return;
    }
    case 'drop':
      ctx.catalog = stmt.names.reduce((c, name) => c.dropPublication(name), catalog);
      return;
    case 'noop':
      // `OWNER TO` and `SET (publish = ...)` leave membership as it is, but show the publication exists.
      if (catalog.publication(stmt.name) === undefined) {
        ctx.catalog = catalog.putPublication(unseen(stmt.name, at));
      }
      return;
  }
}

/**
 * Marks what a body may have changed as uncertain from `at` on (ADR-015): each named publication
 * (one never seen is created as `unseen`), or every publication for `'*'`. Earlier exclusions no
 * longer hold, since the body may have added those tables back.
 */
function markUncertain(
  catalog: Catalog,
  mentions: readonly PublicationMention[],
  at: SourceLocation,
): Catalog {
  let next = catalog;
  for (const mention of mentions) {
    if (mention === '*') {
      for (const current of next.publications()) {
        next = next.putPublication({ ...current, uncertain: at, excluded: [] });
      }
      continue;
    }
    const current = next.publication(mention);
    next = next.putPublication(
      current === undefined ? unseen(mention, at) : { ...current, uncertain: at, excluded: [] },
    );
  }
  return next;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a body calls the function (`PERFORM f()`, `SELECT f()`, `CALL f()`), by name only. */
function calls(body: string, name: RelationName): boolean {
  return new RegExp(`(?<![\\w$])"?${escapeRegExp(name.name)}"?\\s*\\(`, 'i').test(body);
}

/** A `DO` block: its own publication mentions, and those of the functions it calls. */
export function dynamicSqlPublications(stmt: DynamicSql, ctx: ReplayContext): void {
  const called = ctx.catalog
    .publicationFunctions()
    .filter((fn) => calls(stmt.body, fn.name))
    .flatMap((fn) => fn.publications);
  const mentions = [...stmt.publicationMentions, ...called];
  if (mentions.length === 0) return;
  ctx.catalog = markUncertain(ctx.catalog, mentions, locate(stmt));
}

/** `CREATE [OR REPLACE] FUNCTION`: remember (or forget) that its body changes publications. */
export function functionPublications(stmt: FunctionDefinition, ctx: ReplayContext): void {
  const name = resolveName(stmt.name);
  if (stmt.publicationMentions.length === 0) {
    if (ctx.catalog.publicationFunction(name) !== undefined) {
      ctx.catalog = ctx.catalog.dropPublicationFunction(name);
    }
    return;
  }
  ctx.catalog = ctx.catalog.putPublicationFunction({
    name,
    publications: stmt.publicationMentions,
  });
}

export function dropPublicationFunctions(stmt: DropFunctions, ctx: ReplayContext): void {
  for (const name of stmt.functions.map(resolveName)) {
    if (ctx.catalog.publicationFunction(name) !== undefined) {
      ctx.catalog = ctx.catalog.dropPublicationFunction(name);
    }
  }
}

/** A top-level call of a function whose body changes publications marks them uncertain. */
export function functionCall(stmt: FunctionCall, ctx: ReplayContext): void {
  const mentions = stmt.functions.flatMap(
    (fn) => ctx.catalog.publicationFunction(resolveName(fn))?.publications ?? [],
  );
  if (mentions.length === 0) return;
  ctx.catalog = markUncertain(ctx.catalog, mentions, locate(stmt));
}
