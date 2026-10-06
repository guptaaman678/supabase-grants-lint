import { describe, expect, it } from 'vitest';
import {
  Acl,
  COLUMN_PRIVILEGES,
  DML_PRIVILEGES,
  expandPrivileges,
  privilegesFor,
  PUBLIC,
  SEQUENCE_PRIVILEGES,
  TABLE_PRIVILEGES,
} from '../../src/model/acl.js';
import { DefaultPrivileges, LEGACY_DEFAULTS } from '../../src/model/defaults.js';
import { admitsNoClient, Catalog, type Policy } from '../../src/model/relations.js';
import type { SourceLocation } from '../../src/parse/ir.js';

const FILE = 'supabase/migrations/20261002120000_add_todos.sql';
const at = (line: number): SourceLocation => ({ file: FILE, line, column: 1 });

const todos = { schema: 'public', name: 'todos' };
const orders = { schema: 'public', name: 'orders' };

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    name: 'owner can read',
    relation: todos,
    command: 'select',
    roles: ['authenticated'],
    permissive: true,
    using: 'other',
    withCheck: null,
    created: at(5),
    altered: null,
    ...overrides,
  };
}

describe('admitsNoClient (ADR-012, ADR-019)', () => {
  it.each([
    ['service_role', null, true],
    [null, 'service_role', true],
    ['service_role', 'service_role', true],
    ['false', null, true],
    [null, 'false', true],
    ['false', 'false', true],
    ['false', 'service_role', true],
    ['service_role', 'false', true],
    [null, null, false],
    ['other', null, false],
    ['service_role', 'other', false],
    ['other', 'service_role', false],
    ['false', 'other', false],
    ['other', 'false', false],
  ] as const)('using %s, with check %s -> %s', (using, withCheck, expected) => {
    expect(admitsNoClient({ using, withCheck })).toBe(expected);
  });
});

describe('privilege sets', () => {
  it('lists table, sequence, DML and column privileges', () => {
    expect(TABLE_PRIVILEGES).toEqual([
      'select',
      'insert',
      'update',
      'delete',
      'truncate',
      'references',
      'trigger',
      'maintain',
    ]);
    expect(SEQUENCE_PRIVILEGES).toEqual(['usage', 'select', 'update']);
    expect(DML_PRIVILEGES).toEqual(['select', 'insert', 'update', 'delete']);
    expect(COLUMN_PRIVILEGES).toEqual(['select', 'insert', 'update', 'references']);
    expect(privilegesFor('table')).toBe(TABLE_PRIVILEGES);
    expect(privilegesFor('sequence')).toBe(SEQUENCE_PRIVILEGES);
  });
});

describe('expandPrivileges', () => {
  it('expands ALL to every privilege of the kind', () => {
    expect(expandPrivileges([{ name: 'all', columns: null }], 'table')).toEqual({
      privileges: TABLE_PRIVILEGES.map((name) => ({ name, columns: null })),
      invalid: [],
    });
    expect(expandPrivileges([{ name: 'all', columns: null }], 'sequence')).toEqual({
      privileges: SEQUENCE_PRIVILEGES.map((name) => ({ name, columns: null })),
      invalid: [],
    });
  });

  it('expands ALL (columns) to the column privileges only', () => {
    expect(expandPrivileges([{ name: 'all', columns: ['title'] }], 'table').privileges).toEqual(
      COLUMN_PRIVILEGES.map((name) => ({ name, columns: ['title'] })),
    );
  });

  it('keeps valid names and column lists as written', () => {
    expect(
      expandPrivileges(
        [
          { name: 'select', columns: null },
          { name: 'update', columns: ['title', 'done'] },
        ],
        'table',
      ),
    ).toEqual({
      privileges: [
        { name: 'select', columns: null },
        { name: 'update', columns: ['title', 'done'] },
      ],
      invalid: [],
    });
    expect(expandPrivileges([{ name: 'usage', columns: null }], 'sequence').privileges).toEqual([
      { name: 'usage', columns: null },
    ]);
  });

  it('reports privileges Postgres rejects for the kind instead of recording them', () => {
    expect(
      expandPrivileges(
        [
          { name: 'usage', columns: null },
          { name: 'delete', columns: ['title'] },
          { name: 'select', columns: null },
          { name: 'truncate', columns: ['title', 'done'] },
        ],
        'table',
      ),
    ).toEqual({
      privileges: [{ name: 'select', columns: null }],
      invalid: ['usage', 'delete (title)', 'truncate (title, done)'],
    });
    expect(
      expandPrivileges(
        [
          { name: 'delete', columns: null },
          { name: 'select', columns: ['a', 'b'] },
        ],
        'sequence',
      ),
    ).toEqual({ privileges: [], invalid: ['delete', 'select (a, b)'] });
  });
});

