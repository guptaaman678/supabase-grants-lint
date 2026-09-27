/**
 * The rule registry and the framework that runs it (spec §6.2, T3.0): runs each enabled rule once
 * over the replay, applies config severities, lets GL002 take precedence over GL003, applies config
 * `ignore` entries and inline `grants-lint-disable-next-line` comments, reports suppressions that
 * matched nothing, and sorts the findings by file, line, column and rule.
 */
import { type Config, RULE_IDS, type RuleId } from '../config/defaults.js';
import { ConfigError } from '../errors.js';
import type { LiveSnapshot } from '../live/snapshot.js';
import type { DiscoveryNotice } from '../load/discover.js';
import { type Grantee, PUBLIC } from '../model/acl.js';
import type { RelationName } from '../model/relations.js';
import {
  type Suppression,
  type SuppressionProblem,
  suppressionError,
} from '../parse/suppressions.js';
import { locate, type PlatformRevokeEvent, qualified } from '../replay/context.js';
import type { WindowedReplay } from '../replay/since.js';
import { version } from '../version.js';
import { GL000 } from './GL000.js';
import { GL001 } from './GL001.js';
import { GL002 } from './GL002.js';
import { GL003 } from './GL003.js';
import { GL004 } from './GL004.js';
import { GL005 } from './GL005.js';
import { GL006 } from './GL006.js';
import { GL007 } from './GL007.js';
import { GL008 } from './GL008.js';
import { GL009 } from './GL009.js';
import { PARSE001 } from './PARSE001.js';
import { PARSE002 } from './PARSE002.js';
import type {
  FileContext,
  Finding,
  Notice,
  Rule,
  RuleContext,
  RuleRunResult,
  Severity,
} from './types.js';

export type * from './types.js';

/** Every implemented rule, in rule ID order. */
export const RULES: readonly Rule[] = [
  GL000,
  GL001,
  GL002,
  GL003,
  GL004,
  GL005,
  GL006,
  GL007,
  GL008,
  GL009,
  PARSE001,
  PARSE002,
];

const REPO = 'https://github.com/guptaaman678/supabase-grants-lint';

/** The rule's documentation, pinned to the release tag (§6.3). */
export function docsUrl(id: RuleId, release: string = version): string {
  return `${REPO}/blob/v${release}/docs/rules/${id}.md`;
}

/** How findings name a grantee: the role name, or `PUBLIC`. */
export function granteeLabel(grantee: Grantee): string {
  return grantee === PUBLIC ? 'PUBLIC' : grantee;
}

/**
 * Whether a relation name from config (`serviceOnly`, `ignore[].relation`) means `name`: either
 * `schema.relation`, or a bare relation name, which matches it in any schema.
 */
export function matchesRelation(pattern: string, name: RelationName): boolean {
  return pattern.includes('.') ? pattern === qualified(name) : pattern === name.name;
}

/**
 * Whether a file from config (`ignore[].file`) means the migration at `file` (a path relative to
 * the working directory): the same path, or its trailing segments (`20261001_todos.sql`).
 */
export function matchesFile(pattern: string, file: string): boolean {
  const normal = pattern.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
  return file === normal || file.endsWith(`/${normal}`);
}

export function createContext(
  config: Config,
  replay: WindowedReplay,
  discovery: readonly DiscoveryNotice[] = [],
  live?: LiveSnapshot,
): RuleContext {
  const files = Object.freeze(
    replay.files.map((file): FileContext =>
      Object.freeze({ ...file, enforced: replay.isEnforced(file) }),
    ),
  );
  return Object.freeze({
    config,
    replay,
    files,
    enforced: Object.freeze(files.filter((file) => file.enforced)),
    discovery: Object.freeze([...discovery]),
    ...(live === undefined ? {} : { live }),
    inScope: (name: RelationName) => replay.inScope(name),
    isClientRole: (role: Grantee) => typeof role === 'string' && config.clientRoles.includes(role),
    isServiceOnly: (name: RelationName) =>
      config.serviceOnly.some((pattern) => matchesRelation(pattern, name)),
  });
}

