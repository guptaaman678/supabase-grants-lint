import { beforeAll, describe, expect, it } from 'vitest';
import { type Config, DEFAULT_CONFIG, RULE_IDS, type RuleId } from '../../src/config/defaults.js';
import { validateConfig } from '../../src/config/validate.js';
import { ConfigError, UsageError } from '../../src/errors.js';
import { PUBLIC } from '../../src/model/acl.js';
import type { RelationName } from '../../src/model/relations.js';
import { loadParser, type MigrationParser, type ParsedFile } from '../../src/parse/adapter.js';
import { replayWithWindow, type WindowedReplay } from '../../src/replay/since.js';
import {
  compareFindings,
  createContext,
  docsUrl,
  type Finding,
  granteeLabel,
  matchesFile,
  matchesRelation,
  type Rule,
  type RuleContext,
  type RuleFinding,
  RULES,
  runRules,
  type RunRulesOptions,
} from '../../src/rules/index.js';
import { version } from '../../src/version.js';

let parser: MigrationParser;

beforeAll(async () => {
  parser = await loadParser();
});

const OPT_IN = `alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;`;

function versionOf(n: number): string {
  return `202610010000${String(n).padStart(2, '0')}`;
}

function pathOf(n: number): string {
  return `supabase/migrations/${versionOf(n)}_m${String(n)}.sql`;
}

interface Project {
  readonly replay: WindowedReplay;
  readonly parsed: readonly ParsedFile[];
}

function project(sources: readonly string[], config: Partial<Config> = {}): Project {
  const full = { ...DEFAULT_CONFIG, ...config };
  const parsed = sources.map((sql, i) => parser.parse(sql, pathOf(i + 1)));
  const replay = replayWithWindow(
    parsed.map((p, i) => ({ file: p.file, version: versionOf(i + 1), statements: p.statements })),
    { ...full },
  );
  return { replay, parsed };
}

function run(
  sources: readonly string[],
  rules: readonly Rule[],
  config: Partial<Config> = {},
  extra: Partial<RunRulesOptions> = {},
): ReturnType<typeof runRules> {
  const { replay, parsed } = project(sources, config);
  return runRules({
    config: { ...DEFAULT_CONFIG, ...config },
    replay,
    suppressions: parsed.flatMap((p) => p.suppressions),
    suppressionProblems: parsed.flatMap((p) => p.suppressionProblems),
    rules,
    ...extra,
  });
}

function rule(
  id: RuleId,
  check: (ctx: RuleContext) => RuleFinding[],
  defaultSeverity: Rule['defaultSeverity'] = 'error',
): Rule {
  return {
    id,
    name: `test-${id.toLowerCase()}`,
    defaultSeverity,
    docs: 'A rule for tests.',
    check,
  };
}

/** One finding per relation created in an enforced file, at its CREATE statement. */
function perCreated(id: RuleId, extra: Partial<RuleFinding> = {}): Rule {
  return rule(id, (ctx) =>
    ctx.enforced.flatMap((file) =>
      file.created.map((relation): RuleFinding => ({
        at: relation.created,
        message: `${relation.name} found`,
        relation,
        ...extra,
      })),
    ),
  );
}

const T = (name: string): RelationName => ({ schema: 'public', name });

describe('rule registry', () => {
  it('holds each implemented rule once, with a known ID, in ID order', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(RULE_IDS).toContain(id);
    expect(ids).toEqual([...ids].sort((a, b) => RULE_IDS.indexOf(a) - RULE_IDS.indexOf(b)));
    for (const r of RULES) {
      expect(r.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(r.docs).not.toBe('');
      expect(r.docs).not.toContain(String.fromCodePoint(0x2014)); // G7: no em dash
    }
  });

  it('pins docs URLs to the release tag', () => {
    expect(docsUrl('GL001', '0.1.0')).toBe(
      'https://github.com/guptaaman678/supabase-grants-lint/blob/v0.1.0/docs/rules/GL001.md',
    );
    expect(docsUrl('PARSE002')).toBe(
      `https://github.com/guptaaman678/supabase-grants-lint/blob/v${version}/docs/rules/PARSE002.md`,
    );
  });
});