describe('Acl', () => {
  it('starts empty', () => {
    expect(Acl.EMPTY.isEmpty).toBe(true);
    expect(Acl.EMPTY.grantees()).toEqual([]);
    expect(Acl.EMPTY.holds('anon', 'select')).toBe(false);
    expect(Acl.EMPTY.privileges('anon')).toEqual([]);
  });

  it('records object-level grants per grantee', () => {
    const acl = Acl.EMPTY.grant(['anon', 'authenticated'], ['select', 'insert']);
    expect(acl.isEmpty).toBe(false);
    expect(acl.holds('anon', 'select')).toBe(true);
    expect(acl.holds('authenticated', 'insert')).toBe(true);
    expect(acl.holds('anon', 'delete')).toBe(false);
    expect(acl.holds('service_role', 'select')).toBe(false);
    expect(acl.columnScoped('anon', 'select')).toBe(false);
  });

  it("adds PUBLIC's grants to every role's effective privileges, but not to its own", () => {
    const acl = Acl.EMPTY.grant([PUBLIC], ['select']);
    expect(acl.holds('anon', 'select')).toBe(true);
    expect(acl.holds('service_role', 'select')).toBe(true);
    expect(acl.holds(PUBLIC, 'select')).toBe(true);
    expect(acl.holdsOwn('anon', 'select')).toBe(false);
    expect(acl.holdsOwn(PUBLIC, 'select')).toBe(true);
    expect(acl.holds('anon', 'insert')).toBe(false);
  });

  it('does not confuse a role named "PUBLIC" with the PUBLIC pseudo-role', () => {
    const acl = Acl.EMPTY.grant(['PUBLIC'], ['select']);
    expect(acl.holds('anon', 'select')).toBe(false);
    expect(acl.holdsOwn('PUBLIC', 'select')).toBe(true);
  });

  it('counts column grants as holding the privilege, and marks them column-scoped', () => {
    const acl = Acl.EMPTY.grant(['authenticated'], [{ name: 'update', columns: ['title'] }]);
    expect(acl.holds('authenticated', 'update')).toBe(true);
    expect(acl.columnScoped('authenticated', 'update')).toBe(true);
    expect(acl.columnScoped('authenticated', 'select')).toBe(false);
    expect(acl.columnScoped('anon', 'update')).toBe(false);
  });

  it('is not column-scoped when an object-level grant exists, own or through PUBLIC', () => {
    const cols = [{ name: 'update', columns: ['title'] }];
    const both = Acl.EMPTY.grant(['authenticated'], cols).grant(['authenticated'], ['update']);
    expect(both.columnScoped('authenticated', 'update')).toBe(false);
    const viaPublic = Acl.EMPTY.grant(['authenticated'], cols).grant([PUBLIC], ['update']);
    expect(viaPublic.columnScoped('authenticated', 'update')).toBe(false);
    const publicColumns = Acl.EMPTY.grant([PUBLIC], cols);
    expect(publicColumns.holds('anon', 'update')).toBe(true);
    expect(publicColumns.columnScoped('anon', 'update')).toBe(true);
  });

  it('revokes a privilege on the object together with its column grants', () => {
    const acl = Acl.EMPTY.grant(
      ['anon'],
      ['select', { name: 'select', columns: ['title'] }, 'insert'],
    );
    const revoked = acl.revoke(['anon'], ['select']);
    expect(revoked.holds('anon', 'select')).toBe(false);
    expect(revoked.holds('anon', 'insert')).toBe(true);
  });

  it('keeps an object-level grant when only some columns are revoked', () => {
    const acl = Acl.EMPTY.grant(
      ['anon'],
      ['select', { name: 'select', columns: ['title', 'done'] }],
    );
    const revoked = acl.revoke(['anon'], [{ name: 'select', columns: ['title', 'done'] }]);
    expect(revoked.holds('anon', 'select')).toBe(true);
    expect(revoked.columnScoped('anon', 'select')).toBe(false);
  });

  it('removes only the revoked columns of a column grant', () => {
    const acl = Acl.EMPTY.grant(['anon'], [{ name: 'select', columns: ['title', 'done'] }]);
    const partly = acl.revoke(['anon'], [{ name: 'select', columns: ['title'] }]);
    expect(partly.holds('anon', 'select')).toBe(true);
    expect(partly.columnScoped('anon', 'select')).toBe(true);
    const fully = partly.revoke(['anon'], [{ name: 'select', columns: ['done'] }]);
    expect(fully.holds('anon', 'select')).toBe(false);
    expect(fully.isEmpty).toBe(true);
    const three = Acl.EMPTY.grant(['anon'], [{ name: 'select', columns: ['a', 'b', 'c'] }])
      .revoke(['anon'], [{ name: 'select', columns: ['a'] }])
      .revoke(['anon'], [{ name: 'select', columns: ['b'] }]);
    expect(three.holds('anon', 'select')).toBe(true); // column c is left
  });

  it('drops a grantee once it holds nothing, and ignores revokes from grantees without grants', () => {
    const acl = Acl.EMPTY.grant(['anon', 'authenticated'], ['select']);
    const revoked = acl.revoke(['anon', 'service_role'], ['select', 'delete']);
    expect(revoked.grantees()).toEqual(['authenticated']);
    expect(revoked.revoke(['authenticated'], ['select']).isEmpty).toBe(true);
  });

  it('lists own privileges sorted, and grantees in first-grant order', () => {
    const acl = Acl.EMPTY.grant(['service_role'], ['update', 'delete'])
      .grant([PUBLIC], ['select'])
      .grant(['anon'], [{ name: 'insert', columns: ['title'] }])
      .grant(['service_role'], ['select']);
    expect(acl.privileges('service_role')).toEqual(['delete', 'select', 'update']);
    expect(acl.privileges('anon')).toEqual(['insert']);
    expect(acl.privileges('authenticated')).toEqual([]);
    expect(acl.grantees()).toEqual(['service_role', PUBLIC, 'anon']);
  });

  it('is immutable: grant and revoke return a new ACL', () => {
    const base = Acl.EMPTY.grant(['anon'], ['select']);
    const granted = base.grant(['anon'], ['insert', { name: 'update', columns: ['title'] }]);
    const revoked = base.revoke(['anon'], ['select']);
    expect(base.privileges('anon')).toEqual(['select']);
    expect(granted.privileges('anon')).toEqual(['insert', 'select', 'update']);
    expect(revoked.isEmpty).toBe(true);
    expect(Acl.EMPTY.isEmpty).toBe(true);
  });

  it('unions object-level and column grants of two ACLs', () => {
    const a = Acl.EMPTY.grant(['anon'], ['select']);
    const b = Acl.EMPTY.grant(['anon'], [{ name: 'update', columns: ['title'] }])
      .grant(['authenticated'], ['insert', { name: 'insert', columns: ['done'] }])
      .grant([PUBLIC], ['references']);
    const u = a.union(b);
    expect(u.holds('anon', 'select')).toBe(true);
    expect(u.columnScoped('anon', 'update')).toBe(true);
    expect(u.holds('authenticated', 'insert')).toBe(true);
    expect(u.columnScoped('authenticated', 'insert')).toBe(false);
    expect(
      u
        .revoke(['authenticated'], [{ name: 'insert', columns: ['done'] }])
        .holds('authenticated', 'insert'),
    ).toBe(true);
    expect(u.holdsOwn(PUBLIC, 'references')).toBe(true);
    expect(u.privileges('anon')).toEqual(['select', 'update']);
    expect(a.privileges('authenticated')).toEqual([]);
    expect(Acl.EMPTY.union(Acl.EMPTY).isEmpty).toBe(true);
  });
});

