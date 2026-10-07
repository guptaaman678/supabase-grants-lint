/**
 * Access control lists: which role holds which privilege on one relation or sequence (spec §6.1).
 * An `Acl` is immutable; every change returns a new one, so a model snapshot never sees later state.
 */
import type { Privilege } from '../parse/ir.js';

/** The `PUBLIC` pseudo-role. A symbol, so no role name can collide with it. */
export const PUBLIC: unique symbol = Symbol('PUBLIC');

/** A named role, or `PUBLIC`. */
export type Grantee = string | typeof PUBLIC;

/** Tables, views, materialized views and foreign tables share one privilege set; sequences have their own. */
export type AclKind = 'table' | 'sequence';

export const TABLE_PRIVILEGES = [
  'select',
  'insert',
  'update',
  'delete',
  'truncate',
  'references',
  'trigger',
  'maintain',
] as const;
export type TablePrivilege = (typeof TABLE_PRIVILEGES)[number];

export const SEQUENCE_PRIVILEGES = ['usage', 'select', 'update'] as const;
export type SequencePrivilege = (typeof SEQUENCE_PRIVILEGES)[number];

/** The privileges the Data API needs for reads and writes. */
export const DML_PRIVILEGES = ['select', 'insert', 'update', 'delete'] as const;
export type DmlPrivilege = (typeof DML_PRIVILEGES)[number];

/** The table privileges Postgres allows per column; what `ALL (col, ...)` grants. */
export const COLUMN_PRIVILEGES = ['select', 'insert', 'update', 'references'] as const;

export function privilegesFor(kind: AclKind): readonly string[] {
  return kind === 'table' ? TABLE_PRIVILEGES : SEQUENCE_PRIVILEGES;
}

/** One privilege to grant or revoke: on the whole object (`columns: null`) or on some columns. */
export interface GrantedPrivilege {
  readonly name: string;
  readonly columns: readonly string[] | null;
}

export interface ExpandedPrivileges {
  readonly privileges: readonly GrantedPrivilege[];
  /** Privileges Postgres rejects for this kind (`usage` on a table, `delete (col)`), as written. */
  readonly invalid: readonly string[];
}

/**
 * Turns privileges as written into the ones the ACL records: `ALL [PRIVILEGES]` expands to every
 * privilege of the kind (or every column privilege for `ALL (col, ...)`), and names that are not
 * valid for the kind are reported instead of recorded.
 */
export function expandPrivileges(written: readonly Privilege[], kind: AclKind): ExpandedPrivileges {
  const privileges: GrantedPrivilege[] = [];
  const invalid: string[] = [];
  for (const { name, columns } of written) {
    if (columns !== null && kind === 'sequence') {
      invalid.push(`${name} (${columns.join(', ')})`);
      continue;
    }
    const universe: readonly string[] = columns === null ? privilegesFor(kind) : COLUMN_PRIVILEGES;
    if (name === 'all') {
      for (const expanded of universe) privileges.push({ name: expanded, columns });
    } else if (universe.includes(name)) {
      privileges.push({ name, columns });
    } else {
      invalid.push(columns === null ? name : `${name} (${columns.join(', ')})`);
    }
  }
  return { privileges, invalid };
}

/** How one grantee holds one privilege: on the whole object, on some columns, or both. */
interface Hold {
  readonly object: boolean;
  readonly columns: ReadonlySet<string>;
}

type Holds = ReadonlyMap<string, Hold>;

function toGranted(privilege: string | GrantedPrivilege): GrantedPrivilege {
  return typeof privilege === 'string' ? { name: privilege, columns: null } : privilege;
}

export class Acl {
  static readonly EMPTY = new Acl(new Map());

  readonly #entries: ReadonlyMap<Grantee, Holds>;

  private constructor(entries: ReadonlyMap<Grantee, Holds>) {
    this.#entries = entries;
  }

  /** Adds privileges. A plain string is an object-level privilege. */
  grant(grantees: readonly Grantee[], privileges: readonly (string | GrantedPrivilege)[]): Acl {
    return this.#update(grantees, privileges, (hold, columns) =>
      columns === null
        ? { object: true, columns: hold.columns }
        : { object: hold.object, columns: new Set([...hold.columns, ...columns]) },
    );
  }

  /**
   * Removes privileges. Like Postgres, revoking a privilege on the object also revokes it on every
   * column, while revoking it on some columns leaves an object-level grant in place.
   */
  revoke(grantees: readonly Grantee[], privileges: readonly (string | GrantedPrivilege)[]): Acl {
    return this.#update(grantees, privileges, (hold, columns) =>
      columns === null
        ? { object: false, columns: new Set() }
        : {
            object: hold.object,
            columns: new Set([...hold.columns].filter((c) => !columns.includes(c))),
          },
    );
  }

  /** Effective privilege: the role's own grants union `PUBLIC`'s. Column grants count. */
  holds(role: Grantee, privilege: string): boolean {
    return this.holdsOwn(role, privilege) || this.holdsOwn(PUBLIC, privilege);
  }

  /** The grantee's own grants only, without `PUBLIC`'s. */
  holdsOwn(grantee: Grantee, privilege: string): boolean {
    return this.#entries.get(grantee)?.has(privilege) ?? false;
  }

  /** True when the role holds the privilege, but only on some columns (for messages). */
  columnScoped(role: Grantee, privilege: string): boolean {
    const holds = [
      this.#entries.get(role)?.get(privilege),
      this.#entries.get(PUBLIC)?.get(privilege),
    ];
    return holds.some((h) => h !== undefined) && holds.every((h) => h === undefined || !h.object);
  }

  /**
   * Where the grantee itself (without `PUBLIC`) holds the privilege: `'object'` when on the whole
   * object (column grants beside it add nothing), `'columns'` when only on some columns.
   */
  ownLevel(grantee: Grantee, privilege: string): 'object' | 'columns' | null {
    const hold = this.#entries.get(grantee)?.get(privilege);
    if (hold === undefined) return null;
    return hold.object ? 'object' : 'columns';
  }

  /** The privileges the grantee holds itself (object or column level), sorted. */
  privileges(grantee: Grantee): readonly string[] {
    return [...(this.#entries.get(grantee)?.keys() ?? [])].sort();
  }

  /** Grantees holding at least one privilege, in the order they were first granted one. */
  grantees(): readonly Grantee[] {
    return [...this.#entries.keys()];
  }

  get isEmpty(): boolean {
    return this.#entries.size === 0;
  }

  /** Every grant in either ACL. */
  union(other: Acl): Acl {
    return [...other.#entries].reduce<Acl>(
      (acl, [grantee, holds]) =>
        acl.grant(
          [grantee],
          [...holds].flatMap(([name, hold]) => [
            ...(hold.object ? [name] : []),
            ...(hold.columns.size > 0 ? [{ name, columns: [...hold.columns] }] : []),
          ]),
        ),
      this,
    );
  }

  #update(
    grantees: readonly Grantee[],
    privileges: readonly (string | GrantedPrivilege)[],
    apply: (hold: Hold, columns: readonly string[] | null) => Hold,
  ): Acl {
    const entries = new Map(this.#entries);
    for (const grantee of grantees) {
      const holds = new Map(entries.get(grantee));
      for (const { name, columns } of privileges.map(toGranted)) {
        const next = apply(holds.get(name) ?? { object: false, columns: new Set() }, columns);
        if (next.object || next.columns.size > 0) holds.set(name, next);
        else holds.delete(name);
      }
      if (holds.size > 0) entries.set(grantee, holds);
      else entries.delete(grantee);
    }
    return new Acl(entries);
  }
}