describe('rule context', () => {
  it('exposes every file and the enforced ones, with end-of-file snapshots', () => {
    const { replay } = project([
      'create table todos (id int);',
      OPT_IN,
      'create table orders (id int);',
    ]);
    const ctx = createContext(DEFAULT_CONFIG, replay);
    expect(ctx.files.map((f) => [f.file, f.enforced])).toEqual([
      [pathOf(1), false],
      [pathOf(2), false],
      [pathOf(3), true],
    ]);
    expect(ctx.enforced.map((f) => f.file)).toEqual([pathOf(3)]);
    const last = ctx.enforced[0];
    expect(last?.created.map((r) => r.name)).toEqual(['orders']);
    expect(last?.after.relation(T('todos'))).toBeDefined();
    expect(last?.before.relation(T('orders'))).toBeUndefined();
    expect(ctx.replay).toBe(replay);
    expect(ctx.discovery).toEqual([]);
  });

  it('answers scope, client role and service-only questions from config', () => {
    const { replay } = project([]);
    const ctx = createContext(
      {
        ...DEFAULT_CONFIG,
        schemas: ['public', 'api'],
        clientRoles: ['anon', 'authenticated', 'app_user'],
        serviceOnly: ['audit_log', 'private.jobs'],
      },
      replay,
    );
    expect(ctx.inScope({ schema: 'api', name: 'x' })).toBe(false); // replay was built with ["public"]
    expect(ctx.inScope(T('x'))).toBe(true);
    expect(ctx.isClientRole('app_user')).toBe(true);
    expect(ctx.isClientRole('anon')).toBe(true);
    expect(ctx.isClientRole('service_role')).toBe(false);
    expect(ctx.isClientRole(PUBLIC)).toBe(false);
    expect(ctx.isServiceOnly(T('audit_log'))).toBe(true);
    expect(ctx.isServiceOnly({ schema: 'api', name: 'audit_log' })).toBe(true);
    expect(ctx.isServiceOnly({ schema: 'private', name: 'jobs' })).toBe(true);
    expect(ctx.isServiceOnly(T('jobs'))).toBe(false);
    expect(ctx.isServiceOnly(T('todos'))).toBe(false);
  });

  it('is frozen, so a rule cannot change what the next rule sees', () => {
    const { replay } = project(['create table todos (id int);']);
    const tamper = rule('GL001', (ctx) => {
      (ctx as { files: unknown }).files = [];
      return [];
    });
    expect(() => runRules({ config: DEFAULT_CONFIG, replay, rules: [tamper] })).toThrow(TypeError);
    const ctx = createContext(DEFAULT_CONFIG, replay);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.files)).toBe(true);
    expect(Object.isFrozen(ctx.files[0])).toBe(true);
    expect(Object.isFrozen(ctx.enforced)).toBe(true);
  });
});

