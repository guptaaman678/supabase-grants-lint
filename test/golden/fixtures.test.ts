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
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RULE_IDS, type RuleId } from '../../src/config/defaults.js';
import { loadParser, type MigrationParser } from '../../src/parse/adapter.js';
import { RULES } from '../../src/rules/index.js';
import type { TestDatabase } from '../support/database.js';
import {
  expectedOf,
  FIXTURES,
  FIXTURES_ROOT as ROOT,
  KINDS,
  lintFixture,
  subdirs,
} from '../support/fixtures.js';

let parser: MigrationParser;

beforeAll(async () => {
  parser = await loadParser();
});

const open: TestDatabase[] = [];

afterAll(async () => {
  await Promise.all(open.map((db) => db.close()));
});

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
      const expected = expectedOf(fixture);
      const { findings, notices } = await lintFixture(parser, fixture, {
        opened: (db) => open.push(db),
      });
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
