/**
 * Rule docs (spec T8.2): `docs/rules/<ID>.md` for every registered rule, at the path each finding's
 * `docsUrl` points to, with the same sections on every page. The examples are real: the SQL blocks
 * under "Failing example" are written to a temporary project and linted, the rule must report a
 * finding, and the `text` block there must equal the pretty output (version in the docs link and
 * duration normalised). The blocks under "Fix" are applied on top and the rule must go quiet.
 *
 * A SQL block names its file on its first line (`-- supabase/migrations/<name>.sql`); a
 * `json grants-lint.config.json` block is the project config. A SQL block starting
 * `-- run in the database` is a change made by hand: the example then builds a real database from
 * the migrations plus that SQL and runs `diff` (live mode, GL009). Regenerate the output blocks
 * with `UPDATE_GOLDEN=1`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { drift } from '../../src/drift.js';
import { lint } from '../../src/lint.js';
import { formatPretty } from '../../src/report/pretty.js';
import { docsUrl, RULES } from '../../src/rules/index.js';
import type { TestDatabase } from '../support/database.js';
import { databaseFor } from '../support/live-project.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const RULE_DOCS = path.join(REPO, 'docs', 'rules');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

const SECTIONS = [
  'What it catches',
  'Why it matters',
  'Failing example',
  'Fix',
  'When it is safe to disable',
  'Configuration',
];

const REFERENCE_DOCS = ['configuration.md', 'how-it-works.md', 'faq.md', 'live-mode.md'];

interface Block {
  readonly lang: string;
  readonly meta: string;
  readonly body: string;
  /** Offsets of the body in the page, for rewriting it. */
  readonly start: number;
  readonly end: number;
}

interface Section {
  readonly title: string;
  readonly start: number;
  readonly text: string;
}

function sections(page: string): Section[] {
  const heads = [...page.matchAll(/^## (.+)$/gm)];
  return heads.map((m, i) => {
    const start = m.index;
    const end = heads[i + 1]?.index ?? page.length;
    return { title: (m[1] ?? '').trim(), start, text: page.slice(start, end) };
  });
}

function blocks(section: Section): Block[] {
  return [...section.text.matchAll(/^```(\w*)[ \t]*(.*)\n([\s\S]*?)^```$/gm)].map((m) => {
    const body = m[3] ?? '';
    const start = section.start + m.index + m[0].indexOf('\n') + 1;
    return {
      lang: m[1] ?? '',
      meta: (m[2] ?? '').trim(),
      body,
      start,
      end: start + body.length,
    };
  });
}

/** The project files a section's blocks write: migrations by their first-line path, and config. */
function projectFiles(section: Section): Map<string, string> {
  const files = new Map<string, string>();
  for (const block of blocks(section)) {
    if (block.lang === 'sql') {
      const name = /^-- (supabase\/migrations\/\S+\.sql)\n/.exec(block.body)?.[1];
      if (name !== undefined) files.set(name, block.body);
      else if (block.body.startsWith(BY_HAND)) files.set(BY_HAND, block.body);
    } else if (block.lang === 'json' && block.meta === 'grants-lint.config.json') {
      files.set('grants-lint.config.json', block.body);
    }
  }
  return files;
}

/** The first line of a SQL block that runs in the database, not in a migration. */
const BY_HAND = '-- run in the database';

const temps: string[] = [];
const databases: TestDatabase[] = [];

afterAll(async () => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  await Promise.all(databases.map((db) => db.close()));
});

async function lintProject(files: Map<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grants-lint-docs-'));
  temps.push(dir);
  mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true });
  for (const [name, body] of files) {
    if (name !== BY_HAND) writeFileSync(path.join(dir, name), body);
  }
  const byHand = files.get(BY_HAND);
  if (byHand === undefined) return lint({ cwd: dir, dir });
  const db = await databaseFor(dir, [byHand]);
  databases.push(db);
  return drift({ cwd: dir, dir, dbUrl: db.url });
}