describe('running rules', () => {
  const SQL = [
    'create table todos (id int);',
    OPT_IN,
    'create table orders (id int);\ncreate table messages (id int);',
  ];

  it('turns rule findings into report findings', () => {
    const r = rule('GL003', () => [
      {
        at: { file: pathOf(3), line: 2, column: 1 },
        message: 'dead',
        relation: T('messages'),
        role: PUBLIC,
        privilege: 'select',
        fix: 'grant select on public.messages to anon;',
      },
      { at: { file: pathOf(3), line: 1, column: 1 }, message: 'bare' },
    ]);
    const { findings, notices } = run(SQL, [r]);
    expect(notices).toEqual([]);
    expect(findings).toEqual([
      {
        ruleId: 'GL003',
        severity: 'error',
        message: 'bare',
        file: pathOf(3),
        line: 1,
        column: 1,
        docsUrl: docsUrl('GL003'),
      },
      {
        ruleId: 'GL003',
        severity: 'error',
        message: 'dead',
        file: pathOf(3),
        line: 2,
        column: 1,
        relation: 'public.messages',
        role: 'PUBLIC',
        privilege: 'select',
        fix: 'grant select on public.messages to anon;',
        docsUrl: docsUrl('GL003'),
      },
    ]);
    // Fields without a value are left out, not set to undefined (the programmatic API's shape).
    expect(Object.keys(findings[0] ?? {})).toEqual([
      'ruleId',
      'severity',
      'message',
      'file',
      'line',
      'column',
      'docsUrl',
    ]);
  });

  it('uses the default severity, then a per-finding severity, then the config setting', () => {
    const rules = [
      perCreated('GL001'),
      perCreated('GL003', { severity: 'warn' }),
      perCreated('GL005'),
    ];
    const sev = (config: Partial<Config>): string[] =>
      run(SQL, rules, config).findings.map((f) => `${f.ruleId}:${f.severity}`);
    expect(sev({})).toEqual([
      'GL001:error',
      'GL003:warn',
      'GL005:error',
      'GL001:error',
      'GL003:warn',
      'GL005:error',
    ]);
    expect(sev({ rules: { GL001: 'warn', GL003: 'error' } }).slice(0, 3)).toEqual([
      'GL001:warn',
      'GL003:error',
      'GL005:error',
    ]);
  });

  it('does not run a rule that is off', () => {
    let calls = 0;
    const counted = rule('GL004', () => {
      calls += 1;
      return [];
    });
    run(SQL, [counted], { rules: { GL004: 'off' } });
    expect(calls).toBe(0);
    run(SQL, [counted]);
    expect(calls).toBe(1);
  });

  it('sorts findings by file (replay order), line, column and rule', () => {
    const at = (n: number, line: number, column: number) => ({ file: pathOf(n), line, column });
    const r = (id: RuleId, found: RuleFinding[]): Rule => rule(id, () => found);
    const { findings } = run(SQL, [
      r('PARSE001', [
        { at: at(3, 1, 1), message: 'p' },
        { at: { file: 'z/unknown.sql', line: 1, column: 1 }, message: 'u2' },
      ]),
      r('GL005', [
        { at: at(3, 2, 5), message: 'c' },
        { at: at(1, 9, 1), message: 'a' },
      ]),
      r('GL001', [
        { at: at(3, 2, 1), message: 'b' },
        { at: at(3, 1, 1), message: 'g' },
        { at: { file: 'a/unknown.sql', line: 1, column: 1 }, message: 'u1' },
      ]),
      r('GL000', [{ at: at(3, 1, 1), message: 'z' }]),
    ]);
    expect(
      findings.map((f) => `${f.file} ${String(f.line)}:${String(f.column)} ${f.ruleId}`),
    ).toEqual([
      `${pathOf(1)} 9:1 GL005`,
      `${pathOf(3)} 1:1 GL000`,
      `${pathOf(3)} 1:1 GL001`,
      `${pathOf(3)} 1:1 PARSE001`,
      `${pathOf(3)} 2:1 GL001`,
      `${pathOf(3)} 2:5 GL005`,
      'a/unknown.sql 1:1 GL001',
      'z/unknown.sql 1:1 PARSE001',
    ]);
  });

  it('orders findings totally, whatever order the rules report them in', () => {
    const base: Finding = {
      ruleId: 'GL003',
      severity: 'error',
      message: 'm',
      file: 'f.sql',
      line: 1,
      column: 1,
      docsUrl: '',
    };
    const list: Finding[] = [
      { ...base, role: 'authenticated' },
      { ...base, relation: 'public.b' },
      { ...base, relation: 'public.a', role: 'anon', privilege: 'update' },
      { ...base, relation: 'public.a', role: 'anon', privilege: 'select' },
      base,
      { ...base, message: 'a' },
    ];
    const order = new Map([['f.sql', 0]]);
    const sorted = [...list].sort(compareFindings(order));
    expect([...list].reverse().sort(compareFindings(order))).toEqual(sorted);
    expect(
      sorted.map((f) => [f.relation ?? '', f.role ?? '', f.privilege ?? '', f.message]),
    ).toEqual([
      ['', '', '', 'a'],
      ['', '', '', 'm'],
      ['', 'authenticated', '', 'm'],
      ['public.a', 'anon', 'select', 'm'],
      ['public.a', 'anon', 'update', 'm'],
      ['public.b', '', '', 'm'],
    ]);
  });
});