export interface RunRulesOptions {
  readonly config: Config;
  readonly replay: WindowedReplay;
  /** Inline suppressions of every replayed file. */
  readonly suppressions?: readonly Suppression[];
  /** Malformed suppression comments: any of them is a usage error (exit 2). */
  readonly suppressionProblems?: readonly SuppressionProblem[];
  /** Discovery's notices about files without a version prefix; PARSE001 reports them. */
  readonly discovery?: readonly DiscoveryNotice[];
  /** `--strict-parse`: PARSE001 runs as an error, whatever config `rules` says. */
  readonly strictParse?: boolean;
  /** Defaults to `RULES`. */
  readonly rules?: readonly Rule[];
  /** Live mode: the database to compare the migrations with (GL009). */
  readonly live?: LiveSnapshot;
}

/** A finding before suppression, keeping the resolved relation for matching. */
interface Candidate {
  readonly finding: Finding;
  readonly relation: RelationName | undefined;
}

/**
 * Runs the rules. Throws a `UsageError` (exit 2) for a malformed suppression comment and a
 * `ConfigError` for an `ignore` entry without a reason (the config loader rejects those first;
 * this guards the programmatic API).
 */
export function runRules(options: RunRulesOptions): RuleRunResult {
  const {
    config,
    replay,
    suppressions = [],
    suppressionProblems = [],
    discovery = [],
    strictParse = false,
    rules = RULES,
    live,
  } = options;
  if (suppressionProblems.length > 0) throw suppressionError(suppressionProblems);
  const reasonless = config.ignore.flatMap((entry, i) =>
    entry.reason.trim() === ''
      ? [
          {
            key: `ignore[${String(i)}].reason`,
            message: 'is required: every suppression must give a non-empty reason',
          },
        ]
      : [],
  );
  if (reasonless.length > 0) throw new ConfigError('options.config', reasonless);

  const ctx = createContext(config, replay, discovery, live);
  const ran = new Set<RuleId>();
  let candidates: Candidate[] = [];
  for (const rule of rules) {
    const setting = strictParse && rule.id === 'PARSE001' ? 'error' : config.rules[rule.id];
    if (setting === 'off') continue;
    ran.add(rule.id);
    for (const found of rule.check(ctx)) {
      const severity: Severity = setting ?? found.severity ?? rule.defaultSeverity;
      candidates.push({
        relation: found.relation,
        finding: {
          ruleId: rule.id,
          severity,
          message: found.message,
          file: found.at.file,
          line: found.at.line,
          column: found.at.column,
          ...(found.relation === undefined ? {} : { relation: qualified(found.relation) }),
          ...(found.role === undefined ? {} : { role: granteeLabel(found.role) }),
          ...(found.privilege === undefined ? {} : { privilege: found.privilege }),
          ...(found.fix === undefined ? {} : { fix: found.fix }),
          docsUrl: docsUrl(rule.id),
        },
      });
    }
  }

  candidates = preferGL002(candidates);

  const ignoreUsed = config.ignore.map(() => false);
  const inlineUsed = new Map<Suppression, Set<RuleId>>(suppressions.map((s) => [s, new Set()]));
  const findings: Finding[] = [];
  for (const { finding, relation } of candidates) {
    let suppressed = false;
    config.ignore.forEach((entry, i) => {
      if (
        entry.rule === finding.ruleId &&
        (entry.relation === undefined ||
          (relation !== undefined && matchesRelation(entry.relation, relation))) &&
        (entry.file === undefined || matchesFile(entry.file, finding.file))
      ) {
        ignoreUsed[i] = true;
        suppressed = true;
      }
    });
    for (const suppression of suppressions) {
      if (
        suppression.file === finding.file &&
        suppression.targetLine === finding.line &&
        suppression.rules.includes(finding.ruleId)
      ) {
        inlineUsed.get(suppression)?.add(finding.ruleId);
        suppressed = true;
      }
    }
    if (!suppressed) findings.push(finding);
  }

  const order = new Map(replay.files.map((file) => [file.file, file.index]));
  const notices: Notice[] = [];
  config.ignore.forEach((entry, i) => {
    if (ignoreUsed[i] === true || !ran.has(entry.rule)) return;
    const scope = [entry.relation, entry.file].filter((part) => part !== undefined).join(', ');
    notices.push({
      code: 'unused-ignore',
      message: `Unused ignore entry ignore[${String(i)}] (${entry.rule}${scope === '' ? '' : `, ${scope}`}): it matched no finding. Remove it.`,
    });
  });
  const inline: (Notice & Located)[] = [];
  for (const [suppression, used] of inlineUsed) {
    for (const rule of suppression.rules) {
      if (used.has(rule) || !ran.has(rule)) continue;
      inline.push({
        code: 'unused-suppression',
        message: `Unused suppression: no ${rule} finding on line ${String(suppression.targetLine)}. Remove it.`,
        file: suppression.file,
        line: suppression.line,
        column: suppression.column,
      });
    }
  }
  inline.sort(byLocation(order));
  notices.push(...inline);

  findings.sort(compareFindings(order));
  return { findings, notices };
}

