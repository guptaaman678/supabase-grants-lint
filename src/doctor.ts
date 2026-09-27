/**
 * `doctor` (spec §6.3, T4.6): the readiness report for 2026-10-30, in four sections. Opt-in status
 * (the resolved `since`, ADR-002 item 2 wording when there is none); Replay trap (GL007, plus the
 * local stack's `[api] auto_expose_new_tables` in `supabase/config.toml`, ADR-002 item 3); History
 * exposure (a dry run with `since: none` and `platformDefaults: explicit`: GL001 and GL002 on every
 * relation the migrations create); Next steps (the opt-in SQL and the `init` command). With a
 * database URL (spec T11.1), a Live database section: its automatic grants for new tables and the
 * drift GL009 finds.
 *
 * `doctor` informs and never fails, so config `rules`, `ignore` and inline suppressions hide
 * nothing here. It reads files inside the project only, and connects only when given a database
 * URL (G4).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type Colors, colors as makeColors } from './cli/color.js';
import type { Config } from './config/defaults.js';
import { quoteIdent, sqlGrantee } from './fix/sql.js';
import { type LintOptions, loadProject } from './lint.js';
import { toRelPath } from './load/discover.js';
import { readLive } from './drift.js';
import type { LiveSnapshot } from './live/snapshot.js';
import { DML_PRIVILEGES } from './model/acl.js';
import { LEGACY_DEFAULTS } from './model/defaults.js';
import type { RelationName } from './model/relations.js';
import { qualified } from './replay/context.js';
import type { ReplayResult } from './replay/engine.js';
import { replayWithWindow, type ResolvedSince, type WindowedReplay } from './replay/since.js';
import { GL001 } from './rules/GL001.js';
import { GL002 } from './rules/GL002.js';
import { GL007 } from './rules/GL007.js';
import { GL009 } from './rules/GL009.js';
import { type Finding, runRules } from './rules/index.js';
import { PARSE001 } from './rules/PARSE001.js';
import { PARSE002 } from './rules/PARSE002.js';

/** A relation that a database built from the migrations without automatic grants cannot reach. */
export interface Exposure {
  /** `schema.name`. */
  readonly relation: string;
  readonly file: string;
  readonly line: number;
  /** The service role (GL001) and the client roles its policies name (GL002). */
  readonly roles: readonly string[];
}

export interface LocalStack {
  /** `supabase/config.toml`, relative to the working directory; `null` when there is none. */
  readonly file: string | null;
  /** `[api] auto_expose_new_tables`; `null` when unset (or no file). */
  readonly autoExpose: boolean | null;
}

export interface DoctorReport {
  readonly config: Config;
  readonly files: number;
  /** In-scope relations that exist after the last migration. */
  readonly relations: number;
  readonly since: ResolvedSince;
  /** Migration files `check` enforces. */
  readonly enforced: number;
  /** PARSE001 and PARSE002 findings: SQL the replay could not model. */
  readonly unmodelled: number;
  /** The GL007 finding, if any. */
  readonly replayTrap: Finding | null;
  readonly localStack: LocalStack;
  readonly history: {
    /**
     * In-scope relations the migrations create and leave in place at the end of the creating file
     * (a relation dropped and created again in a later file counts twice).
     */
    readonly created: number;
    readonly unreachable: readonly Exposure[];
  };
  /**
   * In-scope relations that a named GRANT or REVOKE, or a policy, refers to but no migration
   * creates (typically made in the dashboard), as `schema.name` in order of first reference. The
   * replay cannot check them.
   */
  readonly notCreated: readonly string[];
  /** Only with a database URL. */
  readonly live: LiveReport | null;
}

export interface LiveReport {
  /** `server_version_num`. */
  readonly serverVersion: number;
  /**
   * Per scoped schema, the API roles (client roles and the service role) that new tables created
   * by `migrationRole` get any of select, insert, update, delete from automatically.
   */
  readonly autoGrants: readonly { readonly schema: string; readonly roles: readonly string[] }[];
  /** GL009 findings. */
  readonly drift: number;
}