describe('GL002 takes precedence over GL003', () => {
  const at = { file: pathOf(1), line: 1, column: 1 };
  const gl002 = rule('GL002', () => [
    { at, message: 'unreachable', relation: T('todos'), role: 'anon' },
  ]);
  const gl003 = rule('GL003', () => [
    { at: { ...at, line: 2 }, message: 'dead anon', relation: T('todos'), role: 'anon' },
    {
      at: { ...at, line: 3 },
      message: 'dead authenticated',
      relation: T('todos'),
      role: 'authenticated',
    },
    { at: { ...at, line: 4 }, message: 'dead other table', relation: T('orders'), role: 'anon' },
    {
      at: { ...at, file: pathOf(2), line: 1 },
      message: 'dead in another file',
      relation: T('todos'),
      role: 'anon',
    },
    { at: { ...at, line: 5 }, message: 'unknown relation, no role', relation: T('todos') },
  ]);
  const SQL = ['create table todos (id int);', 'select 1;'];

  it('drops GL003 findings for the same relation, role and file', () => {
    const { findings } = run(SQL, [gl002, gl003], { since: 'none' });
    expect(findings.map((f) => f.message)).toEqual([
      'unreachable',
      'dead authenticated',
      'dead other table',
      'unknown relation, no role',
      'dead in another file',
    ]);
  });

  it('keeps GL003 findings when GL002 is off', () => {
    const { findings } = run(SQL, [gl002, gl003], { since: 'none', rules: { GL002: 'off' } });
    expect(findings.map((f) => f.message)).toContain('dead anon');
    expect(findings.map((f) => f.ruleId)).not.toContain('GL002');
  });

  it('keys a file outside the replay by its own path', () => {
    const outside = { file: 'z/unknown.sql', line: 1, column: 1 };
    const unreachable = rule('GL002', () => [
      { at: outside, message: 'unreachable', relation: T('todos'), role: 'anon' },
    ]);
    const dead = rule('GL003', () => [
      { at: outside, message: 'dead outside', relation: T('todos'), role: 'anon' },
      { at, message: 'dead in a replayed file', relation: T('todos'), role: 'anon' },
    ]);
    expect(run(SQL, [unreachable, dead]).findings.map((f) => f.message)).toEqual([
      'dead in a replayed file',
      'unreachable',
    ]);
  });

  it('matches PUBLIC with PUBLIC only', () => {
    const pub = rule('GL002', () => [
      { at, message: 'unreachable', relation: T('todos'), role: PUBLIC },
    ]);
    const dead = rule('GL003', () => [
      { at, message: 'dead public', relation: T('todos'), role: PUBLIC },
      { at, message: 'dead anon', relation: T('todos'), role: 'anon' },
    ]);
    expect(run(SQL, [pub, dead]).findings.map((f) => f.message)).toEqual([
      'unreachable',
      'dead anon',
    ]);
  });
});

