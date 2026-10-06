/**
 * The model state added for the engine export (row level security, event triggers, the automatic
 * RLS fingerprint, publications and the bodies that change them) must not change anything
 * grants-lint reports. The same project is linted with
 * and without every new statement shape, appended at the ends of files so no other statement
 * moves; findings, notices, the summary, `explain` and `doctor` must be equal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { diagnose, formatDoctor } from '../../src/doctor.js';
import { explain, formatExplain } from '../../src/explain.js';
import { lint } from '../../src/lint.js';

const temp = mkdtempSync(path.join(tmpdir(), 'grants-lint-silence-'));

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

const BASE = [
  `create table public.todos (id bigserial primary key, title text);
grant select on public.todos to anon;
create table public.orders (id int);
create policy "read todos" on public.todos for select to anon using (true);`,
  `alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
create table public.messages (id int);
grant insert on public.messages to authenticated;
create table private.audit_log (id int);`,
  `create table public.tasks (id int);
grant select, insert on public.tasks to anon, authenticated;
create table public.notes (id int);
alter table public.orders rename to scores;
drop table public.scores;`,
];

const ADDED = [
  `
alter table public.todos enable row level security, force row level security;
alter table if exists only public.orders enable row level security;
alter table auth.users enable row level security;
create or replace function public.rls_auto_enable() returns event_trigger language plpgsql as $$ begin end $$;
create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();
create event trigger audit_ddl on ddl_command_start execute procedure public.audit();
alter event trigger audit_ddl disable;
alter event trigger audit_ddl enable always;
alter event trigger audit_ddl rename to audit_ddl_2;
create publication audit_pub for table public.todos, public.orders (id) where (id > 0);
create publication all_pub for all tables;
create publication schema_pub for tables in schema public, current_schema;
alter publication supabase_realtime add table only public.todos, public.orders;
alter publication supabase_realtime owner to postgres;
alter publication audit_pub set (publish = 'insert');
create or replace function public.seed_realtime() returns void language plpgsql as $$ begin execute format('alter publication supabase_realtime add table public.%I', 'todos'); end $$;
select public.seed_realtime();
do $$ begin alter publication supabase_realtime add table public.orders; end $$;`,
  `
alter table public.messages disable row level security, no force row level security;
drop event trigger if exists audit_ddl_2, missing;
alter event trigger ensure_rls enable replica;
alter publication supabase_realtime drop table public.todos;
alter publication schema_pub set table public.messages, tables in schema private;
alter publication audit_pub rename to audit_pub_2;
call public.seed_realtime();
do $$ begin execute format('alter publication %I add table public.messages', 'audit_pub_2'); end $$;
create publication supabase_realtime;`,
  `
drop function if exists public.rls_auto_enable() cascade;
drop procedure if exists public.audit;
drop publication if exists all_pub, missing_pub;
drop function if exists public.seed_realtime();`,
];

function project(name: string, withAdded: boolean): string {
  const dir = path.join(temp, name);
  const migrations = path.join(dir, 'supabase', 'migrations');
  mkdirSync(migrations, { recursive: true });
  BASE.forEach((sql, i) => {
    const file = path.join(migrations, `2026100100000${String(i + 1)}_m${String(i + 1)}.sql`);
    writeFileSync(file, withAdded ? `${sql}\n${ADDED[i] ?? ''}\n` : `${sql}\n`);
  });
  return dir;
}

describe('engine model additions are silent in grants-lint', () => {
  const plain = project('plain', false);
  const added = project('added', true);

  it.each(['auto', 'on', 'off'] as const)(
    'gives the same findings, notices and summary (autoRls %s)',
    async (autoRls) => {
      for (const dir of [plain, added]) {
        writeFileSync(path.join(dir, 'grants-lint.config.json'), JSON.stringify({ autoRls }));
      }
      // Everything but the timing.
      const strip = (result: Awaited<ReturnType<typeof lint>>) => ({
        ...result,
        summary: { ...result.summary, durationMs: 0 },
      });
      const before = strip(await lint({ cwd: plain }));
      const after = strip(await lint({ cwd: added }));
      expect(before.findings.length).toBeGreaterThan(0);
      expect(after).toEqual(before);
    },
  );

  it.each(['public.todos', 'public.messages', 'public.scores'])(
    'gives the same explain output for %s',
    async (relation) => {
      const text = async (cwd: string): Promise<string> =>
        formatExplain(await explain({ cwd, relation })).replaceAll(cwd, '<dir>');
      expect(await text(added)).toBe(await text(plain));
    },
  );

  it('gives the same doctor report', async () => {
    const text = async (cwd: string): Promise<string> =>
      formatDoctor(await diagnose({ cwd })).replaceAll(cwd, '<dir>');
    expect(await text(added)).toBe(await text(plain));
  });
});
