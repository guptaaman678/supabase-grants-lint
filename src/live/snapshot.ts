/**
 * A read-only picture of a live database's grants (spec T11.1): relation and sequence ACLs, default
 * privileges and policies in the configured schemas, built from the catalog rows `read.ts` fetches.
 * Building it is pure, so GL009 and its tests never need a database.
 */
import { Acl, type Grantee, PUBLIC } from '../model/acl.js';
import { DefaultPrivileges } from '../model/defaults.js';
import type { RelationName } from '../model/relations.js';
import type { PolicyCommand, RelationKind } from '../parse/ir.js';
import { aclFromItems } from './acl-text.js';

/** `pg_class` rows: tables, views, materialized views, foreign tables and sequences. */
export interface RawRelation {
  readonly schema: string;
  readonly name: string;
  /** `pg_class.relkind`. */
  readonly relkind: string;
  readonly acl: readonly string[] | null;
}

/** `pg_attribute` rows with column privileges. */
export interface RawColumnAcl {
  readonly schema: string;
  readonly name: string;
  readonly column: string;
  readonly acl: readonly string[];
}

/** `pg_default_acl` rows. */
export interface RawDefaultAcl {
  readonly creator: string;
  /** `null` for defaults that apply in every schema. */
  readonly schema: string | null;
  /** `r` tables, `S` sequences; other object types are not modelled. */
  readonly objtype: string;
  readonly acl: readonly string[];
}

/** `pg_policies` rows. */
export interface RawPolicy {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /** `ALL`, `SELECT`, `INSERT`, `UPDATE` or `DELETE`. */
  readonly cmd: string;
  /** Role names; `public` is the `PUBLIC` group. */
  readonly roles: readonly string[];
}

export interface RawCatalog {
  /** `server_version_num`, e.g. 150008 or 170002. */
  readonly serverVersion: number;
  readonly relations: readonly RawRelation[];
  readonly columns: readonly RawColumnAcl[];
  readonly defaults: readonly RawDefaultAcl[];
  readonly policies: readonly RawPolicy[];
}

export interface LiveRelation extends RelationName {
  readonly kind: RelationKind;
  readonly acl: Acl;
}

export interface LiveSequence extends RelationName {
  readonly acl: Acl;
}

export interface LivePolicy {
  readonly relation: RelationName;
  readonly name: string;
  readonly command: PolicyCommand;
  readonly roles: readonly Grantee[];
}

export interface LiveSnapshot {
  readonly serverVersion: number;
  readonly relations: readonly LiveRelation[];
  readonly sequences: readonly LiveSequence[];
  readonly defaults: DefaultPrivileges;
  readonly policies: readonly LivePolicy[];
}

const RELATION_KINDS: Readonly<Record<string, RelationKind>> = {
  r: 'table',
  p: 'table',
  v: 'view',
  m: 'materialized view',
  f: 'foreign table',
};

const COMMANDS: Readonly<Record<string, PolicyCommand>> = {
  ALL: 'all',
  SELECT: 'select',
  INSERT: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
};

function key(schema: string, name: string): string {
  return JSON.stringify([schema, name]);
}

export function buildSnapshot(raw: RawCatalog): LiveSnapshot {
  const columnAcls = new Map<string, Acl>();
  for (const { schema, name, column, acl } of raw.columns) {
    const k = key(schema, name);
    columnAcls.set(k, aclFromItems(acl, 'table', columnAcls.get(k), [column]));
  }

  const relations: LiveRelation[] = [];
  const sequences: LiveSequence[] = [];
  for (const { schema, name, relkind, acl } of raw.relations) {
    if (relkind === 'S') {
      sequences.push({ schema, name, acl: aclFromItems(acl, 'sequence') });
      continue;
    }
    const kind = RELATION_KINDS[relkind];
    if (kind === undefined) continue;
    const columns = columnAcls.get(key(schema, name)) ?? Acl.EMPTY;
    relations.push({ schema, name, kind, acl: aclFromItems(acl, 'table', columns) });
  }

  const defaults = raw.defaults.reduce((all, { creator, schema, objtype, acl }) => {
    const kind = objtype === 'r' ? 'table' : objtype === 'S' ? 'sequence' : null;
    if (kind === null) return all;
    const items = aclFromItems(acl, kind);
    return items
      .grantees()
      .reduce(
        (next, grantee) => next.grant(creator, schema, kind, [grantee], items.privileges(grantee)),
        all,
      );
  }, DefaultPrivileges.EMPTY);

  const policies = raw.policies.flatMap((p): LivePolicy[] => {
    const command = COMMANDS[p.cmd];
    if (command === undefined) return [];
    return [
      {
        relation: { schema: p.schema, name: p.table },
        name: p.name,
        command,
        roles: p.roles.map((role) => (role === 'public' ? PUBLIC : role)),
      },
    ];
  });

  return { serverVersion: raw.serverVersion, relations, sequences, defaults, policies };
}