export interface DoctorOptions extends LintOptions {
  /** Read this database too (live mode). */
  readonly dbUrl?: string;
}

/** In-scope relations the migrations grant on, revoke on or add policies to, but never create. */
export function referencedNotCreated(replay: ReplayResult): string[] {
  const created = new Set(
    replay.files.flatMap((file) =>
      file.events.flatMap((event) =>
        event.kind === 'created' && event.object === 'relation' ? [qualified(event.name)] : [],
      ),
    ),
  );
  const referenced = replay.files.flatMap((file) =>
    file.events.flatMap((event): RelationName[] => {
      if (event.kind === 'grant' && event.objectKind === 'table') return [...event.untracked];
      if (event.kind === 'policy') return [event.relation];
      return [];
    }),
  );
  return [
    ...new Set(referenced.filter((name) => replay.inScope(name)).map((name) => qualified(name))),
  ].filter((name) => !created.has(name));
}

/** Builds the report. Rejects with a `UsageError` (exit 2) for a bad config or path. */
export async function diagnose(options: DoctorOptions = {}): Promise<DoctorReport> {
  const project = await loadProject(options);
  const config: Config = { ...project.config, rules: {}, ignore: [] };
  const replay = replayWithWindow(project.inputs, { ...config, cliSince: project.cliSince });
  const current = runRules({
    config,
    replay,
    discovery: project.discovery,
    rules: [GL007, PARSE001, PARSE002],
  }).findings;

  const explicit: Config = { ...config, since: 'none', platformDefaults: 'explicit' };
  const history = replayWithWindow(project.inputs, explicit);
  const unreachable = new Map<string, Exposure>();
  for (const finding of runRules({ config: explicit, replay: history, rules: [GL001, GL002] })
    .findings) {
    const key = JSON.stringify([finding.relation, finding.file, finding.line]);
    const seen = unreachable.get(key);
    const role = finding.role ?? '';
    unreachable.set(key, {
      relation: finding.relation ?? '',
      file: finding.file,
      line: finding.line,
      roles: seen === undefined ? [role] : [...seen.roles, role],
    });
  }

  return {
    config: project.config,
    files: project.inputs.length,
    relations: replay.final.relations().filter((relation) => replay.inScope(relation)).length,
    since: replay.since,
    enforced: replay.files.filter((file) => replay.isEnforced(file)).length,
    unmodelled: current.filter((f) => f.ruleId !== 'GL007').length,
    replayTrap: current.find((f) => f.ruleId === 'GL007') ?? null,
    localStack: readLocalStack(project.projectDir, project.cwd),
    history: {
      created: history.files.flatMap((file) => file.created).filter((r) => history.inScope(r))
        .length,
      unreachable: [...unreachable.values()],
    },
    notCreated: referencedNotCreated(replay),
    live:
      options.dbUrl === undefined
        ? null
        : liveReport(config, replay, await readLive(options.dbUrl, config.schemas)),
  };
}

function liveReport(config: Config, replay: WindowedReplay, live: LiveSnapshot): LiveReport {
  const apiRoles = [...new Set([...config.clientRoles, config.serviceRole])];
  return {
    serverVersion: live.serverVersion,
    autoGrants: config.schemas.map((schema) => {
      const acl = live.defaults.effective(config.migrationRole, schema, 'table');
      return {
        schema,
        roles: apiRoles.filter((role) => DML_PRIVILEGES.some((p) => acl.holds(role, p))),
      };
    }),
    drift: runRules({ config, replay, rules: [GL009], live }).findings.length,
  };
}

function readLocalStack(projectDir: string, cwd: string): LocalStack {
  const file = path.join(projectDir, 'supabase', 'config.toml');
  if (!existsSync(file)) return { file: null, autoExpose: null };
  return { file: toRelPath(cwd, file), autoExpose: autoExposeSetting(readFileSync(file, 'utf8')) };
}

