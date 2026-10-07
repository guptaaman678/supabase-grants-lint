/**
 * The engine export's `SchemaSnapshot`: the catalog after the last migration file as plain,
 * deterministic JSON. No symbols, classes, `Map`s or `undefined`; paths are the replay's (relative
 * to the project directory, `/` separators); every array has a fixed order, so the same inputs give
 * byte-identical `JSON.stringify` output on every OS.
 */
import type { AutoRlsMode } from './config/defaults.js';
import { type Acl, type Grantee, PUBLIC } from './model/acl.js';
import type {
  Catalog,
  EngineNote,
  Policy,
  PublicationState,
  Relation,
  RelationName,
  Sequence,
} from './model/relations.js';
import type { PolicyCommand, PolicyPredicate, RelationKind, SourceLocation } from './parse/ir.js';
import type { SinceSource } from './replay/since.js';

export const SNAPSHOT_VERSION = 1;

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
  readonly kind: RelationKind;
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
   * Grantee, then privilege: `'table'` when held on the whole relation, `'columns'` when held only
   * on some columns. Grantee `'public'` is PUBLIC. Keys sorted.
   */
  readonly privileges: Readonly<Record<string, Readonly<Record<string, 'table' | 'columns'>>>>;
  /** Sorted by name. */
  readonly policies: readonly SnapshotPolicy[];
}

export interface SnapshotPolicy {
  readonly name: string;
  readonly command: PolicyCommand;
  /** `'public'` for PUBLIC. */
  readonly roles: readonly string[];
  readonly permissive: boolean;
  readonly using: PolicyPredicate | null;
  readonly withCheck: PolicyPredicate | null;
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
  readonly since: { readonly value: string | null; readonly source: SinceSource | null };
  /** Statements the parser could not read. */
  readonly parseProblems: number;
  /** `DO` blocks. */
  readonly dynamicSql: number;
  /** Declarative schema files found (not replayed). */
  readonly declarativeFiles: number;
  readonly autoRls: {
    readonly mode: AutoRlsMode;
    readonly active: SnapshotLocation | 'start' | null;
  };
  readonly notes: readonly {
    readonly code: string;
    readonly message: string;
    readonly at: SnapshotLocation;
  }[];
}

export interface SchemaSnapshot {
  readonly snapshotVersion: typeof SNAPSHOT_VERSION;
  /** Every tracked relation, in every schema, in creation order. */
  readonly relations: readonly SnapshotRelation[];
  /** In creation order. */
  readonly sequences: readonly SnapshotSequence[];
  /** Sorted by name. */
  readonly publications: readonly SnapshotPublication[];
  readonly meta: SnapshotMeta;
}

/** What the snapshot records besides the catalog. */
export type SnapshotMetaInput = Omit<SnapshotMeta, 'autoRls' | 'notes'>;

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function compareNames(a: RelationName, b: RelationName): number {
  return compare(a.schema, b.schema) || compare(a.name, b.name);
}

function location(at: SourceLocation): SnapshotLocation {
  return { file: at.file, line: at.line, column: at.column };
}

function maybeLocation(at: SourceLocation | null): SnapshotLocation | null {
  return at === null ? null : location(at);
}

function name(of: RelationName): SnapshotName {
  return { schema: of.schema, name: of.name };
}

function names(list: readonly RelationName[]): SnapshotName[] {
  return [...list].sort(compareNames).map(name);
}

function grantee(of: Grantee): string {
  return of === PUBLIC ? 'public' : of;
}

/** The ACL's grantees, written as strings, with their grantee value, sorted. */
function grantees(acl: Acl): [string, Grantee][] {
  return acl
    .grantees()
    .map((g): [string, Grantee] => [grantee(g), g])
    .sort(([a], [b]) => compare(a, b));
}

function relationPrivileges(acl: Acl): SnapshotRelation['privileges'] {
  return Object.fromEntries(
    grantees(acl).map(([written, g]) => [
      written,
      Object.fromEntries(
        acl
          .privileges(g)
          .map((privilege) => [
            privilege,
            acl.ownLevel(g, privilege) === 'object' ? 'table' : 'columns',
          ]),
      ),
    ]),
  );
}

