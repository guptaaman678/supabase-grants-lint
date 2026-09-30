/**
 * Rule fixtures (spec §5.1, G9): `test/fixtures/<RULE>/<pass|fail>/<case>/` holds
 * `migrations/*.sql`, `expected.json` and optionally `config.json` and `database.sql`. Shared by
 * the fixture test and the fix-text verification (spec T11.3), which lints edited copies.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuleId } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/load.js';
import { discoverMigrations } from '../../src/load/discover.js';
import type { MigrationParser } from '../../src/parse/adapter.js';
import { replayWithWindow } from '../../src/replay/since.js';
import { readLive } from '../../src/drift.js';
import { RULES, runRules } from '../../src/rules/index.js';
import type { RuleRunResult } from '../../src/rules/types.js';
import type { TestDatabase } from './database.js';
import { databaseFor } from './live-project.js';

export const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures', import.meta.url));
export const KINDS = ['pass', 'fail'] as const;

export interface ExpectedFinding {
  readonly rule: RuleId;
  readonly severity: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly relation?: string;
  readonly role?: string;
}

export interface ExpectedNotice {
  readonly code: string;
  readonly file?: string;
  readonly line?: number;
}

export interface Expected {
  readonly rules?: readonly RuleId[];
  readonly findings: readonly ExpectedFinding[];
  readonly notices?: readonly ExpectedNotice[];
}

export interface Fixture {
  readonly rule: RuleId;
  readonly kind: (typeof KINDS)[number];
  readonly name: string;
  readonly dir: string;
}

export function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export const FIXTURES: Fixture[] = subdirs(FIXTURES_ROOT).flatMap((rule) =>
  KINDS.flatMap((kind) =>
    subdirs(path.join(FIXTURES_ROOT, rule, kind)).map((name) => ({
      rule: rule as RuleId,
      kind,
      name,
      dir: path.join(FIXTURES_ROOT, rule, kind, name),
    })),
  ),
);

export function expectedOf(fixture: Fixture): Expected {
  return JSON.parse(readFileSync(path.join(fixture.dir, 'expected.json'), 'utf8')) as Expected;
}

export interface LintOptions {
  /** Lint this copy of the fixture instead of the fixture itself. */
  readonly dir?: string;
  /** SQL run on the live database after `database.sql` (GL009 cases only). */
  readonly byHand?: readonly string[];
  /** Receives the GL009 case's database, so the caller can close it. */
  readonly opened?: (db: TestDatabase) => void;
}

/**
 * Lints a fixture through the real pipeline (config, discovery, parser, replay, rules), running
 * the rules `expected.json` lists (default: the fixture's own). A GL009 case compares with a real
 * Postgres built from its migrations, then `database.sql`, then `byHand`.
 */
export async function lintFixture(
  parser: MigrationParser,
  fixture: Fixture,
  options: LintOptions = {},
): Promise<RuleRunResult> {
  const dir = options.dir ?? fixture.dir;
  const expected = expectedOf(fixture);
  const { config } = loadConfig({
    cwd: dir,
    projectDir: dir,
    ...(existsSync(path.join(dir, 'config.json')) ? { configFile: 'config.json' } : {}),
  });
  const { files, notices } = discoverMigrations({
    migrations: 'migrations',
    projectDir: dir,
    cwd: dir,
  });
  const parsed = files.map((file) => parser.parse(readFileSync(file.path, 'utf8'), file.relPath));
  const replay = replayWithWindow(
    files.map((file, i) => ({
      file: file.relPath,
      version: file.version,
      statements: parsed[i]?.statements ?? [],
    })),
    config,
  );
  const ids = expected.rules ?? [fixture.rule];
  let live;
  if (fixture.rule === 'GL009') {
    const database = path.join(dir, 'database.sql');
    const db = await databaseFor(
      dir,
      [
        ...(existsSync(database) ? [readFileSync(database, 'utf8')] : []),
        ...(options.byHand ?? []),
      ],
      'migrations',
    );
    options.opened?.(db);
    live = await readLive(db.url, config.schemas);
  }
  return runRules({
    config,
    replay,
    suppressions: parsed.flatMap((p) => p.suppressions),
    suppressionProblems: parsed.flatMap((p) => p.suppressionProblems),
    discovery: notices,
    rules: RULES.filter((rule) => ids.includes(rule.id)),
    ...(live === undefined ? {} : { live }),
  });
}