/** The docs link names the release and the summary a duration; neither is part of the example. */
function normalise(output: string): string {
  return output
    .replace(/\/blob\/v[^/]+\/docs\//g, '/blob/v0.1.0/docs/')
    .replace(/, [0-9.]+s\)$/gm, ', 0.0s)');
}

function readPage(id: string): string {
  return readFileSync(path.join(RULE_DOCS, `${id}.md`), 'utf8');
}

describe('rule docs layout', () => {
  it('has exactly one page per registered rule', () => {
    const pages = readdirSync(RULE_DOCS)
      .filter((name) => name.endsWith('.md'))
      .sort();
    expect(pages).toEqual(RULES.map((rule) => `${rule.id}.md`).sort());
  });

  it("puts each page where the finding's docsUrl points once the release is tagged", () => {
    for (const rule of RULES) {
      const url = docsUrl(rule.id, '1.2.3');
      const prefix = 'https://github.com/guptaaman678/supabase-grants-lint/blob/v1.2.3/';
      expect(url.startsWith(prefix), url).toBe(true);
      expect(existsSync(path.join(REPO, url.slice(prefix.length))), url).toBe(true);
    }
  });

  it('has the reference pages', () => {
    for (const name of REFERENCE_DOCS) {
      expect(existsSync(path.join(REPO, 'docs', name)), name).toBe(true);
    }
  });

  it('has no em dash in any docs page (G7)', () => {
    const pages = [
      ...readdirSync(RULE_DOCS).map((name) => path.join(RULE_DOCS, name)),
      ...REFERENCE_DOCS.map((name) => path.join(REPO, 'docs', name)),
    ];
    const emDash = String.fromCodePoint(0x2014);
    for (const page of pages) expect(readFileSync(page, 'utf8'), page).not.toContain(emDash);
  });
});

describe.each(RULES.map((rule) => [rule.id, rule] as const))('docs/rules/%s.md', (id, rule) => {
  it('starts with the ID, name and default severity', () => {
    const [title, , severity] = readPage(id).split('\n');
    expect(title).toBe(`# ${id} ${rule.name}`);
    // A rule whose findings can have another severity says when, after the default.
    expect(severity).toMatch(
      new RegExp(`^Default severity: \\*\\*${rule.defaultSeverity}\\*\\*[ .]`),
    );
  });

  it('has every section, in order', () => {
    expect(sections(readPage(id)).map((s) => s.title)).toEqual(SECTIONS);
  });

  it('has a failing example the rule reports, with its real output', async () => {
    let page = readPage(id);
    const failing = sections(page).find((s) => s.title === 'Failing example');
    if (failing === undefined) throw new Error(`${id}: no Failing example section`);
    const files = projectFiles(failing);
    expect(files.size, 'example migrations').toBeGreaterThan(0);

    const result = await lintProject(files);
    expect(result.findings.map((f) => f.ruleId)).toContain(id);

    const output = blocks(failing).find((b) => b.lang === 'text');
    if (output === undefined) throw new Error(`${id}: no text block with the output`);
    const actual = normalise(formatPretty(result));
    if (UPDATE && output.body !== actual) {
      page = page.slice(0, output.start) + actual + page.slice(output.end);
      writeFileSync(path.join(RULE_DOCS, `${id}.md`), page);
    }
    expect(output.body).toBe(actual);
  });

  it('has a fix that clears the finding', async () => {
    const page = readPage(id);
    const found = sections(page);
    const failing = found.find((s) => s.title === 'Failing example');
    const fix = found.find((s) => s.title === 'Fix');
    if (failing === undefined || fix === undefined) throw new Error(`${id}: sections missing`);
    const fixFiles = projectFiles(fix);
    expect(fixFiles.size, 'fix files').toBeGreaterThan(0);

    const files = new Map([...projectFiles(failing), ...fixFiles]);
    const result = await lintProject(files);
    expect(result.findings.filter((f) => f.ruleId === id)).toEqual([]);
  });
});