/**
 * `[api] auto_expose_new_tables` from a Supabase `config.toml`, or `null` when unset. A minimal
 * lookup (tables, dotted keys, comments), not a TOML parser (G5).
 */
export function autoExposeSetting(toml: string): boolean | null {
  let table = '';
  let value: boolean | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[\[?([^\]]*)\]\]?$/.exec(line);
    if (header !== null) {
      table = unquote(header[1] ?? '');
      continue;
    }
    const pair = /^([^=]+)=\s*(true|false)$/.exec(line);
    if (pair === null) continue;
    const key = [table, unquote(pair[1] ?? '')].filter((part) => part !== '').join('.');
    if (key === 'api.auto_expose_new_tables') value = pair[2] === 'true';
  }
  return value;
}

/** `"api" . auto_expose` -> `api.auto_expose`. */
function unquote(key: string): string {
  return key
    .split('.')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    .join('.');
}

const BIN = 'supabase-grants-lint';
/** Every line of the report fits this many columns, except a path longer than a line. */
export const WIDTH = 100;

const NBSP = ' ';

/** Text `wrap` keeps on one line: a command, a setting. */
function keep(text: string): string {
  return text.replaceAll(' ', NBSP);
}

/** Wraps `text` at spaces: `first` starts line one, `rest` the others. */
export function wrap(text: string, first: string, rest = ' '.repeat(first.length)): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const word of text.split(' ')) {
    if (!empty && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = rest + word;
    } else {
      line = empty ? line + word : `${line} ${word}`;
    }
    empty = false;
  }
  lines.push(line);
  return lines.map((l) => l.replaceAll(NBSP, ' '));
}

/**
 * SQL, one statement per line. A statement too long for the width breaks before its `grant` or
 * `revoke` clause first, then at spaces; continuation lines are indented two more.
 */