function policy(of: Policy): SnapshotPolicy {
  return {
    name: of.name,
    command: of.command,
    roles: of.roles.map(grantee),
    permissive: of.permissive,
    using: of.using,
    withCheck: of.withCheck,
    created: location(of.created),
    altered: maybeLocation(of.altered),
  };
}

function relation(of: Relation, catalog: Catalog): SnapshotRelation {
  return {
    schema: of.schema,
    name: of.name,
    kind: of.kind,
    created: maybeLocation(of.created),
    rls: {
      enabled: of.rls.enabled,
      forced: of.rls.forced,
      source: of.rls.source,
      at: maybeLocation(of.rls.at),
    },
    privileges: relationPrivileges(of.acl),
    policies: [...catalog.policiesOn(of)].sort((a, b) => compare(a.name, b.name)).map(policy),
  };
}

function sequence(of: Sequence): SnapshotSequence {
  return {
    schema: of.schema,
    name: of.name,
    privileges: Object.fromEntries(
      grantees(of.acl).map(([written, g]) => [written, [...of.acl.privileges(g)]]),
    ),
    ownedBy:
      of.ownedBy === null
        ? null
        : {
            schema: of.ownedBy.relation.schema,
            name: of.ownedBy.relation.name,
            column: of.ownedBy.column,
          },
  };
}

function publication(of: PublicationState): SnapshotPublication {
  return {
    name: of.name,
    origin: of.origin,
    allTables: of.allTables,
    schemas: [...of.schemas].sort(compare),
    tables: names(of.tables),
    uncertain: maybeLocation(of.uncertain),
    excluded: names(of.excluded),
  };
}

function note(of: EngineNote): SnapshotMeta['notes'][number] {
  return { code: of.code, message: of.message, at: location(of.at) };
}

/** The snapshot of a catalog (the replay's `final`). */
export function toSnapshot(catalog: Catalog, meta: SnapshotMetaInput): SchemaSnapshot {
  const active = catalog.autoRls();
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    relations: catalog.relations().map((r) => relation(r, catalog)),
    sequences: catalog.sequences().map(sequence),
    publications: [...catalog.publications()]
      .sort((a, b) => compare(a.name, b.name))
      .map(publication),
    meta: {
      engineVersion: meta.engineVersion,
      configSource: meta.configSource,
      files: meta.files,
      since: { value: meta.since.value, source: meta.since.source },
      parseProblems: meta.parseProblems,
      dynamicSql: meta.dynamicSql,
      declarativeFiles: meta.declarativeFiles,
      autoRls: {
        mode: catalog.autoRlsMode,
        active: active === 'start' ? 'start' : maybeLocation(active),
      },
      notes: catalog.notes().map(note),
    },
  };
}

/**
 * Membership of table `schema.name` in publication `pub`, from the snapshot alone (ADR-017 §3):
 * no such publication, `'no'`; a listed table, `FOR ALL TABLES` (tables only) or a listed schema,
 * `'yes'`; explicitly removed after the uncertain mark, `'no'`; uncertain, `'unknown'`; else `'no'`.
 */
export function publicationMembership(
  snapshot: SchemaSnapshot,
  pub: string,
  schema: string,
  name: string,
): 'yes' | 'no' | 'unknown' {
  const found = snapshot.publications.find((p) => p.name === pub);
  if (found === undefined) return 'no';
  const same = (t: SnapshotName): boolean => t.schema === schema && t.name === name;
  const isTable = (): boolean =>
    snapshot.relations.some((r) => same(r) && r.kind === 'table') || !snapshot.relations.some(same);
  if (found.tables.some(same) || (found.allTables && isTable()) || found.schemas.includes(schema)) {
    return 'yes';
  }
  if (found.excluded.some(same)) return 'no';
  return found.uncertain === null ? 'no' : 'unknown';
}
