import { beforeAll, describe, expect, it } from 'vitest';
import { usage } from '../../src/cli/usage.js';
import { type Config, DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { loadParser, type MigrationParser } from '../../src/parse/adapter.js';
import { sarifRules } from '../../src/report/sarif.js';
import { replayWithWindow } from '../../src/replay/since.js';
import { GL002 } from '../../src/rules/GL002.js';
import { GL003 } from '../../src/rules/GL003.js';
import { docsUrl, type Finding, type Rule, RULES, runRules } from '../../src/rules/index.js';

let parser: MigrationParser;

beforeAll(async () => {
  parser = await loadParser();
});

const OPT_IN = `alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;`;

const TODOS = 'create table public.todos (id int, user_id uuid);';
const READ = 'create policy "r" on public.todos for select to authenticated using (true);';

/** Lints the sources as consecutive migrations, the first named `..01..`. */
function lintFiles(
  sources: readonly string[],
  config: Partial<Config> = {},
  rules: readonly Rule[] = [GL003],
): readonly Finding[] {
  const full = { ...DEFAULT_CONFIG, ...config };
  const files = sources.map((source, i) => {
    const version = `2026100${String(i + 1)}000000`;
    const file = `supabase/migrations/${version}_m.sql`;
    return { file, version, statements: parser.parse(source, file).statements };
  });
  return runRules({ config: full, replay: replayWithWindow(files, full), rules }).findings;
}

/** Lints each source as a migration after an opt-in (the last ones enforced), with GL003 only. */
function lint(sql: string | readonly string[], config: Partial<Config> = {}): readonly Finding[] {
  return lintFiles([OPT_IN, ...(typeof sql === 'string' ? [sql] : sql)], config);
}

const summary = (findings: readonly Finding[]) =>
  findings.map(
    (f) =>
      `${String(f.line)} ${f.severity} ${f.relation ?? ''} ${f.role ?? ''} ${f.privilege ?? '-'} ${f.fix ?? ''}`,
  );

describe('GL003 dead-policy', () => {
  it('states the consequence and the fix, anchored at the CREATE POLICY statement', () => {
    const findings = lint(
      [TODOS, 'grant insert on public.todos to authenticated;', '', `  ${READ}`].join('\n'),
    );
    expect(findings).toEqual([
      {
        ruleId: 'GL003',
        severity: 'error',
        message:
          'Policy r on public.todos is for select by authenticated, but authenticated holds no ' +
          'select privilege on it: Postgres checks privileges before RLS, so the policy never ' +
          'applies and those requests fail with 42501 permission denied. Grant authenticated the ' +
          'privilege in the same migration, or drop the policy.',
        file: 'supabase/migrations/20261002000000_m.sql',
        line: 4,
        column: 3,
        relation: 'public.todos',
        role: 'authenticated',
        privilege: 'select',
        fix: 'grant select on public.todos to authenticated;',
        docsUrl: docsUrl('GL003'),
      },
    ]);
    expect(findings[0]?.message).not.toContain(String.fromCodePoint(0x2014)); // G7
  });

  it('maps each command to its own privilege', () => {
    const commands = ['select', 'insert', 'update', 'delete'] as const;
    for (const command of commands) {
      const clause = command === 'insert' ? 'with check (true)' : 'using (true)';
      const policy = `create policy "p" on public.todos for ${command} to anon ${clause};`;
      for (const granted of commands) {
        const findings = lint(
          [TODOS, policy, `grant ${granted} on public.todos to anon;`].join('\n'),
        );
        expect(summary(findings), `${command} policy, ${granted} granted`).toEqual(
          granted === command
            ? []
            : [`2 error public.todos anon ${command} grant ${command} on public.todos to anon;`],
        );
      }
    }
  });

  it('is not satisfied by truncate, references, trigger or maintain', () => {
    const findings = lint(
      [
        TODOS,
        'grant truncate, references, trigger, maintain on public.todos to authenticated;',
        READ,
      ].join('\n'),
    );
    expect(findings.map((f) => f.role)).toEqual(['authenticated']);
  });

  it('counts a column grant as holding the privilege', () => {
    expect(lint([TODOS, 'grant select (id) on public.todos to authenticated;', READ])).toEqual([]);
  });

  it('satisfies an ALL policy with any one DML privilege', () => {
    const policy = 'create policy "own" on public.todos to authenticated using (true);';
    for (const privilege of ['select', 'insert', 'update', 'delete', 'update (user_id)']) {
      expect(
        lint([TODOS, policy, `grant ${privilege} on public.todos to authenticated;`].join('\n')),
        privilege,
      ).toEqual([]);
    }
  });

  it('reports an ALL policy with no DML privilege, fixing it with all four', () => {
    const findings = lint(
      [
        TODOS,
        'grant truncate on public.todos to authenticated;',
        'create policy "own" on public.todos for all to authenticated using (true);',
      ].join('\n'),
    );
    expect(summary(findings)).toEqual([
      '3 error public.todos authenticated - grant select, insert, update, delete on public.todos to authenticated;',
    ]);
    expect(findings[0]?.message).toBe(
      'Policy own on public.todos is for every command by authenticated, but authenticated holds ' +
        'no select, insert, update or delete privilege on it: Postgres checks privileges before ' +
        'RLS, so the policy never applies and those requests fail with 42501 permission denied. ' +
        'Grant authenticated the privilege in the same migration, or drop the policy.',
    );
  });

  it('treats a policy without TO as PUBLIC, dead only when neither anon nor authenticated can use it', () => {
    const policy = 'create policy "anyone reads" on public.todos for select using (true);';
    const findings = lint(
      [TODOS, 'grant insert on public.todos to anon, authenticated;', policy].join('\n'),
    );
    expect(summary(findings)).toEqual([
      '3 error public.todos PUBLIC select grant select on public.todos to anon, authenticated;',
    ]);
    expect(findings[0]?.message).toBe(
      'Policy "anyone reads" on public.todos is for select by PUBLIC, but neither anon nor ' +
        'authenticated holds any select privilege on it: Postgres checks privileges before RLS, ' +
        'so the policy never applies and those requests fail with 42501 permission denied. Grant ' +
        'anon and authenticated the privilege in the same migration, or drop the policy.',
    );
    for (const role of ['anon', 'authenticated', 'public']) {
      expect(
        lint([TODOS, policy, `grant select on public.todos to ${role};`].join('\n')),
        role,
      ).toEqual([]);
    }
    const explicit = lint([TODOS, policy.replace('for select', 'for select to public')]);
    expect(explicit.map((f) => f.role)).toEqual(['PUBLIC']);
  });

  it('checks named anon and authenticated individually', () => {
    const findings = lint(
      [
        TODOS,
        'create policy "r" on public.todos for select to anon, authenticated using (true);',
        'grant select on public.todos to authenticated;',
      ].join('\n'),
    );
    expect(summary(findings)).toEqual([
      '2 error public.todos anon select grant select on public.todos to anon;',
    ]);
    // A grant to PUBLIC reaches every role.
    expect(
      lint([
        TODOS,
        'create policy "r" on public.todos for select to anon using (true);\ngrant select on public.todos to public;',
      ]),
    ).toEqual([]);
  });

  it('checks other named roles only when they are in config clientRoles', () => {
    const sql = [
      TODOS,
      'create policy "staff" on public.todos for select to staff using (true);',
      'create policy "admin" on public.todos for select to service_role using (true);',
    ].join('\n');
    expect(lint(sql)).toEqual([]);
    expect(
      lint(sql, { clientRoles: ['anon', 'authenticated', 'staff'] }).map((f) => f.role),
    ).toEqual(['staff']);
  });

  it('warns about a policy on a relation the replay never saw created', () => {
    const findings = lint(
      ['select 1;', 'create policy "r" on public.orders for select to anon using (true);'].join(
        '\n',
      ),
    );
    expect(findings).toEqual([
      {
        ruleId: 'GL003',
        severity: 'warn',
        message:
          'Policy r is on public.orders, which no migration creates (it was probably created ' +
          'outside the migrations, for example in the dashboard), so its grants cannot be ' +
          'checked. Create the table in a migration, or add an ignore entry if it is managed ' +
          'elsewhere.',
        file: 'supabase/migrations/20261002000000_m.sql',
        line: 2,
        column: 1,
        relation: 'public.orders',
        docsUrl: docsUrl('GL003'),
      },
    ]);
    // Created and dropped before the policy: unknown at the policy's file end.
    const dropped = lint([
      'create table public.orders (id int);',
      'drop table public.orders;\ncreate policy "r" on public.orders for select to anon using (true);',
    ]);
    expect(summary(dropped)).toEqual(['2 warn public.orders  - ']);
    // Config severity overrides the per-finding warn.
    expect(
      lint('create policy "r" on public.orders for select to anon using (true);', {
        rules: { GL003: 'error' },
      }).map((f) => f.severity),
    ).toEqual(['error']);
  });

  it('names the later file when the relation is only created after the policy', () => {
    // Corpus shape (T7.3): a policy file sorts before the file that creates its table.
    const findings = lint([
      'create policy "r" on public.orders for select to anon using (true);',
      'select 1;',
      'create table public.orders (id int);',
    ]);
    expect(findings.map((f) => [f.severity, f.file, f.message])).toEqual([
      [
        'warn',
        'supabase/migrations/20261002000000_m.sql',
        'Policy r is on public.orders, which is only created later, in ' +
          'supabase/migrations/20261004000000_m.sql: this file replays first, so replaying the ' +
          'migrations (supabase db reset, a preview branch) fails here, and its grants cannot be ' +
          'checked. Rename the files so the table is created first.',
      ],
    ]);
    // A later file that creates another relation, or creates and drops it again, does not count.
    const other = lint([
      'create policy "r" on public.orders for select to anon using (true);',
      'create table public.todos (id int);\ncreate table public.orders (id int);\ndrop table public.orders;',
    ]);
    expect(other.map((f) => f.message)).toEqual([
      expect.stringContaining('which no migration creates'),
    ]);
    // Neither does an earlier file, or the policy's own file, when the relation is dropped first.
    const earlier = lint([
      'create table public.orders (id int);',
      'drop table public.orders;\ncreate policy "r" on public.orders for select to anon using (true);',
    ]);
    expect(earlier.map((f) => f.message)).toEqual([
      expect.stringContaining('which no migration creates'),
    ]);
  });

  it('checks a policy created earlier and altered in an enforced file, anchored at the ALTER', () => {
    const findings = lint([
      `${TODOS}\ngrant select on public.todos to anon;\ncreate policy "r" on public.todos for select to anon using (true);`,
      'select 1;\nalter policy "r" on public.todos to anon, authenticated;',
    ]);
    expect(findings.map((f) => `${f.file} ${String(f.line)} ${f.role ?? ''}`)).toEqual([
      'supabase/migrations/20261003000000_m.sql 2 authenticated',
    ]);
    // An ALTER without TO re-checks the policy's roles too.
    const using = lint([
      `${TODOS}\ngrant select on public.todos to anon;\n${READ}`,
      'alter policy "r" on public.todos using (auth.uid() is not null);',
    ]);
    expect(summary(using)).toEqual([
      '3 error public.todos authenticated select grant select on public.todos to authenticated;',
      '1 error public.todos authenticated select grant select on public.todos to authenticated;',
    ]);
    expect(using.map((f) => f.file)).toEqual([
      'supabase/migrations/20261002000000_m.sql',
      'supabase/migrations/20261003000000_m.sql',
    ]);
    // Altered to deny every row (ADR-019): no longer client access control, so not re-checked.
    const denyAll = lint([
      `${TODOS}\ngrant select on public.todos to anon;\n${READ}`,
      'alter policy "r" on public.todos using (false);',
    ]);
    expect(denyAll.map((f) => f.file)).toEqual(['supabase/migrations/20261002000000_m.sql']);
  });

  it('anchors at the CREATE when the policy is created and altered in the same file', () => {
    const findings = lint(
      [
        TODOS,
        'create policy "r" on public.todos for select to service_role using (true);',
        'alter policy "r" on public.todos to anon;',
      ].join('\n'),
    );
    expect(findings.map((f) => `${String(f.line)} ${f.role ?? ''}`)).toEqual(['2 anon']);
  });

  it('counts grants later in the same file, not grants or revokes in a later file', () => {
    expect(lint(`${TODOS}\n${READ}\ngrant select on public.todos to authenticated;`)).toEqual([]);
    const late = lint([`${TODOS}\n${READ}`, 'grant select on public.todos to authenticated;']);
    expect(late.map((f) => f.file)).toEqual(['supabase/migrations/20261002000000_m.sql']);
    // Policies untouched in a later file are not re-checked there.
    expect(
      lint([
        `${TODOS}\n${READ}\ngrant select on public.todos to authenticated;`,
        'revoke select on public.todos from authenticated;',
      ]),
    ).toEqual([]);
  });

  it('ignores dropped policies and policies on dropped relations', () => {
    expect(lint(`${TODOS}\n${READ}\ndrop policy "r" on public.todos;`)).toEqual([]);
    expect(lint(`${TODOS}\n${READ}\ndrop table public.todos;`)).toEqual([]);
  });

  it('matches the policy to its own relation by schema and name', () => {
    const findings = lint(
      [
        'create schema api;',
        'create table public.todos (id int);',
        'create table api.todos (id int);',
        'grant select on public.todos to anon;',
        'create policy "r" on public.todos for select to anon using (true);',
        'create policy "r" on api.todos for select to anon using (true);',
      ].join('\n'),
      { schemas: ['public', 'api'] },
    );
    expect(findings.map((f) => `${String(f.line)} ${f.relation ?? ''}`)).toEqual(['6 api.todos']);
    expect(
      lint('create schema api;\ncreate policy "r" on api.todos for select to anon using (true);'),
    ).toEqual([]);
  });

  it('exempts config serviceOnly relations from the role checks', () => {
    const sql = `${TODOS}\n${READ}`;
    expect(lint(sql, { serviceOnly: ['public.todos'] })).toEqual([]);
    expect(lint(sql, { serviceOnly: ['orders'] }).map((f) => f.role)).toEqual(['authenticated']);
  });

  it('checks only enforced files', () => {
    const files = [`${TODOS}\n${READ}`, OPT_IN, 'select 1;'];
    const explicit = { platformDefaults: 'explicit' as const };
    expect(lintFiles(files, explicit)).toEqual([]);
    expect(lintFiles(files, { ...explicit, since: 'none' }).map((f) => f.file)).toEqual([
      'supabase/migrations/20261001000000_m.sql',
    ]);
  });

  it('quotes the policy name and the fix identifiers only when Postgres needs it', () => {
    const [finding] = lint(
      'create table public."Order Items" (id int);\ncreate policy "Staff read" on public."Order Items" for select to "Staff" using (true);',
      { clientRoles: ['Staff'] },
    );
    expect(finding?.fix).toBe('grant select on public."Order Items" to "Staff";');
    // Relations are named as the other rules name them: schema.name, unquoted.
    expect(finding?.message).toMatch(/^Policy "Staff read" on public\.Order Items is for select/);
  });
});

describe('GL002 takes precedence over GL003 on a new relation', () => {
  const sql = [OPT_IN, `${TODOS}\n${READ}`];

  it('reports GL002 alone for the same relation, role and file', () => {
    expect(lintFiles(sql, {}, [GL002, GL003]).map((f) => `${f.ruleId} ${f.role ?? ''}`)).toEqual([
      'GL002 authenticated',
    ]);
  });

  it('reports GL003 when GL002 is off, and for the other roles GL002 does not cover', () => {
    expect(
      lintFiles(sql, { rules: { GL002: 'off' } }, [GL002, GL003]).map((f) => f.ruleId),
    ).toEqual(['GL003']);
    const mixed = lintFiles(
      [
        OPT_IN,
        `${TODOS}\ngrant insert on public.todos to anon;\ncreate policy "r" on public.todos for select to anon, authenticated using (true);`,
      ],
      {},
      [GL002, GL003],
    );
    expect(mixed.map((f) => `${f.ruleId} ${f.role ?? ''}`)).toEqual([
      'GL002 authenticated',
      'GL003 anon',
    ]);
  });
});

describe('GL003 in the rule list', () => {
  it('is registered after GL002', () => {
    expect(RULES.map((r) => r.id).slice(1, 4)).toEqual(['GL001', 'GL002', 'GL003']);
    expect(GL003).toMatchObject({ name: 'dead-policy', defaultSeverity: 'error' });
  });

  it('appears in --help', () => {
    expect(usage()).toMatch(/^ {2}GL003 +dead-policy +error$/m);
  });

  it('appears in the SARIF rule descriptors', () => {
    expect(sarifRules().find((d) => d.id === 'GL003')).toEqual({
      id: 'GL003',
      name: 'dead-policy',
      shortDescription: { text: GL003.docs },
      helpUri: docsUrl('GL003'),
      defaultConfiguration: { level: 'error' },
    });
  });
});
