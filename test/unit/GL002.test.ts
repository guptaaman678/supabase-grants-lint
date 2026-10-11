import { beforeAll, describe, expect, it } from 'vitest';
import { usage } from '../../src/cli/usage.js';
import { type Config, DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { PUBLIC } from '../../src/model/acl.js';
import { loadParser, type MigrationParser } from '../../src/parse/adapter.js';
import { sarifRules } from '../../src/report/sarif.js';
import { replayWithWindow } from '../../src/replay/since.js';
import { API_CLIENT_ROLES, rolesBehind, rolesToGrant } from '../../src/rules/client-roles.js';
import { GL002 } from '../../src/rules/GL002.js';
import { docsUrl, type Finding, RULES, runRules } from '../../src/rules/index.js';

let parser: MigrationParser;

beforeAll(async () => {
  parser = await loadParser();
});

const OPT_IN = `alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;`;

const TODOS = 'create table public.todos (id int, user_id uuid);';

/** Lints each source as a migration after an opt-in (the last ones enforced), with GL002 only. */
function lint(sql: string | readonly string[], config: Partial<Config> = {}): readonly Finding[] {
  const full = { ...DEFAULT_CONFIG, ...config };
  const sources = [OPT_IN, ...(typeof sql === 'string' ? [sql] : sql)];
  const files = sources.map((source, i) => {
    const version = `2026100${String(i + 1)}000000`;
    const file = `supabase/migrations/${version}_m.sql`;
    return { file, version, statements: parser.parse(source, file).statements };
  });
  return runRules({ config: full, replay: replayWithWindow(files, full), rules: [GL002] }).findings;
}

const summary = (findings: readonly Finding[]) =>
  findings.map((f) => `${f.relation ?? ''} ${f.role ?? ''} ${f.fix ?? ''}`);

describe('GL002 unreachable-new-relation', () => {
  it('states the consequence and the fix, anchored at the CREATE statement', () => {
    const findings = lint(
      [
        'select 1;',
        '',
        `  ${TODOS}`,
        'create policy "owners read" on public.todos for select to authenticated using (true);',
      ].join('\n'),
    );
    expect(findings).toEqual([
      {
        ruleId: 'GL002',
        severity: 'error',
        message:
          'public.todos has RLS policies for authenticated, but authenticated holds no select, ' +
          'insert, update or delete privilege on it: every Data API request as authenticated ' +
          'fails with 42501 permission denied before any policy runs. Grant authenticated the ' +
          'commands its policies cover in the same migration.',
        file: 'supabase/migrations/20261002000000_m.sql',
        line: 3,
        column: 3,
        relation: 'public.todos',
        role: 'authenticated',
        fix: 'grant select on public.todos to authenticated;',
        docsUrl: docsUrl('GL002'),
      },
    ]);
    expect(findings[0]?.message).not.toContain(String.fromCodePoint(0x2014)); // G7
  });

  it('treats a policy without TO as PUBLIC and fixes it for authenticated only (ADR-019)', () => {
    const findings = lint(
      `${TODOS}\ncreate policy "anyone reads" on public.todos for select using (true);`,
    );
    expect(findings.map((f) => f.role)).toEqual(['PUBLIC']);
    expect(findings[0]?.fix).toBe('grant select on public.todos to authenticated;');
    expect(findings[0]?.message).toBe(
      'public.todos has RLS policies for PUBLIC, but neither anon nor authenticated holds a ' +
        'select, insert, update or delete privilege on it: every Data API request fails with ' +
        '42501 permission denied before any policy runs. Grant authenticated the commands its ' +
        'policies cover in the same migration, and anon as well only if signed-out visitors ' +
        'should pass the policies.',
    );
  });

  it('clears a PUBLIC finding with its own fix, which grants nothing to anon', () => {
    const sql = `${TODOS}\ncreate policy "anyone reads" on public.todos for select using (true);`;
    const [finding] = lint(sql);
    expect(finding?.fix).not.toMatch(/\banon\b/);
    expect(lint(`${sql}\n${finding?.fix ?? ''}`)).toEqual([]);
  });

  it('passes a PUBLIC policy when either anon or authenticated holds a DML privilege', () => {
    const policy = 'create policy "anyone reads" on public.todos for select using (true);';
    for (const role of ['anon', 'authenticated', 'public']) {
      expect(lint(`${TODOS}\n${policy}\ngrant select on public.todos to ${role};`), role).toEqual(
        [],
      );
    }
  });

  it('reports each named client role that holds no DML privilege', () => {
    const findings = lint(
      [
        TODOS,
        'create policy "guests read" on public.todos for select to anon using (true);',
        'create policy "members write" on public.todos for insert to authenticated with check (true);',
      ].join('\n'),
    );
    expect(summary(findings)).toEqual([
      'public.todos anon grant select on public.todos to anon;',
      'public.todos authenticated grant insert on public.todos to authenticated;',
    ]);
  });

  it('passes a role holding any DML privilege, even one its policies do not cover (GL003 case)', () => {
    for (const privilege of ['select', 'insert', 'update', 'delete', 'select (id)']) {
      expect(
        lint(
          [
            TODOS,
            'create policy "members write" on public.todos for insert to authenticated with check (true);',
            `grant ${privilege} on public.todos to authenticated;`,
          ].join('\n'),
        ),
        privilege,
      ).toEqual([]);
    }
  });

  it('is not satisfied by truncate, references, trigger or maintain', () => {
    const findings = lint(
      [
        TODOS,
        'create policy "members read" on public.todos for select to authenticated using (true);',
        'grant truncate, references, trigger, maintain on public.todos to authenticated;',
      ].join('\n'),
    );
    expect(summary(findings)).toEqual([
      'public.todos authenticated grant select on public.todos to authenticated;',
    ]);
  });

  it('fixes with the union of the commands the role policies cover, ALL meaning all four', () => {
    const union = lint(
      [
        TODOS,
        'create policy "d" on public.todos for delete to authenticated using (true);',
        'create policy "s" on public.todos for select to authenticated, anon using (true);',
        'create policy "u" on public.todos for update to authenticated using (true);',
      ].join('\n'),
    );
    expect(summary(union)).toEqual([
      'public.todos anon grant select on public.todos to anon;',
      'public.todos authenticated grant select, update, delete on public.todos to authenticated;',
    ]);
    const all = lint(
      `${TODOS}\ncreate policy "own rows" on public.todos to authenticated using (true);`,
    );
    expect(all[0]?.fix).toBe(
      'grant select, insert, update, delete on public.todos to authenticated;',
    );
  });

  it('counts grants later in the same file, not grants in a later file', () => {
    const policy = 'create policy "r" on public.todos for select to anon using (true);';
    expect(lint(`${TODOS}\n${policy}\ngrant select on public.todos to anon;`)).toEqual([]);
    const late = lint([`${TODOS}\n${policy}`, 'grant select on public.todos to anon;']);
    expect(late.map((f) => f.file)).toEqual(['supabase/migrations/20261002000000_m.sql']);
  });

  it('counts only policies created in the file, and follows ALTER POLICY ... TO', () => {
    // A policy created in an earlier file (on a table made outside the migrations) and only
    // altered here is GL003's concern, not GL002's.
    expect(
      lint([
        'create policy "r" on public.todos for select to anon using (true);',
        `create table if not exists ${TODOS.slice('create table '.length)}\n` +
          'alter policy "r" on public.todos to anon, authenticated;',
      ]),
    ).toEqual([]);
    const altered = lint(
      [
        TODOS,
        'create policy "r" on public.todos for select to service_role using (true);',
        'alter policy "r" on public.todos to anon;',
      ].join('\n'),
    );
    expect(altered.map((f) => f.role)).toEqual(['anon']);
    const dropped = lint(
      [
        TODOS,
        'create policy "r" on public.todos for select to anon using (true);',
        'drop policy "r" on public.todos;',
      ].join('\n'),
    );
    expect(dropped).toEqual([]);
  });

  it('matches policies to their own relation by schema and name', () => {
    const findings = lint(
      [
        'create schema api;',
        'create table public.todos (id int);',
        'create table public.orders (id int);',
        'create table api.todos (id int);',
        'create policy "r" on api.todos for select to anon using (true);',
        'create policy "r" on public.orders for select to anon using (true);',
      ].join('\n'),
      { schemas: ['public', 'api'] },
    );
    expect(findings.map((f) => `${f.relation ?? ''} ${String(f.line)}`)).toEqual([
      'public.orders 3',
      'api.todos 4',
    ]);
  });

  it('ignores relations without policies, and policies for roles that are not client roles', () => {
    expect(lint(TODOS)).toEqual([]);
    expect(
      lint(
        [
          TODOS,
          'create policy "admin" on public.todos for select to service_role using (true);',
          'create policy "staff" on public.todos for select to staff using (true);',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('checks roles listed in config clientRoles as well as anon and authenticated', () => {
    const sql = [
      TODOS,
      'create policy "staff" on public.todos for select to staff using (true);',
      'create policy "guests" on public.todos for select to anon using (true);',
    ].join('\n');
    expect(lint(sql, { clientRoles: ['staff'] }).map((f) => f.role)).toEqual(['anon', 'staff']);
  });

  it('exempts config serviceOnly relations', () => {
    const sql = `${TODOS}\ncreate policy "r" on public.todos for select to anon using (true);`;
    expect(lint(sql, { serviceOnly: ['todos'] })).toEqual([]);
    expect(lint(sql, { serviceOnly: ['public.orders'] }).map((f) => f.role)).toEqual(['anon']);
  });

  it('checks only enforced files and relations created in them', () => {
    const policy = 'create policy "r" on public.todos for select to anon using (true);';
    const full = { ...DEFAULT_CONFIG, platformDefaults: 'explicit' as const };
    const files = [
      `${TODOS}\n${policy}`,
      OPT_IN,
      'create policy "w" on public.todos for insert to authenticated with check (true);',
    ].map((source, i) => {
      const version = `2026100${String(i + 1)}000000`;
      const file = `supabase/migrations/${version}_m.sql`;
      return { file, version, statements: parser.parse(source, file).statements };
    });
    const replay = replayWithWindow(files, full);
    expect(runRules({ config: full, replay, rules: [GL002] }).findings).toEqual([]);
    const all = replayWithWindow(files, { ...full, since: 'none' });
    expect(
      runRules({ config: { ...full, since: 'none' }, replay: all, rules: [GL002] }).findings.map(
        (f) => `${f.file} ${f.role ?? ''}`,
      ),
    ).toEqual(['supabase/migrations/20261001000000_m.sql anon']);
  });

  it('quotes identifiers in the fix only when Postgres needs it', () => {
    const [finding] = lint(
      'create table public."Order Items" (id int);\ncreate policy "r" on public."Order Items" for select to "Staff" using (true);',
      { clientRoles: ['Staff'] },
    );
    expect(finding?.fix).toBe('grant select on public."Order Items" to "Staff";');
  });
});

describe('client roles', () => {
  it('maps PUBLIC to anon and authenticated, and a role to itself', () => {
    expect(API_CLIENT_ROLES).toEqual(['anon', 'authenticated']);
    expect(rolesBehind(PUBLIC)).toEqual(['anon', 'authenticated']);
    expect(rolesBehind('anon')).toEqual(['anon']);
  });

  it('fixes PUBLIC for authenticated only, and a role for itself (ADR-019 item 2)', () => {
    expect(rolesToGrant(PUBLIC)).toEqual(['authenticated']);
    expect(rolesToGrant('anon')).toEqual(['anon']);
    expect(rolesToGrant('staff')).toEqual(['staff']);
  });
});

describe('GL002 in the rule list', () => {
  it('is registered after GL001', () => {
    expect(RULES.map((r) => r.id).slice(1, 3)).toEqual(['GL001', 'GL002']);
    expect(GL002).toMatchObject({ name: 'unreachable-new-relation', defaultSeverity: 'error' });
  });

  it('appears in --help', () => {
    expect(usage()).toMatch(/^ {2}GL002 +unreachable-new-relation +error$/m);
  });

  it('appears in the SARIF rule descriptors', () => {
    expect(sarifRules().find((d) => d.id === 'GL002')).toEqual({
      id: 'GL002',
      name: 'unreachable-new-relation',
      shortDescription: { text: GL002.docs },
      helpUri: docsUrl('GL002'),
      defaultConfiguration: { level: 'error' },
    });
  });
});