/**
 * Notices the replay itself produces, in replay order: the platform revoke assumed before the
 * first enforced file (ADR-002 item 1), and privileges not valid for the object they were granted
 * on, which the replay did not record. Kept apart from `runRules` so that rule fixtures only see
 * their rule's notices.
 */
export function replayNotices(replay: WindowedReplay): Notice[] {
  return replay.files.flatMap((file) =>
    file.events.flatMap((event): Notice[] => {
      if (event.kind === 'platformRevoke') {
        return [
          {
            code: 'platform-revoke',
            message: platformRevokeMessage(event, String(replay.since.value)),
            ...locate(event.at),
          },
        ];
      }
      if (event.kind === 'skipped' && event.reason === 'invalid-privilege') {
        return [{ code: 'invalid-privilege', message: `${event.message}.`, ...locate(event.at) }];
      }
      return [];
    }),
  );
}

function platformRevokeMessage(event: PlatformRevokeEvent, since: string): string {
  const removed = (['table', 'sequence'] as const).flatMap((object) => {
    const privileges = new Set(
      event.removed.filter((r) => r.object === object).flatMap((r) => r.privileges),
    );
    return privileges.size === 0 ? [] : [`${[...privileges].join(', ')} on new ${object}s`];
  });
  const grantees = [...new Set(event.removed.map((r) => r.grantee))];
  return (
    `Assumed the platform revoke before this file (since ${since}): removed the default ` +
    `${removed.join(' and ')} that ${event.creator} gave ${grantees.join(', ')} in schema ` +
    `${event.schema}, as opting in from the dashboard or the 2026-10-30 change does. Set ` +
    'platformRevokeAtSince to false if this project still grants them automatically.'
  );
}

/** When GL002 fires for (relation, role) in a file, GL003 findings for the same are dropped. */
function preferGL002(candidates: Candidate[]): Candidate[] {
  const key = (f: Finding): string => JSON.stringify([f.file, f.relation, f.role]);
  const unreachable = new Set(
    candidates.filter((c) => c.finding.ruleId === 'GL002').map((c) => key(c.finding)),
  );
  return candidates.filter(
    (c) =>
      c.finding.ruleId !== 'GL003' ||
      c.finding.relation === undefined ||
      c.finding.role === undefined ||
      !unreachable.has(key(c.finding)),
  );
}

interface Located {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** Files in replay order (unknown files after, by path), then line, then column. */
function byLocation(order: ReadonlyMap<string, number>): (a: Located, b: Located) => number {
  const rank = (file: string): number => order.get(file) ?? Number.MAX_SAFE_INTEGER;
  return (a, b) =>
    rank(a.file) - rank(b.file) ||
    compareStrings(a.file, b.file) ||
    a.line - b.line ||
    a.column - b.column;
}

/** By file, line, column and rule; the remaining fields only make the order total. */
export function compareFindings(
  order: ReadonlyMap<string, number>,
): (a: Finding, b: Finding) => number {
  const location = byLocation(order);
  return (a, b) =>
    location(a, b) ||
    RULE_IDS.indexOf(a.ruleId) - RULE_IDS.indexOf(b.ruleId) ||
    compareStrings(a.relation, b.relation) ||
    compareStrings(a.role, b.role) ||
    compareStrings(a.privilege, b.privilege) ||
    compareStrings(a.message, b.message);
}

/** Code-unit order; a missing value sorts first. */
function compareStrings(a: string | undefined, b: string | undefined): number {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}
