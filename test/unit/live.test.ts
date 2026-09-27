import { describe, expect, it } from 'vitest';
import { aclFromItems, parseAclItem } from '../../src/live/acl-text.js';
import { buildSnapshot, type RawCatalog } from '../../src/live/snapshot.js';
import { DB_URL_ENV, redact, resolveDbUrl } from '../../src/live/url.js';
import { Acl, PUBLIC } from '../../src/model/acl.js';

describe('parseAclItem', () => {
  it('reads the grantee and every table privilege letter', () => {
    expect(parseAclItem('anon=arwdDxtm/postgres', 'table')).toEqual({
      grantee: 'anon',
      privileges: [
        'insert',
        'select',
        'update',
        'delete',
        'truncate',
        'references',
        'trigger',
        'maintain',
      ],
    });
  });

  it('reads an empty grantee as PUBLIC', () => {
    expect(parseAclItem('=r/postgres', 'table')).toEqual({
      grantee: PUBLIC,
      privileges: ['select'],
    });
  });

  it('skips the grant option marker and letters the model does not track', () => {
    expect(parseAclItem('authenticated=r*a*X/postgres', 'table').privileges).toEqual([
      'select',
      'insert',
    ]);
  });

  it('reads sequence letters for sequences', () => {
    expect(parseAclItem('anon=rwU/postgres', 'sequence').privileges).toEqual([
      'select',
      'update',
      'usage',
    ]);
    expect(parseAclItem('anon=U/postgres', 'table').privileges).toEqual([]);
  });

  it('unquotes role names, including doubled quotes, "=" and "/" inside them', () => {
    expect(parseAclItem('"My Role"=r/postgres', 'table').grantee).toBe('My Role');
    expect(parseAclItem('"a ""b"" c"=w/"x/y"', 'table')).toEqual({
      grantee: 'a "b" c',
      privileges: ['update'],
    });
    expect(parseAclItem('"a=b/c"=d/postgres', 'table').grantee).toBe('a=b/c');
    expect(parseAclItem('""=r/postgres', 'table').grantee).toBe('');
  });

  it('rejects text Postgres does not produce', () => {
    for (const text of ['anon', 'anon=r', '"anon=r/postgres', 'an"on=r/postgres', '']) {
      expect(() => parseAclItem(text, 'table'), text).toThrow(/Unexpected aclitem/);
    }
  });
});

describe('aclFromItems', () => {
  it('reads NULL as no grants', () => {
    expect(aclFromItems(null, 'table').isEmpty).toBe(true);
  });

  it('builds on a base ACL and records column-level privileges', () => {
    const base = Acl.EMPTY.grant(['anon'], ['select']);
    const acl = aclFromItems(['authenticated=w/postgres'], 'table', base, ['title']);
    expect(acl.holdsOwn('anon', 'select')).toBe(true);
    expect(acl.holdsOwn('authenticated', 'update')).toBe(true);
    expect(acl.columnScoped('authenticated', 'update')).toBe(true);
  });
});

const EMPTY: RawCatalog = {
  serverVersion: 170002,
  relations: [],
  columns: [],
  defaults: [],
  policies: [],
};