function sqlLines(sql: string, indent: string): string[] {
  return sql.split('\n').flatMap((statement) => {
    const clause = /^(alter default privileges .*?) ((?:grant|revoke) .*)$/.exec(statement);
    if (indent.length + statement.length <= WIDTH || clause === null) {
      return wrap(statement, indent, `${indent}  `);
    }
    const [, head = '', tail = ''] = clause;
    return [...wrap(head, indent, `${indent}  `), ...wrap(tail, `${indent}  `)];
  });
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** The opt-in migration: revoke every default grant to the API roles, per scoped schema. */
export function optInSql(config: Config): string {
  const grantees = [
    ...new Set([...LEGACY_DEFAULTS.grantees, ...config.clientRoles, config.serviceRole]),
  ]
    .map(sqlGrantee)
    .join(', ');
  const role = quoteIdent(config.migrationRole);
  return config.schemas
    .flatMap((schema) =>
      (['tables', 'sequences'] as const).map(
        (kind) =>
          `alter default privileges for role ${role} in schema ${quoteIdent(schema)} ` +
          `revoke all on ${kind} from ${grantees};`,
      ),
    )
    .join('\n');
}

const INIT = keep(`${BIN} init`);
const INIT_NEXT = keep(`${BIN} init --since next`);
const CHECK = keep(`${BIN} check`);
const DB_RESET = keep('supabase db reset');
const NEW_MIGRATION = keep('supabase migration new revoke_automatic_grants');
const EXPOSE_OFF = keep('auto_expose_new_tables = false');
const API_KEY = keep('[api] auto_expose_new_tables');

function optInStatus(report: DoctorReport): string[] {
  const { since, enforced } = report;
  const after =
    enforced === 0
      ? 'no migrations after it yet; check will enforce every new one'
      : `check enforces the ${plural(enforced, 'migration file')} after it`;
  const from = since.source === 'cli' ? '--since' : 'the config';
  const lines: string[] = [];
  if (since.value === null) {
    lines.push(
      ...wrap(
        'No opt-in migration found. If your project was opted in from the dashboard, or you are ' +
          'past 2026-10-30, set since to the last migration applied before that ' +
          `(${INIT_NEXT}).`,
        '  ',
      ),
    );
  } else if (since.detected !== null) {
    const { file, line } = since.detected.at;
    const sentence = enforced === 0 ? `N${after.slice(1)}` : after;
    lines.push(...wrap(`Opted in by ${file}:${String(line)}. ${sentence}.`, '  '));
  } else if (since.value === 'none') {
    lines.push(...wrap(`since is none (from ${from}): check enforces every migration file.`, '  '));
  } else {
    const revoke =
      report.config.platformRevokeAtSince && enforced > 0
        ? ', and assumes the platform revoke before the first of them'
        : '';
    lines.push(...wrap(`since is ${since.value} (from ${from}): ${after}${revoke}.`, '  '));
  }
  if (report.unmodelled > 0) {
    lines.push(
      ...wrap(
        `${plural(report.unmodelled, 'statement or file')} could not be modelled ` +
          `(PARSE001, PARSE002); run ${CHECK} to see them.`,
        '  ',
      ),
    );
  }
  return lines;
}

function replayTrap(report: DoctorReport): string[] {
  const trap = report.replayTrap;
  const lines =
    trap === null
      ? wrap('No migration re-enables automatic grants for new relations.', '  ')
      : [
          ...wrap(
            `GL007 ${trap.severity} at ${trap.file}:${String(trap.line)}: ${trap.message}`,
            '  ',
          ),
          '  Fix:',
          ...sqlLines(trap.fix ?? '', '    '),
        ];
  const { file, autoExpose } = report.localStack;
  const reset =
    `${DB_RESET} locally gives new tables grants production will not have; set ` + `${EXPOSE_OFF}.`;
  const local =
    file === null
      ? 'No supabase/config.toml found, so the local stack setting was not checked.'
      : autoExpose === false
        ? `${file} sets ${API_KEY} = false, so local resets revoke the automatic grants as ` +
          'production does.'
        : autoExpose === true
          ? `${file} sets ${API_KEY} = true: ${reset}`
          : `${file} does not set ${API_KEY} (unset means true on Supabase CLI v2.116.0 and ` +
            `later): ${reset}`;
  return [...lines, ...wrap(local, '  ')];
}

function historyExposure(report: DoctorReport): string[] {
  return [...createdExposure(report), ...notCreated(report)];
}

function notCreated(report: DoctorReport): string[] {
  const names = report.notCreated;
  if (names.length === 0) return [];
  const which = names.length === 1 ? 'is' : 'are';
  return wrap(
    `${plural(names.length, 'relation')} ${which} granted on or given policies in the ` +
      `migrations but never created in them (probably created in the dashboard), so check ` +
      `cannot see ${names.length === 1 ? 'it' : 'them'}: ${names.join(', ')}. Relations your ` +
      'migrations create from now on are checked.',
    '  ',
  );
}

function createdExposure(report: DoctorReport): string[] {
  const { created, unreachable } = report.history;
  const head = 'Replayed without automatic grants (since none, platformDefaults explicit),';
  if (created === 0) return ['  The migrations create no relations.'];
  if (unreachable.length === 0) {
    return wrap(
      `${head} none of the ${plural(created, 'relation')} the migrations create would be ` +
        'unreachable through the Data API.',
      '  ',
    );
  }
  return [
    ...wrap(
      `${head} ${String(unreachable.length)} of the ${plural(created, 'relation')} the ` +
        'migrations create would be unreachable through the Data API for these roles:',
      '  ',
    ),
    ...unreachable.flatMap((e) =>
      wrap(`${e.relation} (${e.roles.join(', ')}) at ${e.file}:${String(e.line)}`, '  - ', '    '),
    ),
    ...wrap(
      'Production keeps the grants these relations already have, but a database built from the ' +
        'migrations without automatic grants (a new project, a local reset with ' +
        `${EXPOSE_OFF}) gives them none.`,
      '  ',
    ),
  ];
}

/** `server_version_num` as Postgres 10 and later print it: 170002 -> 17.2. */
export function postgresVersion(num: number): string {
  return `${String(Math.floor(num / 10000))}.${String(num % 10000)}`;
}

function liveDatabase(live: LiveReport, config: Config): string[] {
  const lines = wrap(
    `Read the database (Postgres ${postgresVersion(live.serverVersion)}), read-only.`,
    '  ',
  );
  for (const { schema, roles } of live.autoGrants) {
    lines.push(
      ...wrap(
        roles.length === 0
          ? `New tables ${config.migrationRole} creates in schema ${schema} get no automatic ` +
              'grants: the database is opted in, so every migration must grant what the Data API needs.'
          : `New tables ${config.migrationRole} creates in schema ${schema} are still granted to ` +
              `${roles.join(', ')} automatically: the database is not opted in yet.`,
        '  ',
      ),
    );
  }
  lines.push(
    ...wrap(
      live.drift === 0
        ? 'No drift: the database has the grants, default privileges and policies the migrations give.'
        : `${plural(live.drift, 'difference')} between the database and the migrations (GL009); run ` +
            `${keep(`${BIN} diff`)} to list them.`,
      '  ',
    ),
  );
  return lines;
}

function nextSteps(report: DoctorReport): string[] {
  const steps: string[][] = [];
  const step = (text: string, sql?: string): void => {
    steps.push([
      ...wrap(text, `  ${String(steps.length + 1)}. `, '     '),
      ...(sql === undefined ? [] : sqlLines(sql, '       ')),
    ]);
  };
  const { since, replayTrap: trap, localStack, history } = report;
  if (since.value === null) {
    step(`Opt in with a new migration (${NEW_MIGRATION}) containing:`, optInSql(report.config));
    step(
      `If the project was already opted in from the dashboard, run ${INIT_NEXT} ` +
        'instead, so check enforces only the migrations you add from now on.',
    );
  } else if (since.detected === null) {
    step(
      'To make fresh databases (a new project, a local reset) match production, add a migration ' +
        'containing the opt-in SQL:',
      optInSql(report.config),
    );
  }
  if (trap !== null) {
    step('Remove the default grants the migrations re-enable, in a new migration:', trap.fix);
  }
  if (localStack.file !== null && localStack.autoExpose !== false) {
    step(`Set ${EXPOSE_OFF} under [api] in ${localStack.file}.`);
  }
  if (history.unreachable.length > 0) {
    step(
      'Grant the relations listed under History exposure what their roles need, in a new ' +
        'migration, so a database built from the migrations can reach them.',
    );
  }
  step(
    `Lint every new migration in CI: ${INIT} writes grants-lint.config.json and a GitHub ` +
      'workflow that runs check.',
  );
  return steps.flat();
}

/** The report as text, at most `WIDTH` columns wide. Section titles are bold when colour is on. */
export function formatDoctor(report: DoctorReport, c: Colors = makeColors(false)): string {
  const schemas = report.config.schemas;
  const intro =
    report.files === 0
      ? ['No migration files found.']
      : wrap(
          `Replayed ${plural(report.files, 'migration file')}: ` +
            `${plural(report.relations, 'relation')} in ` +
            `${schemas.length === 1 ? 'schema' : 'schemas'} ${schemas.join(', ')} after the last one.`,
          '',
        );
  const sections: [string, string[]][] = [
    ['Opt-in status', optInStatus(report)],
    ['Replay trap', replayTrap(report)],
    ['History exposure', historyExposure(report)],
    ...(report.live === null
      ? []
      : [['Live database', liveDatabase(report.live, report.config)] as [string, string[]]]),
    ['Next steps', nextSteps(report)],
  ];
  const blocks = [
    [c.bold(`${BIN} doctor: readiness for 2026-10-30`), ...intro],
    ...sections.map(([title, lines]) => [c.bold(title), ...lines]),
  ];
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}
