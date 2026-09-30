/**
 * Fix-text verification (spec T11.3): for every rule fixture, each finding's printed `fix` is
 * applied where its message tells the user to put it, the edited migrations are applied to a real
 * Postgres (PGlite in-process, or the CI service container, see `test/support/database.ts`), and
 * the fixture is linted again: the SQL must run, the finding must be gone, and nothing new may
 * appear. Then all of a fixture's fixes are applied together, with the same result.
 *
 * Where a fix goes:
 * - GL001 to GL004, GL008: at the end of the finding's file (rules evaluate each file at its end).
 * - GL005: in place of the blanket grant ("grant on the relations by name instead").
 * - GL007: in a new migration after the others ("revoke them in a new migration").
 * - GL009: in a new migration when the database has it and the migrations do not, in the
 *   database when the migrations have it and the database does not.
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { loadParser } from '../../src/parse/adapter.js';
import type { Finding } from '../../src/rules/types.js';
import type { TestDatabase } from '../support/database.js';
import { FIXTURES, lintFixture, type Fixture } from '../support/fixtures.js';
import { databaseFor } from '../support/live-project.js';

const parser = await loadParser();

/** A migration that sorts after every fixture migration. */
const NEW_MIGRATION = 'migrations/99999999999999_fixes.sql';

type Placement = 'append' | 'replace' | 'migration' | 'database';

function placement(finding: Finding): Placement {
  switch (finding.ruleId) {
    case 'GL005':
      return 'replace';
    case 'GL007':
      return 'migration';
    case 'GL009':
      return finding.message.startsWith('In the database, not in the migrations:')
        ? 'migration'
        : 'database';
    default:
      return 'append';
  }
}

/** Identity of a finding across a re-run: fixes only append, or replace a statement in place. */
function key(finding: Finding): string {
  return JSON.stringify([
    finding.ruleId,
    finding.file,
    finding.line,
    finding.column,
    finding.relation,
    finding.role,
    finding.ruleId === 'GL009' ? placement(finding) : null,
  ]);
}

/** Character offset of a 1-based line and column (columns count characters, as findings do). */
function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) offset = text.indexOf('\n', offset) + 1;
  return offset + column - 1;
}

/** Replaces the statement that starts at the finding's position, and its `;`, with the fix. */
function replaceStatements(file: string, findings: readonly Finding[]): void {
  let text = readFileSync(file, 'utf8');
  const { statements } = parser.parse(text, 'x.sql');
  // Bottom up, so earlier positions stay valid.
  const sorted = [...findings].sort((a, b) => b.line - a.line || b.column - a.column);
  for (const finding of sorted) {
    const statement = statements.find(
      (s) => s.line === finding.line && s.column === finding.column,
    );
    if (statement === undefined)
      throw new Error(`no statement at ${finding.file}:${String(finding.line)}`);
    const start = offsetOf(text, finding.line, finding.column);
    expect(text.slice(start, start + statement.text.length)).toBe(statement.text);
    let end = start + statement.text.length;
    if (text[end] === ';') end += 1;
    text = `${text.slice(0, start)}${finding.fix ?? ''}${text.slice(end)}`;
  }
  writeFileSync(file, text);
}

/** Applies fixes to a copy of the fixture; returns the SQL that goes to the database instead. */
function applyFixes(copy: string, findings: readonly Finding[]): string[] {
  const byHand: string[] = [];
  const replaced = new Map<string, Finding[]>();
  for (const finding of findings) {
    const fix = finding.fix ?? '';
    switch (placement(finding)) {
      case 'append':
        appendFileSync(path.join(copy, finding.file), `\n${fix}\n`);
        break;
      case 'replace':
        replaced.set(finding.file, [...(replaced.get(finding.file) ?? []), finding]);
        break;
      case 'migration':
        appendFileSync(path.join(copy, NEW_MIGRATION), `${fix}\n`);
        break;
      case 'database':
        byHand.push(fix);
        break;
    }
  }
  for (const [file, list] of replaced) replaceStatements(path.join(copy, file), list);
  return byHand;
}

const temps: string[] = [];
const open: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function copyOf(fixture: Fixture): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'grants-lint-fix-'));
  temps.push(dir);
  cpSync(fixture.dir, dir, { recursive: true });
  return dir;
}