describe('DefaultPrivileges', () => {
  it('starts empty for platformDefaults "explicit"', () => {
    const d = DefaultPrivileges.initial('explicit');
    expect(d.entries()).toEqual([]);
    expect(d.effective('postgres', 'public', 'table').isEmpty).toBe(true);
  });

  it('starts with ALL on tables and sequences for postgres in public for "legacy"', () => {
    expect(LEGACY_DEFAULTS).toEqual({
      creator: 'postgres',
      schema: 'public',
      grantees: ['anon', 'authenticated', 'service_role'],
    });
    const d = DefaultPrivileges.initial('legacy');
    const tables = d.effective('postgres', 'public', 'table');
    const sequences = d.effective('postgres', 'public', 'sequence');
    for (const role of LEGACY_DEFAULTS.grantees) {
      expect(tables.privileges(role)).toEqual([...TABLE_PRIVILEGES].sort());
      expect(sequences.privileges(role)).toEqual([...SEQUENCE_PRIVILEGES].sort());
    }
    expect(tables.holds(PUBLIC, 'select')).toBe(false);
    expect(d.effective('postgres', 'private', 'table').isEmpty).toBe(true);
    expect(d.effective('supabase_admin', 'public', 'table').isEmpty).toBe(true);
    expect(d.entry('postgres', null, 'table').isEmpty).toBe(true);
    expect(d.entries().map(({ creator, schema, kind }) => [creator, schema, kind])).toEqual([
      ['postgres', 'public', 'table'],
      ['postgres', 'public', 'sequence'],
    ]);
  });

  it('keys entries by creator, schema and kind', () => {
    const d = DefaultPrivileges.EMPTY.grant(
      'postgres',
      'public',
      'table',
      ['anon'],
      ['select'],
    ).grant('migrator', 'public', 'sequence', ['anon'], ['usage']);
    expect(d.entry('postgres', 'public', 'table').holds('anon', 'select')).toBe(true);
    expect(d.entry('postgres', 'public', 'sequence').isEmpty).toBe(true);
    expect(d.entry('migrator', 'public', 'table').isEmpty).toBe(true);
    expect(d.entry('migrator', 'public', 'sequence').holds('anon', 'usage')).toBe(true);
    expect(d.entry('postgres', 'api', 'table').isEmpty).toBe(true);
  });

  it('keeps a schema named "null" apart from the all-schemas entry', () => {
    const d = DefaultPrivileges.EMPTY.grant('postgres', 'null', 'table', ['anon'], ['select']);
    expect(d.entry('postgres', null, 'table').isEmpty).toBe(true);
    expect(d.entry('postgres', 'null', 'table').holds('anon', 'select')).toBe(true);
  });

  it('applies all-schemas defaults in every schema, added to the schema entry', () => {
    const d = DefaultPrivileges.EMPTY.grant(
      'postgres',
      null,
      'table',
      ['service_role'],
      ['select'],
    ).grant('postgres', 'public', 'table', ['anon'], ['insert']);
    const pub = d.effective('postgres', 'public', 'table');
    expect(pub.holds('service_role', 'select')).toBe(true);
    expect(pub.holds('anon', 'insert')).toBe(true);
    const api = d.effective('postgres', 'api', 'table');
    expect(api.holds('service_role', 'select')).toBe(true);
    expect(api.holds('anon', 'insert')).toBe(false);
  });

  it('cannot remove an all-schemas grant with a per-schema revoke', () => {
    const d = DefaultPrivileges.EMPTY.grant('postgres', null, 'table', ['anon'], ['select']).revoke(
      'postgres',
      'public',
      'table',
      ['anon'],
      ['select'],
    );
    expect(d.effective('postgres', 'public', 'table').holds('anon', 'select')).toBe(true);
    const cleared = d.revoke('postgres', null, 'table', ['anon'], ['select']);
    expect(cleared.effective('postgres', 'public', 'table').holds('anon', 'select')).toBe(false);
  });

  it('removes an entry once it grants nothing', () => {
    const d = DefaultPrivileges.initial('legacy').revoke(
      'postgres',
      'public',
      'table',
      ['anon', 'authenticated', 'service_role'],
      [...TABLE_PRIVILEGES],
    );
    expect(d.entries().map((e) => e.kind)).toEqual(['sequence']);
  });

  it('models the narrow revoke: TRUNCATE, REFERENCES, TRIGGER and MAINTAIN stay', () => {
    const d = DefaultPrivileges.initial('legacy').revoke(
      'postgres',
      'public',
      'table',
      ['anon', 'authenticated', 'service_role'],
      [...DML_PRIVILEGES],
    );
    expect(d.effective('postgres', 'public', 'table').privileges('anon')).toEqual([
      'maintain',
      'references',
      'trigger',
      'truncate',
    ]);
  });

  it('is immutable, and entries are frozen', () => {
    const legacy = DefaultPrivileges.initial('legacy');
    legacy.revoke('postgres', 'public', 'table', ['anon'], [...TABLE_PRIVILEGES]);
    expect(legacy.effective('postgres', 'public', 'table').holds('anon', 'select')).toBe(true);
    expect(DefaultPrivileges.EMPTY.entries()).toEqual([]);
    expect(Object.isFrozen(legacy.entries()[0])).toBe(true);
  });
});

