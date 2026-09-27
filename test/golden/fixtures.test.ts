/**
 * Rule fixtures (spec §5.1, G9): `test/fixtures/<RULE>/<pass|fail>/<case>/` holds
 * `migrations/*.sql`, `expected.json` and optionally `config.json`. Each case is linted through the
 * real pipeline (config, discovery, parser, replay, rules) and must report exactly the findings
 * and notices in `expected.json`.
 *
 * `expected.json`: `{ "rules"?: RuleId[], "findings": [...], "notices"?: [...] }`. `rules` lists the
 * rules to run (default: the fixture's own rule), so adding a rule never changes another rule's
 * fixtures. A `pass` case reports nothing for its rule; a `fail` case reports at least one finding.
 *
 * GL009 (drift) compares with a live database: its cases build a real Postgres from the fixture's
 * migrations plus `database.sql`, the changes made by hand (see `test/support/database.ts`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RULE_IDS, type RuleId } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/load.js';
import { discoverMigrations } from '../../src/load/discover.js';
import { loadParser, type MigrationParser } from '../../src/parse/adapter.js';
import { replayWithWindow } from '../../src/replay/since.js';
import { readLive } from '../../src/drift.js';
import type { LiveSnapshot } from '../../src/live/snapshot.js';
import { RULES, runRules } from '../../src/rules/index.js';
import type { TestDatabase } from '../support/database.js';
import { databaseFor } from '../support/live-project.js';

const ROOT = fileURLToPath(new URL('../fixtures', import.meta.url));
const KINDS = ['pass', 'fail'] as const;

interface ExpectedFinding {
  readonly rule: RuleId;
  readonly severity: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly relation?: string;
  readonly role?: string;
}

interface ExpectedNotice {
  readonly code: string;
  readonly file?: string;
  readonly line?: number;
}

interface Expected {
  readonly rules?: readonly RuleId[];
  readonly findings: readonly ExpectedFinding[];
  readonly notices?: readonly ExpectedNotice[];
}

interface Fixture {
  readonly rule: RuleId;
  readonly kind: (typeof KINDS)[number];
  readonly name: string;
  readonly dir: string;
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const FIXTURES: Fixture[] = subdirs(ROOT).flatMap((rule) =>
  KINDS.flatMap((kind) =>
    subdirs(path.join(ROOT, rule, kind)).map((name) => ({
      rule: rule as RuleId,
      kind,
      name,
      dir: path.join(ROOT, rule, kind, name),
    })),
  ),
);

let parser: MigrationParser;

beforeAll(async () => {
  parser = await loadParser();
});

const open: TestDatabase[] = [];

afterAll(async () => {
  await Promise.all(open.map((db) => db.close()));
});

/** The live database for a GL009 case: its migrations applied, then `database.sql`. */
async function liveFor(fixture: Fixture, schemas: readonly string[]): Promise<LiveSnapshot> {
  const byHand = path.join(fixture.dir, 'database.sql');
  const db = await databaseFor(
    fixture.dir,
    existsSync(byHand) ? [readFileSync(byHand, 'utf8')] : [],
    'migrations',
  );
  open.push(db);
  return readLive(db.url, schemas);
}

async function lint(fixture: Fixture, expected: Expected) {
  const { dir } = fixture;
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
  const live = fixture.rule === 'GL009' ? await liveFor(fixture, config.schemas) : undefined;
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

describe('fixture layout', () => {
  it('has a pass and a fail case for every implemented rule', () => {
    for (const rule of RULES) {
      for (const kind of KINDS) {
        expect(
          FIXTURES.filter((f) => f.rule === rule.id && f.kind === kind).length,
          `${rule.id}/${kind}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('only has fixtures for implemented rules, each with migrations and expected.json', () => {
    const implemented = RULES.map((rule) => rule.id);
    expect(subdirs(ROOT).every((rule) => RULE_IDS.includes(rule as RuleId))).toBe(true);
    for (const fixture of FIXTURES) {
      const where = path.relative(ROOT, fixture.dir);
      expect(implemented, where).toContain(fixture.rule);
      expect(existsSync(path.join(fixture.dir, 'expected.json')), where).toBe(true);
      const sql = readdirSync(path.join(fixture.dir, 'migrations')).filter((n) =>
        n.endsWith('.sql'),
      );
      expect(sql.length, where).toBeGreaterThan(0);
    }
  });
});

describe.each(FIXTURES.map((f) => [`${f.rule}/${f.kind}/${f.name}`, f] as const))(
  '%s',
  (_, fixture) => {
    it('reports exactly the expected findings and notices', async () => {
      const expected = JSON.parse(
        readFileSync(path.join(fixture.dir, 'expected.json'), 'utf8'),
      ) as Expected;
      const { findings, notices } = await lint(fixture, expected);
      expect(
        findings.map((f) => ({
          rule: f.ruleId,
          severity: f.severity,
          file: f.file,
          line: f.line,
          column: f.column,
          ...(f.relation === undefined ? {} : { relation: f.relation }),
          ...(f.role === undefined ? {} : { role: f.role }),
        })),
      ).toEqual(expected.findings);
      expect(
        notices.map((n) => ({
          code: n.code,
          ...(n.file === undefined ? {} : { file: n.file }),
          ...(n.line === undefined ? {} : { line: n.line }),
        })),
      ).toEqual(expected.notices ?? []);

      const own = expected.findings.filter((f) => f.rule === fixture.rule);
      if (fixture.kind === 'pass') expect(own).toEqual([]);
      else expect(own.length).toBeGreaterThan(0);
    });
  },
);
