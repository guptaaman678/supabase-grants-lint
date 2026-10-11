import { beforeAll, describe, expect, it } from 'vitest';
import { usage } from '../../src/cli/usage.js';
import { DEFAULT_CONFIG, RULE_IDS } from '../../src/config/defaults.js';
import { loadParser, type MigrationParser } from '../../src/parse/adapter.js';
import { sarifRules } from '../../src/report/sarif.js';
import { replayWithWindow } from '../../src/replay/since.js';
import { docsUrl, type Finding, RULES, runRules } from '../../src/rules/index.js';
import { PARSE002 } from '../../src/rules/PARSE002.js';

let parser: MigrationParser;

beforeAll(async () => {
  parser = await loadParser();
});

const file = (i: number) => `supabase/migrations/2026100${String(i + 1)}000000_m.sql`;

/** Lints the sources as consecutive migrations, with PARSE002 only. */
function lint(sources: readonly string[]): readonly Finding[] {
  const inputs = sources.map((source, i) => ({
    file: file(i),
    version: `2026100${String(i + 1)}000000`,
    statements: parser.parse(source, file(i)).statements,
  }));
  return runRules({
    config: DEFAULT_CONFIG,
    replay: replayWithWindow(inputs, DEFAULT_CONFIG),
    rules: [PARSE002],
  }).findings;
}

describe('PARSE002 dynamic-sql-skipped', () => {
  it('reports a DO block that mentions grants, naming what it mentions, as info', () => {
    const findings = lint([
      'create table public.todos (id uuid primary key);\n' +
        "do $$ begin execute 'grant select on public.todos to anon'; " +
        'create policy p on public.todos for select using (true); end $$;',
    ]);
    expect(findings).toEqual([
      {
        ruleId: 'PARSE002',
        severity: 'info',
        message:
          'DO block not modelled; it mentions grant, create policy. The replay does not run it, ' +
          'so any grants, tables or policies it creates are not checked. Move those statements ' +
          'out of the block, or suppress this with a reason.',
        file: file(0),
        line: 2,
        column: 1,
        docsUrl: docsUrl('PARSE002'),
      },
    ]);
    expect(findings[0]?.message).not.toContain(String.fromCodePoint(0x2014)); // G7
  });

  it('reports a DO block that drops, alters or renames a relation (ADR-019 item 3)', () => {
    const findings = lint([
      'create table public.todos (id uuid primary key);\n' +
        'do $$ begin if exists (select 1) then drop table public.todos; end if; end $$;',
    ]);
    expect(findings.map((f) => f.message)).toEqual([
      'DO block not modelled; it mentions drop table. The replay does not run it, so any ' +
        'relation it drops, alters or renames stays in the replay as it was before the block. ' +
        'Move those statements out of the block, or suppress this with a reason.',
    ]);
    const both = lint([
      "do $$ begin alter table public.todos rename to tasks; execute 'grant select on public.tasks to anon'; end $$;",
    ]);
    expect(both.map((f) => f.message)).toEqual([
      'DO block not modelled; it mentions grant, alter table, rename. The replay does not run ' +
        'it, so any grants, tables or policies it creates are not checked, and any relation it ' +
        'drops, alters or renames stays in the replay as it was before the block. Move those ' +
        'statements out of the block, or suppress this with a reason.',
    ]);
    expect(both[0]?.message).not.toContain(String.fromCodePoint(0x2014)); // G7
  });

  it('checks every file and ignores unparseable statements and DO blocks without grants', () => {
    const findings = lint([
      "do $$ begin execute 'revoke all on public.todos from anon'; end $$;",
      "create tabel x (id int);\ndo $$ begin raise notice 'hello'; end $$;",
    ]);
    expect(findings.map((f) => `${f.file}:${String(f.line)}`)).toEqual([`${file(0)}:1`]);
  });

  it('completes the registry: every rule ID is implemented, in ID order', () => {
    expect(RULES.map((r) => r.id)).toEqual([...RULE_IDS]);
  });

  it('appears in --help', () => {
    expect(usage()).toMatch(/^ {2}PARSE002 +dynamic-sql-skipped +info$/m);
  });

  it('appears in the SARIF rule descriptors', () => {
    expect(sarifRules().find((d) => d.id === 'PARSE002')).toEqual({
      id: 'PARSE002',
      name: 'dynamic-sql-skipped',
      shortDescription: { text: PARSE002.docs },
      helpUri: docsUrl('PARSE002'),
      defaultConfiguration: { level: 'note' },
    });
  });
});
