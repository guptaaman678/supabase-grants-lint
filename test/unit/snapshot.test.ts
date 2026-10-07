/**
 * The snapshot serializer on hand-built catalogs, and `publicationMembership` on hand-built
 * snapshots (every branch of ADR-017 §3's order).
 */
import { describe, expect, it } from 'vitest';
import { Acl, PUBLIC } from '../../src/model/acl.js';
import { Catalog } from '../../src/model/relations.js';
import {
  publicationMembership,
  type SchemaSnapshot,
  type SnapshotPublication,
  toSnapshot,
} from '../../src/snapshot.js';

const at = { file: 'm.sql', line: 1, column: 1 };
const META = {
  engineVersion: '0.0.0',
  configSource: 'defaults',
  files: 1,
  since: { value: null, source: null },
  parseProblems: 0,
  dynamicSql: 0,
  declarativeFiles: 0,
};

describe('toSnapshot', () => {
  it('copies only file, line and column from statement locations', () => {
    const statement = { ...at, text: 'create table t ()', kind: 'CreateRelation' };
    const catalog = Catalog.create().createRelation(
      { schema: 'public', name: 't' },
      'table',
      'postgres',
      statement,
    );
    expect(toSnapshot(catalog, META).relations[0]?.created).toEqual(at);
  });

  it("writes 'start' for autoRls on and an empty catalog as empty arrays", () => {
    const snapshot = toSnapshot(Catalog.create(undefined, 'on'), META);
    expect(snapshot).toEqual({
      snapshotVersion: 1,
      relations: [],
      sequences: [],
      publications: [],
      meta: { ...META, autoRls: { mode: 'on', active: 'start' }, notes: [] },
    });
  });

  it('sorts publications, their schemas and tables by schema then name', () => {
    const catalog = Catalog.create(undefined, 'auto', ['zeta']).putPublication({
      name: 'alpha',
      origin: 'migration',
      allTables: false,
      schemas: ['public', 'private'],
      tables: [
        { schema: 'public', name: 'todos' },
        { schema: 'private', name: 'scores' },
        { schema: 'public', name: 'orders' },
      ],
      uncertain: at,
      excluded: [
        { schema: 'public', name: 'b' },
        { schema: 'public', name: 'a' },
      ],
    });
    const [alpha, zeta] = toSnapshot(catalog, META).publications;
    expect(zeta?.name).toBe('zeta');
    expect(alpha).toEqual({
      name: 'alpha',
      origin: 'migration',
      allTables: false,
      schemas: ['private', 'public'],
      tables: [
        { schema: 'private', name: 'scores' },
        { schema: 'public', name: 'orders' },
        { schema: 'public', name: 'todos' },
      ],
      uncertain: at,
      excluded: [
        { schema: 'public', name: 'a' },
        { schema: 'public', name: 'b' },
      ],
    });
  });

  it('sorts grantees and keeps object over column grants', () => {
    const acl = Acl.EMPTY.grant(['b', PUBLIC, 'a'], ['select'])
      .grant(['a'], [{ name: 'update', columns: ['x'] }])
      .grant(['b'], [{ name: 'select', columns: ['x'] }]);
    const catalog = Catalog.create()
      .createRelation({ schema: 'public', name: 't' }, 'table', 'postgres', at)
      .setRelationAcl({ schema: 'public', name: 't' }, acl);
    const { privileges } = toSnapshot(catalog, META).relations[0] ?? {};
    expect(Object.keys(privileges ?? {})).toEqual(['a', 'b', 'public']);
    expect(privileges).toEqual({
      a: { select: 'table', update: 'columns' },
      b: { select: 'table' },
      public: { select: 'table' },
    });
  });
});

describe('toSnapshot ordering of names already in order', () => {
  it('keeps tables of one schema in name order', () => {
    const tables = ['a', 'b', 'c', 'd'].map((name) => ({ schema: 'public', name }));
    const catalog = Catalog.create(undefined, 'auto', []).putPublication({
      name: 'p',
      origin: 'migration',
      allTables: false,
      schemas: [],
      tables,
      uncertain: null,
      excluded: [],
    });
    expect(toSnapshot(catalog, META).publications[0]?.tables).toEqual(tables);
  });
});

describe('Acl.ownLevel', () => {
  it("reports the grantee's own level, without PUBLIC", () => {
    const acl = Acl.EMPTY.grant([PUBLIC], ['select']).grant(
      ['anon'],
      [{ name: 'update', columns: ['x'] }],
    );
    expect(acl.ownLevel('anon', 'select')).toBeNull();
    expect(acl.ownLevel('anon', 'update')).toBe('columns');
    expect(acl.ownLevel(PUBLIC, 'select')).toBe('object');
    expect(acl.ownLevel('authenticated', 'select')).toBeNull();
  });
});

function snapshotWith(publication: Partial<SnapshotPublication>): SchemaSnapshot {
  return {
    snapshotVersion: 1,
    relations: [
      {
        schema: 'public',
        name: 'todos',
        kind: 'table',
        created: at,
        rls: { enabled: false, forced: false, source: 'default', at: null },
        privileges: {},
        policies: [],
      },
      {
        schema: 'public',
        name: 'open_todos',
        kind: 'view',
        created: at,
        rls: { enabled: false, forced: false, source: 'default', at: null },
        privileges: {},
        policies: [],
      },
    ],
    sequences: [],
    publications: [
      {
        name: 'pub',
        origin: 'migration',
        allTables: false,
        schemas: [],
        tables: [],
        uncertain: null,
        excluded: [],
        ...publication,
      },
    ],
    meta: { ...META, autoRls: { mode: 'auto', active: null }, notes: [] },
  };
}

describe('publicationMembership', () => {
  const todos = { schema: 'public', name: 'todos' };

  it.each([
    ['no such publication', { tables: [todos] }, 'other', 'public', 'todos', 'no'],
    ['a listed table', { tables: [todos] }, 'pub', 'public', 'todos', 'yes'],
    [
      'a listed table wins over uncertain',
      { tables: [todos], uncertain: at },
      'pub',
      'public',
      'todos',
      'yes',
    ],
    ['all tables, a table', { allTables: true }, 'pub', 'public', 'todos', 'yes'],
    ['all tables, a view', { allTables: true }, 'pub', 'public', 'open_todos', 'no'],
    [
      'all tables, a relation the replay never saw',
      { allTables: true },
      'pub',
      'public',
      'x',
      'yes',
    ],
    ['a listed schema', { schemas: ['public'] }, 'pub', 'public', 'todos', 'yes'],
    ['another schema', { schemas: ['private'] }, 'pub', 'public', 'todos', 'no'],
    [
      'excluded after the mark',
      { uncertain: at, excluded: [todos] },
      'pub',
      'public',
      'todos',
      'no',
    ],
    [
      'excluded in another schema',
      { uncertain: at, excluded: [{ schema: 'x', name: 'todos' }] },
      'pub',
      'public',
      'todos',
      'unknown',
    ],
    ['uncertain', { uncertain: at }, 'pub', 'public', 'todos', 'unknown'],
    [
      'a listed table of the same name in another schema',
      { tables: [{ schema: 'private', name: 'todos' }] },
      'pub',
      'public',
      'todos',
      'no',
    ],
    ['not listed', {}, 'pub', 'public', 'todos', 'no'],
  ] as const)('%s', (_label, publication, pub, schema, name, expected) => {
    expect(publicationMembership(snapshotWith(publication), pub, schema, name)).toBe(expected);
  });
});