describe('config ignore', () => {
  const SQL = [
    OPT_IN,
    'create table todos (id int);\ncreate table orders (id int);',
    'create table todos2 (id int);',
  ];
  const rules = [perCreated('GL001'), perCreated('GL008')];
  const messages = (ignore: Config['ignore'], extra: Partial<Config> = {}) =>
    run(SQL, rules, { ignore, ...extra });

  it('suppresses by rule, relation and file', () => {
    const all = messages([]).findings;
    expect(all).toHaveLength(6);
    const byRule = messages([{ rule: 'GL008', reason: 'accepted' }]);
    expect(byRule.findings.map((f) => f.ruleId)).toEqual(['GL001', 'GL001', 'GL001']);
    expect(byRule.notices).toEqual([]);
    const byRelation = messages([{ rule: 'GL001', relation: 'todos', reason: 'r' }]).findings;
    expect(byRelation.filter((f) => f.ruleId === 'GL001').map((f) => f.relation)).toEqual([
      'public.orders',
      'public.todos2',
    ]);
    const qualifiedRelation = messages([
      { rule: 'GL001', relation: 'public.orders', reason: 'r' },
    ]).findings;
    expect(qualifiedRelation.filter((f) => f.ruleId === 'GL001').map((f) => f.relation)).toEqual([
      'public.todos',
      'public.todos2',
    ]);
    for (const file of [
      pathOf(3),
      `./${pathOf(3)}`,
      `${versionOf(3)}_m3.sql`,
      pathOf(3).replaceAll('/', '\\'),
    ]) {
      const byFile = messages([{ rule: 'GL001', file, reason: 'r' }]).findings;
      expect(byFile.filter((f) => f.ruleId === 'GL001').map((f) => f.relation)).toEqual([
        'public.todos',
        'public.orders',
      ]);
    }
    const both = messages([{ rule: 'GL001', relation: 'todos', file: pathOf(3), reason: 'r' }]);
    expect(both.findings).toHaveLength(6);
    expect(both.notices).toHaveLength(1);
  });

  it('reports entries that matched nothing, except for rules that did not run', () => {
    const { notices } = messages(
      [
        { rule: 'GL001', reason: 'used' },
        { rule: 'GL001', relation: 'nope', file: 'x.sql', reason: 'unused' },
        { rule: 'GL005', reason: 'rule not registered' },
        { rule: 'GL008', relation: 'nope', reason: 'rule off' },
      ],
      { rules: { GL008: 'off' } },
    );
    expect(notices).toEqual([
      {
        code: 'unused-ignore',
        message:
          'Unused ignore entry ignore[1] (GL001, nope, x.sql): it matched no finding. Remove it.',
      },
    ]);
    const ruleOnly = run(['select 1;'], [perCreated('GL008')], {
      since: 'none',
      ignore: [{ rule: 'GL008', reason: 'nothing to ignore' }],
    });
    expect(ruleOnly.notices.map((n) => n.message)).toEqual([
      'Unused ignore entry ignore[0] (GL008): it matched no finding. Remove it.',
    ]);
  });

  it('does not match a relation entry against a finding without a relation', () => {
    const bare = rule('GL005', (ctx) =>
      ctx.enforced.map((file) => ({ at: { file: file.file, line: 1, column: 1 }, message: 'b' })),
    );
    const { findings, notices } = run(SQL, [bare], {
      ignore: [{ rule: 'GL005', relation: 'todos', reason: 'r' }],
    });
    expect(findings.map((f) => f.file)).toEqual([pathOf(2), pathOf(3)]);
    expect(notices.map((n) => n.code)).toEqual(['unused-ignore']);
  });

  it('is a config error (exit 2) without a reason', () => {
    const { replay } = project(SQL);
    const config = { ...DEFAULT_CONFIG, ignore: [{ rule: 'GL001' as const, reason: '  ' }] };
    let error: unknown;
    try {
      runRules({ config, replay, rules });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).exitCode).toBe(2);
    expect((error as ConfigError).issues.map((i) => i.key)).toEqual(['ignore[0].reason']);
    expect((error as ConfigError).message).toBe(
      'Invalid config in options.config: "ignore[0].reason" is required: every suppression ' +
        'must give a non-empty reason',
    );
    // The config loader rejects it first, naming the file.
    expect(() =>
      validateConfig({ ignore: [{ rule: 'GL001', reason: '' }] }, 'grants-lint.config.json'),
    ).toThrow(/grants-lint\.config\.json.*"ignore\[0\]\.reason" is required/s);
  });
});

