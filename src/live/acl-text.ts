/**
 * Postgres `aclitem` text, as `relacl::text[]`, `attacl::text[]` and `defaclacl::text[]` return
 * it: `grantee=privileges/grantor`, where an empty grantee is `PUBLIC`, a name with characters other
 * than letters, digits and `_` is double-quoted (`""` inside), and `*` after a privilege letter
 * marks the grant option.
 */
import { Acl, type AclKind, type GrantedPrivilege, type Grantee, PUBLIC } from '../model/acl.js';

/** Privilege letters (Postgres `acl.c`) for the privileges the model tracks. */
const LETTERS: Readonly<Record<AclKind, Readonly<Record<string, string>>>> = {
  table: {
    r: 'select',
    a: 'insert',
    w: 'update',
    d: 'delete',
    D: 'truncate',
    x: 'references',
    t: 'trigger',
    m: 'maintain',
  },
  sequence: { r: 'select', w: 'update', U: 'usage' },
};

export interface AclItem {
  readonly grantee: Grantee;
  /** Privilege names the model tracks for the object kind, in the order Postgres prints them. */
  readonly privileges: readonly string[];
}

/** `grantee=privileges/grantor`; the grantee is quoted (`"a ""b"""`) or bare, possibly empty. */
const ACL_ITEM = /^(?:"((?:[^"]|"")*)"|([^"=]*))=([^/]*)\/.*$/s;

/** Reads one `aclitem`. Throws on text Postgres does not produce. */
export function parseAclItem(text: string, kind: AclKind): AclItem {
  const match = ACL_ITEM.exec(text);
  if (match === null) throw new Error(`Unexpected aclitem ${JSON.stringify(text)}`);
  const [, quoted, bare = '', letters = ''] = match;
  const grantee = quoted === undefined ? bare : quoted.replaceAll('""', '"');
  const names = LETTERS[kind];
  const privileges: string[] = [];
  for (const letter of letters) {
    const name = names[letter];
    if (name !== undefined) privileges.push(name);
  }
  return { grantee: quoted === undefined && bare === '' ? PUBLIC : grantee, privileges };
}

/**
 * The ACL a list of `aclitem`s describes. `NULL` (no grants made yet) is the owner's implicit
 * privileges only, which the model does not track, so it reads as empty. `columns` makes every
 * privilege column-level, for `attacl`.
 */
export function aclFromItems(
  items: readonly string[] | null,
  kind: AclKind,
  base: Acl = Acl.EMPTY,
  columns: readonly string[] | null = null,
): Acl {
  return (items ?? []).reduce((acl, text) => {
    const { grantee, privileges } = parseAclItem(text, kind);
    return acl.grant(
      [grantee],
      privileges.map((name): GrantedPrivilege => ({ name, columns })),
    );
  }, base);
}