describe('buildSnapshot', () => {
  it('maps relation kinds and skips indexes and other kinds', () => {
    const snapshot = buildSnapshot({
      ...EMPTY,
      relations: [
        { schema: 'public', name: 't', relkind: 'r', acl: ['anon=r/postgres'] },
        { schema: 'public', name: 'p', relkind: 'p', acl: null },
        { schema: 'public', name: 'v', relkind: 'v', acl: null },
        { schema: 'public', name: 'm', relkind: 'm', acl: null },
        { schema: 'public', name: 'f', relkind: 'f', acl: null },
        { schema: 'public', name: 'i', relkind: 'i', acl: null },
        { schema: 'public', name: 's', relkind: 'S', acl: ['anon=U/postgres'] },
      ],
    });
    expect(snapshot.serverVersion).toBe(170002);
    expect(snapshot.relations.map((r) => [r.name, r.kind])).toEqual([
      ['t', 'table'],
      ['p', 'table'],
      ['v', 'view'],
      ['m', 'materialized view'],
      ['f', 'foreign table'],
    ]);
    expect(snapshot.relations[0]?.acl.holdsOwn('anon', 'select')).toBe(true);
    expect(snapshot.sequences.map((s) => s.name)).toEqual(['s']);
    expect(snapshot.sequences[0]?.acl.holdsOwn('anon', 'usage')).toBe(true);
  });

  it('adds column privileges of every column to their relation', () => {
    const snapshot = buildSnapshot({
      ...EMPTY,
      relations: [
        { schema: 'public', name: 't', relkind: 'r', acl: null },
        { schema: 'public', name: 'u', relkind: 'r', acl: null },
      ],
      columns: [
        { schema: 'public', name: 't', column: 'a', acl: ['anon=r/postgres'] },
        { schema: 'public', name: 't', column: 'b', acl: ['anon=a/postgres'] },
      ],
    });
    const [t, u] = snapshot.relations;
    expect(t?.acl.holdsOwn('anon', 'select')).toBe(true);
    expect(t?.acl.holdsOwn('anon', 'insert')).toBe(true);
    expect(t?.acl.columnScoped('anon', 'insert')).toBe(true);
    expect(u?.acl.isEmpty).toBe(true);
  });

  it('reads default privileges for tables and sequences, per schema or for all schemas', () => {
    const { defaults } = buildSnapshot({
      ...EMPTY,
      defaults: [
        { creator: 'postgres', schema: 'public', objtype: 'r', acl: ['anon=r/postgres'] },
        { creator: 'postgres', schema: null, objtype: 'r', acl: ['service_role=a/postgres'] },
        { creator: 'postgres', schema: 'public', objtype: 'S', acl: ['anon=U/postgres'] },
        { creator: 'postgres', schema: 'public', objtype: 'f', acl: ['anon=X/postgres'] },
        { creator: 'other', schema: 'public', objtype: 'r', acl: ['anon=d/other'] },
      ],
    });
    const tables = defaults.effective('postgres', 'public', 'table');
    expect(tables.holdsOwn('anon', 'select')).toBe(true);
    expect(tables.holdsOwn('anon', 'delete')).toBe(false);
    expect(tables.holdsOwn('service_role', 'insert')).toBe(true);
    expect(defaults.effective('postgres', 'api', 'table').privileges('service_role')).toEqual([
      'insert',
    ]);
    expect(defaults.effective('postgres', 'public', 'sequence').privileges('anon')).toEqual([
      'usage',
    ]);
    expect(defaults.effective('other', 'public', 'table').privileges('anon')).toEqual(['delete']);
    expect(defaults.entries()).toHaveLength(4);
  });

  it('reads policies, with public as PUBLIC, and skips unknown commands', () => {
    const { policies } = buildSnapshot({
      ...EMPTY,
      policies: [
        { schema: 'public', table: 't', name: 'read', cmd: 'SELECT', roles: ['public'] },
        { schema: 'public', table: 't', name: 'all', cmd: 'ALL', roles: ['anon', 'x'] },
        { schema: 'public', table: 't', name: 'odd', cmd: 'MERGE', roles: ['anon'] },
      ],
    });
    expect(policies).toEqual([
      {
        relation: { schema: 'public', name: 't' },
        name: 'read',
        command: 'select',
        roles: [PUBLIC],
      },
      {
        relation: { schema: 'public', name: 't' },
        name: 'all',
        command: 'all',
        roles: ['anon', 'x'],
      },
    ]);
  });
});

describe('resolveDbUrl', () => {
  const URL_A = 'postgres://admin:s3cret@db.example.com:5432/postgres';
  const URL_B = 'postgresql://admin:s3cret@db.example.com/other?sslmode=require';

  it('prefers --db-url over the environment', () => {
    expect(resolveDbUrl(URL_A, { [DB_URL_ENV]: URL_B })).toBe(URL_A);
    expect(resolveDbUrl(undefined, { [DB_URL_ENV]: URL_B })).toBe(URL_B);
  });

  it('is undefined when neither is set, or the variable is empty', () => {
    expect(resolveDbUrl(undefined, {})).toBeUndefined();
    expect(resolveDbUrl(undefined, { [DB_URL_ENV]: '' })).toBeUndefined();
  });

  it('rejects other URLs as usage errors that never show the value', () => {
    const cases: [string | undefined, Record<string, string>, RegExp][] = [
      ['mysql://u:hunter2@h/db', {}, /^--db-url must start with postgres:\/\//],
      ['hunter2 not a url', {}, /^--db-url is not a valid URL/],
      [undefined, { [DB_URL_ENV]: 'https://u:hunter2@h/' }, /^SUPABASE_DB_URL must start/],
      [undefined, { [DB_URL_ENV]: 'hunter2' }, /^SUPABASE_DB_URL is not a valid URL/],
    ];
    for (const [flag, env, message] of cases) {
      let error: unknown;
      try {
        resolveDbUrl(flag, env);
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ name: 'UsageError', exitCode: 2 });
      const text = (error as Error).message;
      expect(text).toMatch(message);
      expect(text).not.toContain('hunter2');
    }
  });

  it('redacts credentials from any text', () => {
    expect(redact(`failed: ${URL_A}`)).toBe('failed: postgres://***@db.example.com:5432/postgres');
  });
});