describe('inline suppressions', () => {
  it('suppresses the named rules on the next line only', () => {
    const sql = [
      OPT_IN,
      [
        '-- grants-lint-disable-next-line GL001: written by a job',
        'create table todos (id int);',
        'create table orders (id int);',
      ].join('\n'),
    ];
    const { findings, notices } = run(sql, [perCreated('GL001'), perCreated('GL008')]);
    expect(findings.map((f) => `${f.ruleId} ${f.relation ?? ''} ${String(f.line)}`)).toEqual([
      'GL008 public.todos 2',
      'GL001 public.orders 3',
      'GL008 public.orders 3',
    ]);
    expect(notices).toEqual([]);
  });

  it('suppresses several rules with one comment and reports the ones that matched nothing', () => {
    const sql = [
      OPT_IN,
      [
        'create table todos (id int);',
        '-- grants-lint-disable-next-line GL001, GL008, GL004: reviewed',
        'create table orders (id int);',
        '/* grants-lint-disable-next-line GL001: nothing is created here */',
        'select 1;',
        '-- grants-lint-disable-next-line GL005: rule is off',
        'select 2;',
      ].join('\n'),
    ];
    const { findings, notices } = run(
      sql,
      [perCreated('GL001'), perCreated('GL004'), perCreated('GL008'), perCreated('GL005')],
      {
        rules: { GL005: 'off' },
        ignore: [{ rule: 'GL004', relation: 'orders', reason: 'covered by config too' }],
      },
    );
    expect(findings.map((f) => `${f.ruleId} ${f.relation ?? ''}`)).toEqual([
      'GL001 public.todos',
      'GL004 public.todos',
      'GL008 public.todos',
    ]);
    expect(notices).toEqual([
      {
        code: 'unused-suppression',
        message: 'Unused suppression: no GL001 finding on line 5. Remove it.',
        file: pathOf(2),
        line: 4,
        column: 1,
      },
    ]);
  });

  it('applies to the file it is written in', () => {
    const sql = [
      OPT_IN,
      '-- grants-lint-disable-next-line GL001: other file\nselect 1;',
      'create table todos (id int);',
    ];
    const { findings, notices } = run(sql, [perCreated('GL001')]);
    expect(findings.map((f) => f.file)).toEqual([pathOf(3)]);
    expect(notices.map((n) => [n.code, n.file])).toEqual([['unused-suppression', pathOf(2)]]);
    // The same target line in another file is not suppressed.
    const sameLine = run(
      [
        OPT_IN,
        '-- grants-lint-disable-next-line GL001: other file\nselect 1;',
        'select 1;\ncreate table todos (id int);',
      ],
      [perCreated('GL001')],
    );
    expect(sameLine.findings.map((f) => `${f.file}:${String(f.line)}`)).toEqual([`${pathOf(3)}:2`]);
  });

  it('sorts notices: config entries first, then comments by file and line', () => {
    const sql = [
      OPT_IN,
      '\n-- grants-lint-disable-next-line GL001: b\nselect 1;',
      '-- grants-lint-disable-next-line GL001: a\nselect 1;',
    ];
    const { replay, parsed } = project(sql);
    const suppressions = parsed.flatMap((p) => p.suppressions).reverse();
    const { notices } = runRules({
      config: { ...DEFAULT_CONFIG, ignore: [{ rule: 'GL001', relation: 'nope', reason: 'r' }] },
      replay,
      suppressions,
      rules: [perCreated('GL001')],
    });
    expect(notices.map((n) => `${n.code} ${n.file ?? '-'}:${String(n.line ?? '-')}`)).toEqual([
      'unused-ignore -:-',
      `unused-suppression ${pathOf(2)}:2`,
      `unused-suppression ${pathOf(3)}:1`,
    ]);
  });

  it('is a usage error (exit 2) when a suppression has no reason', () => {
    const sql = [
      [
        '-- grants-lint-disable-next-line GL001',
        'create table todos (id int);',
        '-- grants-lint-disable-next-line GL002:   ',
        'create table orders (id int);',
      ].join('\n'),
    ];
    let error: unknown;
    try {
      run(sql, [perCreated('GL001')], { since: 'none' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(2);
    expect((error as UsageError).message).toContain(`${pathOf(1)}:1:1`);
    expect((error as UsageError).message).toContain(`${pathOf(1)}:3:1`);
    expect((error as UsageError).message).toContain('needs a reason after a colon');
  });

  it('is a usage error before any rule runs', () => {
    let calls = 0;
    const counted = rule('GL001', () => {
      calls += 1;
      return [];
    });
    expect(() => run(['-- grants-lint-disable-next-line GL001\nselect 1;'], [counted])).toThrow(
      UsageError,
    );
    expect(calls).toBe(0);
  });
});

describe('matching helpers', () => {
  it('matches relation names bare or schema-qualified', () => {
    expect(matchesRelation('todos', T('todos'))).toBe(true);
    expect(matchesRelation('todos', { schema: 'api', name: 'todos' })).toBe(true);
    expect(matchesRelation('public.todos', T('todos'))).toBe(true);
    expect(matchesRelation('api.todos', T('todos'))).toBe(false);
    expect(matchesRelation('todo', T('todos'))).toBe(false);
    expect(matchesRelation('Todos', T('todos'))).toBe(false);
  });

  it('matches files by path or trailing segments', () => {
    const file = 'supabase/migrations/20261001_todos.sql';
    expect(matchesFile(file, file)).toBe(true);
    expect(matchesFile(`./${file}`, file)).toBe(true);
    expect(matchesFile('migrations/20261001_todos.sql', file)).toBe(true);
    expect(matchesFile('20261001_todos.sql', file)).toBe(true);
    expect(matchesFile('supabase\\migrations\\20261001_todos.sql', file)).toBe(true);
    expect(matchesFile('1_todos.sql', file)).toBe(false);
    expect(matchesFile('20261001_todos', file)).toBe(false);
    expect(matchesFile(`././${file}`, file)).toBe(true);
    // Only a leading "./" is dropped: a directory name may end in a dot.
    expect(matchesFile('db./20261001_todos.sql', 'db./20261001_todos.sql')).toBe(true);
  });

  it('labels PUBLIC as PUBLIC and roles by name', () => {
    expect(granteeLabel(PUBLIC)).toBe('PUBLIC');
    expect(granteeLabel('anon')).toBe('anon');
  });
});