/** The roles a fixture's config names, which a project using that config already has. */
function configuredRoles(dir: string): string[] {
  const { config } = loadConfig({
    cwd: dir,
    projectDir: dir,
    ...(existsSync(path.join(dir, 'config.json')) ? { configFile: 'config.json' } : {}),
  });
  const roles = new Set([...config.clientRoles, config.serviceRole, config.migrationRole]);
  return [...roles].map(
    (role) =>
      `do $$ begin create role "${role}" nologin; ` +
      'exception when duplicate_object then null; end $$;',
  );
}

/**
 * A copy of the fixture for the database: the statements the fixture itself has that the linter
 * skips as unparseable (PARSE001), which Postgres would reject too, are blanked out, keeping every
 * line and column where it was. Blanked before the fixes go in, so an invalid fix still fails.
 */
function databaseCopyOf(fixture: Fixture): string {
  const dir = copyOf(fixture);
  const migrations = path.join(dir, 'migrations');
  for (const name of readdirSync(migrations).filter((n) => n.endsWith('.sql'))) {
    const file = path.join(migrations, name);
    let text = readFileSync(file, 'utf8');
    const skipped = parser.parse(text, name).statements.filter((s) => s.kind === 'Unparseable');
    for (const statement of skipped) {
      const start = offsetOf(text, statement.line, statement.column);
      const end = start + statement.text.length;
      expect(text.slice(start, end)).toBe(statement.text);
      text = text.slice(0, start) + statement.text.replace(/[^\n]/g, ' ') + text.slice(end);
    }
    writeFileSync(file, text);
  }
  return dir;
}

/**
 * Applies the fixes, builds the database the edited migrations give (the fix must be valid SQL
 * there) and lints again.
 */
async function lintFixed(fixture: Fixture, findings: readonly Finding[]) {
  const copy = copyOf(fixture);
  const byHand = applyFixes(copy, findings);
  const opened = (db: TestDatabase) => open.push(db);
  try {
    if (fixture.rule !== 'GL009') {
      // GL009 cases build their database from `copy` while linting.
      const database = databaseCopyOf(fixture);
      applyFixes(database, findings);
      opened(await databaseFor(database, [], 'migrations', configuredRoles(copy)));
    }
    return await lintFixture(parser, fixture, { dir: copy, byHand, opened });
  } catch (error) {
    const fixes = findings.map((f) => f.fix).join('\n');
    throw new Error(`${(error as Error).message}\nwhile applying:\n${fixes}`, { cause: error });
  }
}

const CASES: { fixture: Fixture; findings: readonly Finding[] }[] = [];
for (const fixture of FIXTURES) {
  const { findings } = await lintFixture(parser, fixture, { opened: (db) => open.push(db) });
  await Promise.all(open.splice(0).map((db) => db.close()));
  CASES.push({ fixture, findings });
}

const WITH_FIXES = CASES.filter(({ findings }) => findings.some((f) => f.fix !== undefined));

describe('fix-text verification', () => {
  it('covers every rule that prints fix SQL', () => {
    const rules = new Set(
      WITH_FIXES.flatMap(({ findings }) => findings.filter((f) => f.fix).map((f) => f.ruleId)),
    );
    expect([...rules].sort()).toEqual([
      'GL001',
      'GL002',
      'GL003',
      'GL004',
      'GL005',
      'GL007',
      'GL008',
      'GL009',
    ]);
  });

  describe.each(
    WITH_FIXES.map((c) => [`${c.fixture.rule}/${c.fixture.kind}/${c.fixture.name}`, c] as const),
  )('%s', (_, { fixture, findings }) => {
    const before = new Set(findings.map(key));
    const fixable = findings.filter((f) => f.fix !== undefined);

    it.each(fixable.map((f) => [`${f.ruleId} ${f.file}:${String(f.line)}`, f] as const))(
      'the fix for %s runs on Postgres and clears its finding',
      async (_, finding) => {
        const after = await lintFixed(fixture, [finding]);
        const keys = after.findings.map(key);
        expect(keys).not.toContain(key(finding));
        expect(keys.filter((k) => !before.has(k))).toEqual([]);
      },
    );

    it('all fixes together leave only findings that print no fix', async () => {
      const after = await lintFixed(fixture, fixable);
      const unfixable = findings.filter((f) => f.fix === undefined).map(key);
      expect(after.findings.map(key)).toEqual(unfixable);
    });
  });
});