describe('Catalog', () => {
  const legacy = Catalog.create(DefaultPrivileges.initial('legacy'));

  it('starts empty, with empty defaults unless given', () => {
    const c = Catalog.create();
    expect(c.relations()).toEqual([]);
    expect(c.sequences()).toEqual([]);
    expect(c.policies()).toEqual([]);
    expect(c.defaults).toBe(DefaultPrivileges.EMPTY);
    expect(c.relation(todos)).toBeUndefined();
    expect(c.sequence(todos)).toBeUndefined();
  });

  it("gives a new relation the creator's default table privileges in its schema", () => {
    const c = legacy
      .createRelation(todos, 'table', 'postgres', at(1))
      .createRelation({ schema: 'public', name: 'mine' }, 'view', 'migrator', at(2))
      .createRelation({ schema: 'api', name: 'orders' }, 'table', 'postgres', null);
    const t = c.relation(todos);
    expect(t).toMatchObject({ schema: 'public', name: 'todos', kind: 'table', created: at(1) });
    expect(t?.acl.holds('anon', 'truncate')).toBe(true);
    expect(c.relation({ schema: 'public', name: 'mine' })?.acl.isEmpty).toBe(true);
    expect(c.relation({ schema: 'api', name: 'orders' })?.acl.isEmpty).toBe(true);
    expect(c.relations().map((r) => r.name)).toEqual(['todos', 'mine', 'orders']);
  });

  it('applies defaults at CREATE time only', () => {
    const before = Catalog.create().createRelation(todos, 'table', 'postgres', at(1));
    const after = before.withDefaults(DefaultPrivileges.initial('legacy'));
    expect(after.relation(todos)?.acl.isEmpty).toBe(true);
    expect(
      after
        .createRelation(orders, 'table', 'postgres', at(2))
        .relation(orders)
        ?.acl.holds('anon', 'select'),
    ).toBe(true);
  });

  it('refuses to create a relation or sequence that is already tracked', () => {
    const c = legacy.createRelation(todos, 'table', 'postgres', at(1));
    expect(() => c.createRelation(todos, 'view', 'postgres', at(2))).toThrow('already tracked');
    const s = legacy.createSequence(todos, 'postgres', at(1));
    expect(() => s.createSequence(todos, 'postgres', at(2))).toThrow('already tracked');
  });

  it("gives a new sequence the creator's default sequence privileges, unowned by default", () => {
    const seq = { schema: 'public', name: 'counter' };
    const c = legacy.createSequence(seq, 'postgres', at(3));
    expect(c.sequence(seq)).toMatchObject({ ...seq, created: at(3), ownedBy: null });
    expect(c.sequence(seq)?.acl.privileges('anon')).toEqual(['select', 'update', 'usage']);
    expect(c.sequences()).toHaveLength(1);
  });

  it('finds the sequences owned by serial columns of a relation', () => {
    const c = legacy
      .createRelation(todos, 'table', 'postgres', at(1))
      .createSequence({ schema: 'public', name: 'todos_id_seq' }, 'postgres', at(1), {
        relation: todos,
        column: 'id',
      })
      .createSequence({ schema: 'public', name: 'counter' }, 'postgres', at(2))
      .createSequence({ schema: 'public', name: 'orders_id_seq' }, 'postgres', at(3), {
        relation: orders,
        column: 'id',
      });
    expect(c.ownedSequences(todos).map((s) => s.name)).toEqual(['todos_id_seq']);
    expect(c.ownedSequences({ schema: 'api', name: 'todos' })).toEqual([]);
  });

  it('replaces the ACL of a tracked relation or sequence, and refuses untracked ones', () => {
    const c = legacy
      .createRelation(todos, 'table', 'postgres', at(1))
      .createSequence(orders, 'postgres', at(2));
    const acl = Acl.EMPTY.grant(['service_role'], ['select']);
    const updated = c.setRelationAcl(todos, acl).setSequenceAcl(orders, Acl.EMPTY);
    expect(updated.relation(todos)).toMatchObject({ acl, created: at(1), kind: 'table' });
    expect(updated.sequence(orders)?.acl.isEmpty).toBe(true);
    expect(() => c.setRelationAcl(orders, acl)).toThrow('not tracked');
    expect(() => c.setSequenceAcl(todos, acl)).toThrow('not tracked');
  });

  it('drops a relation with its policies and owned sequences, and nothing else', () => {
    const c = legacy
      .createRelation(todos, 'table', 'postgres', at(1))
      .createRelation(orders, 'table', 'postgres', at(2))
      .createSequence({ schema: 'public', name: 'todos_id_seq' }, 'postgres', at(1), {
        relation: todos,
        column: 'id',
      })
      .createSequence({ schema: 'public', name: 'counter' }, 'postgres', at(3))
      .putPolicy(policy())
      .putPolicy(policy({ relation: orders }));
    const dropped = c.dropRelation(todos);
    expect(dropped.relation(todos)).toBeUndefined();
    expect(dropped.relation(orders)).toBeDefined();
    expect(dropped.sequences().map((s) => s.name)).toEqual(['counter']);
    expect(dropped.policies().map((p) => p.relation.name)).toEqual(['orders']);
    expect(dropped.dropRelation({ schema: 'public', name: 'missing' }).relations()).toHaveLength(1);
  });

  it('drops the policies of a relation it never tracked', () => {
    const c = Catalog.create().putPolicy(policy());
    expect(c.dropRelation(todos).policies()).toEqual([]);
  });

  it('drops a sequence', () => {
    const c = legacy
      .createSequence(orders, 'postgres', at(1))
      .createSequence(todos, 'postgres', at(2));
    expect(
      c
        .dropSequence(orders)
        .sequences()
        .map((s) => s.name),
    ).toEqual(['todos']);
  });

  it('moves the ACL, the created marker and the policies on rename', () => {
    const acl = Acl.EMPTY.grant(['anon'], ['select']);
    const c = Catalog.create()
      .createRelation(todos, 'table', 'postgres', at(1))
      .setRelationAcl(todos, acl)
      .putPolicy(policy())
      .putPolicy(policy({ name: 'owner can write', command: 'insert' }))
      .putPolicy(policy({ relation: orders }));
    const tasks = { schema: 'public', name: 'tasks' };
    const moved = c.moveRelation(todos, tasks);
    expect(moved.relation(todos)).toBeUndefined();
    expect(moved.relation(tasks)).toMatchObject({ ...tasks, kind: 'table', acl, created: at(1) });
    expect(moved.policiesOn(todos)).toEqual([]);
    expect(moved.policiesOn(tasks).map((p) => [p.name, p.relation])).toEqual([
      ['owner can read', tasks],
      ['owner can write', tasks],
    ]);
    expect(moved.policy(tasks, 'owner can read')?.created).toEqual(at(5));
    expect(moved.policiesOn(orders)).toHaveLength(1);
  });

  it('keeps owned sequence names on rename, and moves them with their table to a new schema', () => {
    const seq = { schema: 'public', name: 'todos_id_seq' };
    const c = legacy
      .createRelation(todos, 'table', 'postgres', at(1))
      .createSequence(seq, 'postgres', at(1), { relation: todos, column: 'id' })
      .createSequence({ schema: 'public', name: 'counter' }, 'postgres', at(2))
      .createSequence({ schema: 'public', name: 'orders_id_seq' }, 'postgres', at(3), {
        relation: orders,
        column: 'id',
      });
    const tasks = { schema: 'public', name: 'tasks' };
    const renamed = c.moveRelation(todos, tasks);
    expect(renamed.sequence(seq)?.ownedBy).toEqual({ relation: tasks, column: 'id' });
    expect(renamed.ownedSequences(tasks).map((s) => s.name)).toEqual(['todos_id_seq']);

    const api = { schema: 'api', name: 'todos' };
    const moved = c.moveRelation(todos, api);
    expect(moved.sequence(seq)).toBeUndefined();
    expect(moved.sequence({ schema: 'api', name: 'todos_id_seq' })?.ownedBy).toEqual({
      relation: api,
      column: 'id',
    });
    expect(moved.sequence({ schema: 'public', name: 'counter' })).toBeDefined();
    expect(moved.sequence({ schema: 'public', name: 'orders_id_seq' })).toBeDefined();
  });

  it('moves policies of a relation it never tracked, and moves nothing when there is nothing', () => {
    const tasks = { schema: 'public', name: 'tasks' };
    const c = Catalog.create().putPolicy(policy());
    expect(c.moveRelation(todos, tasks).policiesOn(tasks)).toHaveLength(1);
    const empty = Catalog.create().moveRelation(todos, tasks);
    expect(empty.relations()).toEqual([]);
    expect(empty.policies()).toEqual([]);
  });

  it('refuses to move a relation onto a tracked one', () => {
    const c = legacy
      .createRelation(todos, 'table', 'postgres', at(1))
      .createRelation(orders, 'table', 'postgres', at(2));
    expect(() => c.moveRelation(todos, orders)).toThrow('already tracked');
  });

  it('moves a sequence and keeps its ownership, ignoring untracked sequences', () => {
    const seq = { schema: 'public', name: 'todos_id_seq' };
    const renamed = { schema: 'public', name: 'todo_ids' };
    const c = legacy.createSequence(seq, 'postgres', at(1), { relation: todos, column: 'id' });
    const moved = c.moveSequence(seq, renamed);
    expect(moved.sequence(seq)).toBeUndefined();
    expect(moved.sequence(renamed)).toMatchObject({
      ...renamed,
      ownedBy: { relation: todos, column: 'id' },
    });
    expect(c.moveSequence({ schema: 'public', name: 'missing' }, renamed)).toBe(c);
    expect(() => moved.moveSequence(renamed, renamed)).toThrow('already tracked');
  });

  it('adds, replaces, renames and drops policies', () => {
    const c = Catalog.create()
      .putPolicy(policy())
      .putPolicy(policy({ name: 'b' }));
    expect(c.policy(todos, 'owner can read')?.command).toBe('select');
    expect(c.policy(orders, 'owner can read')).toBeUndefined();
    expect(c.policy(todos, 'missing')).toBeUndefined();

    const altered = c.putPolicy({ ...policy(), roles: [PUBLIC], altered: at(9) });
    expect(altered.policiesOn(todos).map((p) => p.name)).toEqual(['owner can read', 'b']);
    expect(altered.policy(todos, 'owner can read')).toMatchObject({
      roles: [PUBLIC],
      created: at(5),
      altered: at(9),
    });

    const dropped = altered.dropPolicy(todos, 'owner can read');
    expect(dropped.policiesOn(todos).map((p) => p.name)).toEqual(['b']);
    const none = dropped.dropPolicy(todos, 'b');
    expect(none.policies()).toEqual([]);
    expect(none.dropPolicy(todos, 'b').policies()).toEqual([]);
  });

  it('lists every policy, including those on relations it does not track', () => {
    const c = legacy
      .createRelation(todos, 'table', 'postgres', at(1))
      .putPolicy(policy())
      .putPolicy(policy({ relation: orders, name: 'x' }));
    expect(c.policies().map((p) => [p.relation.name, p.name])).toEqual([
      ['todos', 'owner can read'],
      ['orders', 'x'],
    ]);
  });

  it('is immutable: a catalog taken at the end of a file never sees later statements', () => {
    const endOfFile1 = legacy.createRelation(todos, 'table', 'postgres', at(1)).putPolicy(policy());
    const later = endOfFile1
      .setRelationAcl(todos, Acl.EMPTY)
      .putPolicy(policy({ roles: ['anon'], altered: at(20) }))
      .createRelation(orders, 'table', 'postgres', at(21))
      .withDefaults(DefaultPrivileges.EMPTY);
    later.dropRelation(todos).moveRelation(orders, todos).dropPolicy(todos, 'owner can read');

    expect(endOfFile1.relations().map((r) => r.name)).toEqual(['todos']);
    expect(endOfFile1.relation(todos)?.acl.holds('anon', 'select')).toBe(true);
    expect(endOfFile1.policy(todos, 'owner can read')).toMatchObject({
      roles: ['authenticated'],
      altered: null,
    });
    expect(endOfFile1.defaults.entries()).toHaveLength(2);
    expect(later.relation(todos)?.acl.isEmpty).toBe(true);
  });

  it('hands out frozen records, and copies the policy it is given', () => {
    const roles = ['authenticated'];
    const c = legacy
      .createRelation(todos, 'table', 'postgres', at(1))
      .createSequence(orders, 'postgres', at(2))
      .putPolicy(policy({ roles }));
    roles.push('anon');
    const p = c.policy(todos, 'owner can read');
    expect(p?.roles).toEqual(['authenticated']);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p?.roles)).toBe(true);
    expect(Object.isFrozen(p?.relation)).toBe(true);
    expect(Object.isFrozen(c.relation(todos))).toBe(true);
    expect(Object.isFrozen(c.sequence(orders))).toBe(true);
    const list = c.relations() as unknown[];
    list.pop();
    expect(c.relations()).toHaveLength(1);
  });
});
