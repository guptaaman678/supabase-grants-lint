import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { colors } from '../../src/cli/color.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { Io } from '../../src/cli/io.js';
import { run } from '../../src/cli/main.js';
import { COMMAND_USAGE } from '../../src/cli/usage.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import {
  autoExposeSetting,
  diagnose,
  formatDoctor,
  optInSql,
  postgresVersion,
  WIDTH,
  wrap,
} from '../../src/doctor.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PROJECTS = path.join(ROOT, 'test/golden/doctor/projects');
const OPTED_IN = path.join(PROJECTS, 'opted-in');

function fakeIo(cwd = ROOT) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd,
    env: {},
    isTTY: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}

/** One line per sentence fragment, joined back, so assertions ignore where the text wrapped. */
function flat(text: string): string {
  return text.replace(/\n +/g, ' ');
}

const temp = mkdtempSync(path.join(tmpdir(), 'grants-lint-doctor-'));
afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(temp, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const TODOS = 'create table public.todos (id uuid primary key);\n';

describe('autoExposeSetting', () => {
  it.each([
    ['[api]\nauto_expose_new_tables = false\n', false],
    ['[api]\nauto_expose_new_tables = true # comment\n', true],
    ['[ api ]\r\n  auto_expose_new_tables=false\r\n', false],
    ['api.auto_expose_new_tables = false\n', false],
    ['["api"]\n"auto_expose_new_tables" = true\n', true],
    ['[api]\nenabled = true\n', null],
    ['# [api]\n# auto_expose_new_tables = false\n', null],
    ['[db]\nauto_expose_new_tables = false\n', null],
    ['[api]\nauto_expose_new_tables = "false"\n', null],
    ['[api]\n[[api.extra]]\nauto_expose_new_tables = false\n', null],
    ['[api]\nauto_expose_new_tables = true\n[api]\nauto_expose_new_tables = false\n', false],
    ['', null],
  ])('reads %j as %s', (toml, expected) => {
    expect(autoExposeSetting(toml)).toBe(expected);
  });
});

describe('wrap', () => {
  it('breaks at spaces within the width, with the given prefixes', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${String(i)}`).join(' ');
    const lines = wrap(text, '  1. ', '     ');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(WIDTH);
    expect(lines[0]?.startsWith('  1. word0 ')).toBe(true);
    expect(lines.slice(1).every((line) => /^ {5}\S/.test(line))).toBe(true);
    expect(lines.join(' ').replace(/ +/g, ' ').replace('1. ', '').trim()).toBe(text);
  });

  it('keeps a word longer than the width on its own line', () => {
    const long = 'x'.repeat(WIDTH + 5);
    expect(wrap(`a ${long} b`, '')).toEqual(['a', long, 'b']);
  });

  it('defaults the continuation indent to the width of the first prefix', () => {
    const lines = wrap('y '.repeat(60).trim(), '  - ');
    expect(lines[1]?.startsWith('    y')).toBe(true);
  });
});

describe('optInSql', () => {
  it('revokes everything from the API roles for the migration role in each scoped schema', () => {
    expect(optInSql(DEFAULT_CONFIG)).toBe(
      'alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;\n' +
        'alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;',
    );
  });

  it('follows migrationRole, schemas, clientRoles and serviceRole, quoting where needed', () => {
    const sql = optInSql({
      ...DEFAULT_CONFIG,
      migrationRole: 'Admin',
      schemas: ['public', 'api'],
      clientRoles: ['anon', 'authenticated', 'editor'],
      serviceRole: 'backend',
    });
    const lines = sql.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe(
      'alter default privileges for role "Admin" in schema api revoke all on tables from anon, authenticated, service_role, editor, backend;',
    );
  });
});

describe('diagnose and formatDoctor', () => {
  it('reports since from --since, with the platform revoke it assumes', async () => {
    const report = await diagnose({ cwd: OPTED_IN, since: '20261001000000' });
    expect(report.since).toMatchObject({ value: '20261001000000', source: 'cli' });
    const text = flat(formatDoctor(report));
    expect(text).toContain(
      'since is 20261001000000 (from --since): check enforces the 1 migration file after it, ' +
        'and assumes the platform revoke before the first of them.',
    );
    expect(text).toContain(
      '1. To make fresh databases (a new project, a local reset) match production, add a ' +
        'migration containing the opt-in SQL:',
    );
    expect(text).toContain('revoke all on sequences from anon, authenticated, service_role;');
  });

  it('reports since none, which enforces every file', async () => {
    const text = flat(formatDoctor(await diagnose({ cwd: OPTED_IN, since: 'none' })));
    expect(text).toContain('since is none (from --since): check enforces every migration file.');
  });

  it('reports since from the config, without the revoke when it is off or nothing is enforced', async () => {
    const dir = project('config-since', {
      'grants-lint.config.json': JSON.stringify({
        since: '20261001000000',
        platformRevokeAtSince: false,
        schemas: ['public', 'api'],
      }),
      'supabase/migrations/20261001000000_a.sql': TODOS,
      'supabase/migrations/20261002000000_b.sql': 'create table api.orders (id uuid);\n',
    });
    const text = flat(formatDoctor(await diagnose({ cwd: dir })));
    expect(text).toContain(
      'since is 20261001000000 (from the config): check enforces the 1 migration file after it.',
    );
    expect(text).toContain('2 relations in schemas public, api after the last one.');

    const later = flat(formatDoctor(await diagnose({ cwd: OPTED_IN, since: '20991231000000' })));
    expect(later).toContain(
      'since is 20991231000000 (from --since): no migrations after it yet; check will enforce ' +
        'every new one.',
    );
    expect(later).not.toContain('assumes the platform revoke');
  });

  it('says an opt-in migration with nothing after it enforces every new one', async () => {
    const dir = project('opted-in-last', {
      'supabase/migrations/20261001000000_a.sql': TODOS,
      'supabase/migrations/20261002000000_opt_in.sql': optInSql(DEFAULT_CONFIG),
    });
    const text = flat(formatDoctor(await diagnose({ cwd: dir })));
    expect(text).toContain(
      'Opted in by supabase/migrations/20261002000000_opt_in.sql:1. No migrations after it yet; ' +
        'check will enforce every new one.',
    );
  });

  it('lists relations the migrations grant on or add policies to but never create', async () => {
    const dir = project('not-created', {
      'supabase/migrations/20261001000000_a.sql':
        'grant select on public.messages, api.orders to authenticated;\n' +
        'revoke insert on table public.audit_log from anon;\n' +
        'grant usage on sequence public.messages_id_seq to anon;\n' +
        'create policy "p" on public.messages for select to authenticated using (true);\n' +
        'create policy "q" on public.todos for select to authenticated using (true);\n' +
        'alter policy "p" on public.profiles to anon;\n' +
        'grant select on all tables in schema public to anon;\n',
      'supabase/migrations/20261002000000_b.sql': TODOS + 'grant select on public.todos to anon;\n',
    });
    const report = await diagnose({ cwd: dir });
    expect(report.notCreated).toEqual(['public.messages', 'public.audit_log', 'public.profiles']);
    expect(flat(formatDoctor(report))).toContain(
      '3 relations are granted on or given policies in the migrations but never created in them ' +
        '(probably created in the dashboard), so check cannot see them: public.messages, ' +
        'public.audit_log, public.profiles. Relations your migrations create from now on are ' +
        'checked.',
    );

    const one = project('not-created-one', {
      'supabase/migrations/20261001000000_a.sql': 'grant select on public.messages to anon;\n',
    });
    const text = flat(formatDoctor(await diagnose({ cwd: one })));
    expect(text).toContain(
      'The migrations create no relations. 1 relation is granted on or given policies in the ' +
        'migrations but never created in them (probably created in the dashboard), so check ' +
        'cannot see it: public.messages.',
    );
    expect((await diagnose({ cwd: OPTED_IN })).notCreated).toEqual([]);
  });

  it('merges the roles of one relation and counts relations created twice', async () => {
    const dir = project('recreated', {
      'supabase/migrations/20261001000000_a.sql':
        TODOS + 'grant select on public.todos to service_role;\n',
      'supabase/migrations/20261002000000_b.sql': 'drop table public.todos;\n' + TODOS,
    });
    const report = await diagnose({ cwd: dir });
    expect(report.history.created).toBe(2);
    expect(report.history.unreachable).toEqual([
      {
        relation: 'public.todos',
        file: 'supabase/migrations/20261002000000_b.sql',
        line: 2,
        roles: ['service_role'],
      },
    ]);
    const policy = project('policy', {
      'supabase/migrations/20261001000000_a.sql':
        TODOS +
        'create policy "p" on public.todos for select to anon, authenticated using (true);\n',
    });
    expect((await diagnose({ cwd: policy })).history.unreachable[0]?.roles).toEqual([
      'service_role',
      'anon',
      'authenticated',
    ]);
  });

  it('ignores config rules and suppressions: doctor hides nothing', async () => {
    const dir = project('suppressed', {
      'grants-lint.config.json': JSON.stringify({
        rules: { GL007: 'off', GL001: 'off' },
        ignore: [{ rule: 'GL007', reason: 'known' }],
      }),
      'supabase/migrations/20261001000000_a.sql':
        '-- grants-lint-disable-next-line GL007: known\n' +
        'alter default privileges for role postgres in schema public grant select on tables to anon;\n' +
        TODOS,
    });
    const report = await diagnose({ cwd: dir });
    expect(report.replayTrap?.ruleId).toBe('GL007');
    expect(report.history.unreachable).toHaveLength(1);
    expect(report.config.rules).toEqual({ GL007: 'off', GL001: 'off' });
  });

  it('makes section titles bold when colour is on', async () => {
    const text = formatDoctor(await diagnose({ cwd: OPTED_IN }), colors(true));
    expect(text).toContain('\u001b[1mOpt-in status\u001b[22m\n');
    expect(text).toContain('\u001b[1mNext steps\u001b[22m\n');
  });
});

describe('Live database section', () => {
  it('is left out without a database URL', async () => {
    const report = await diagnose({ cwd: OPTED_IN });
    expect(report.live).toBeNull();
    expect(formatDoctor(report)).not.toContain('Live database');
  });

  it('shows the server, automatic grants per schema and the drift count, before Next steps', async () => {
    const report = await diagnose({ cwd: OPTED_IN });
    const text = formatDoctor({
      ...report,
      config: { ...report.config, schemas: ['public', 'api'] },
      live: {
        serverVersion: 170002,
        autoGrants: [
          { schema: 'public', roles: ['anon', 'authenticated', 'service_role'] },
          { schema: 'api', roles: [] },
        ],
        drift: 1,
      },
    });
    expect(text.indexOf('\nLive database\n')).toBeLessThan(text.indexOf('\nNext steps\n'));
    expect(text.indexOf('\nHistory exposure\n')).toBeLessThan(text.indexOf('\nLive database\n'));
    expect(flat(text)).toContain(
      'Live database Read the database (Postgres 17.2), read-only. New tables postgres creates ' +
        'in schema public are still granted to anon, authenticated, service_role automatically: ' +
        'the database is not opted in yet. New tables postgres creates in schema api get no ' +
        'automatic grants: the database is opted in, so every migration must grant what the ' +
        'Data API needs. 1 difference between the database and the migrations (GL009); run ' +
        'supabase-grants-lint diff to list them.\n',
    );
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(WIDTH);
  });

  it('says when there is no drift', async () => {
    const report = await diagnose({ cwd: OPTED_IN });
    const live = { serverVersion: 150008, autoGrants: [], drift: 0 };
    expect(flat(formatDoctor({ ...report, live }))).toContain(
      'Read the database (Postgres 15.8), read-only. No drift: the database has the grants, ' +
        'default privileges and policies the migrations give.',
    );
    expect(postgresVersion(180003)).toBe('18.3');
  });
});

describe('doctor command', () => {
  it('prints help', async () => {
    for (const flag of ['--help', '-h']) {
      const { io, stdout } = fakeIo();
      expect(await run(['doctor', flag], io)).toBe(ExitCode.Ok);
      expect(stdout()).toBe(COMMAND_USAGE.doctor);
    }
  });

  it.each([
    [['--format', 'json'], 'Unknown option --format for doctor.'],
    [['--sinse', 'none'], 'Unknown option --sinse for doctor. Did you mean "--since"?'],
    [['extra'], 'doctor takes no arguments, got "extra".'],
    [['--since', 'soon'], '--since'],
  ])('exits 2 for %j', async (args, message) => {
    const { io, stderr } = fakeIo(OPTED_IN);
    expect(await run(['doctor', ...args], io)).toBe(ExitCode.Usage);
    expect(stderr()).toContain(message);
  });

  it('exits 2 for a missing project directory', async () => {
    const { io } = fakeIo();
    expect(await run(['doctor', '--dir', path.join(temp, 'missing')], io)).toBe(ExitCode.Usage);
  });

  it('passes --dir, --config, --since, --schema and --no-color through', async () => {
    const dir = project('flags', {
      'other.json': JSON.stringify({ since: 'none' }),
      'supabase/migrations/20261001000000_a.sql': TODOS,
    });
    const { io, stdout } = fakeIo();
    const args = ['doctor', '--dir', dir, '--config', path.join(dir, 'other.json'), '--no-color'];
    expect(await run([...args, '--schema', 'api'], io)).toBe(ExitCode.Ok);
    expect(flat(stdout())).toContain('since is none (from the config)');
    expect(stdout()).toContain('0 relations in schema api');
    const again = fakeIo();
    expect(await run([...args, '--since', '20261001000000'], again.io)).toBe(ExitCode.Ok);
    expect(flat(again.stdout())).toContain('since is 20261001000000 (from --since)');
  });

  it('accepts --dir pointed at the migrations folder itself', async () => {
    const dir = project('bare-folder', { 'db/migrations/001_todos.sql': TODOS });
    const { io, stdout } = fakeIo(dir);
    expect(await run(['doctor', '--dir', 'db/migrations'], io)).toBe(ExitCode.Ok);
    expect(stdout()).toContain('Replayed 1 migration file: 1 relation in schema public');
    expect(flat(stdout())).toContain(
      'public.todos (service_role) at db/migrations/001_todos.sql:1',
    );
  });

  it('uses colour only on a terminal without NO_COLOR', async () => {
    const tty = fakeIo(OPTED_IN);
    await run(['doctor'], { ...tty.io, isTTY: true });
    expect(tty.stdout()).toContain('\u001b[1m');
    const plain = fakeIo(OPTED_IN);
    await run(['doctor', '--no-color'], { ...plain.io, isTTY: true });
    expect(plain.stdout()).not.toContain('\u001b[');
  });
});
