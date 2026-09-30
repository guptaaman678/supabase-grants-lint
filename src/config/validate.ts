import { ConfigError, type ConfigIssue } from '../errors.js';
import { extractVersion } from '../load/discover.js';
import {
  type Config,
  type ConfigKey,
  DEFAULT_CONFIG,
  type IgnoreEntry,
  PLATFORM_DEFAULTS,
  RULE_IDS,
  RULE_SETTINGS,
  type RuleId,
  type RuleSetting,
} from './defaults.js';

export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as ConfigKey[];
/** Keys allowed at the top level; `$schema` (editor support) is last so ties suggest a real key. */
const TOP_LEVEL_KEYS = [...CONFIG_KEYS, '$schema'];
const IGNORE_KEYS = ['rule', 'relation', 'file', 'reason'];
const VERSION = /^[0-9]+$/;
const MIN_POSTGRES_MAJOR = 10;

/** Returned by a check that recorded an issue. */
const INVALID = Symbol('invalid');
type Checked<T> = T | typeof INVALID;

/** Optimal string alignment distance: edits plus adjacent transpositions, case-insensitive. */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const width = t.length + 1;
  const d: number[] = [];
  const at = (i: number, j: number): number => d[i * width + j] ?? 0;
  for (let i = 0; i <= s.length; i++) {
    for (let j = 0; j <= t.length; j++) {
      let best: number;
      if (i === 0 || j === 0) {
        best = i + j;
      } else {
        const cost = s[i - 1] === t[j - 1] ? 0 : 1;
        best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
        if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
          best = Math.min(best, at(i - 2, j - 2) + 1);
        }
      }
      d[i * width + j] = best;
    }
  }
  return at(s.length, t.length);
}

function isAbbreviation(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.toLowerCase().startsWith(short.toLowerCase());
}

/**
 * The closest candidate to `input`, if it is close enough to be a likely typo. One word
 * starting with the other (`warning` and `warn`) counts as a distance of 1.
 */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const edits = editDistance(input, candidate);
    const distance = isAbbreviation(input, candidate) ? Math.min(edits, 1) : edits;
    const limit = candidate.length <= 3 ? 1 : Math.max(2, Math.floor(candidate.length / 3));
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function didYouMean(input: string, candidates: readonly string[]): string {
  const match = suggest(input, candidates);
  return match === undefined ? '' : ` Did you mean "${match}"?`;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `the number ${String(value)}`;
  if (typeof value === 'boolean') return `boolean ${String(value)}`;
  return `an ${typeof value}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quoteList(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(', ');
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

class Collector {
  readonly issues: ConfigIssue[] = [];

  fail(key: string, message: string): typeof INVALID {
    this.issues.push({ key, message });
    return INVALID;
  }

  nonEmptyString(key: string, value: unknown): Checked<string> {
    if (typeof value === 'string' && value.trim() !== '') return value;
    return this.fail(key, `must be a non-empty string, got ${describe(value)}`);
  }

  stringList(key: string, value: unknown, minItems: number): Checked<string[]> {
    if (!Array.isArray(value)) {
      return this.fail(key, `must be an array of strings, got ${describe(value)}`);
    }
    if (value.length < minItems) {
      return this.fail(key, `must list at least ${String(minItems)} entry`);
    }
    const items = value.map((item: unknown, i) =>
      this.nonEmptyString(`${key}[${String(i)}]`, item),
    );
    return items.every((item) => item !== INVALID) ? items : INVALID;
  }

  oneOf<T extends string>(key: string, value: unknown, allowed: readonly T[]): Checked<T> {
    if (isOneOf(value, allowed)) return value;
    const hint = typeof value === 'string' ? didYouMean(value, allowed) : '';
    return this.fail(key, `must be one of ${quoteList(allowed)}, got ${describe(value)}.${hint}`);
  }

  ruleId(key: string, value: unknown): Checked<RuleId> {
    if (isOneOf(value, RULE_IDS)) return value;
    const hint = typeof value === 'string' ? didYouMean(value, RULE_IDS) : '';
    return this.fail(
      key,
      `must be a rule ID (GL000 to GL008, PARSE001, PARSE002), got ${describe(value)}.${hint}`,
    );
  }
}

function validateSince(c: Collector, value: unknown): Checked<string> {
  if (value === 'auto' || value === 'none') return value;
  if (typeof value === 'string' && VERSION.test(value)) return value;
  let hint = '';
  if (typeof value === 'string') {
    const version = extractVersion(value);
    hint = version === null ? didYouMean(value, ['auto', 'none']) : ` Did you mean "${version}"?`;
  }
  return c.fail(
    'since',
    `must be "auto", "none" or a migration version (the digits before the first "_" of a ` +
      `file name, e.g. "20261001090000"), got ${describe(value)}.${hint}`,
  );
}

function validateRules(c: Collector, value: unknown): Checked<Config['rules']> {
  if (!isPlainObject(value)) {
    return c.fail(
      'rules',
      `must be an object mapping rule IDs to "off", "warn" or "error", got ${describe(value)}`,
    );
  }
  const rules: Partial<Record<RuleId, RuleSetting>> = {};
  let ok = true;
  for (const [id, setting] of Object.entries(value)) {
    const key = `rules.${id}`;
    const ruleId = isOneOf(id, RULE_IDS)
      ? id
      : c.fail(key, `is not a known rule ID.${didYouMean(id, RULE_IDS)}`);
    const parsed = c.oneOf(key, setting, RULE_SETTINGS);
    if (ruleId === INVALID || parsed === INVALID) ok = false;
    else rules[ruleId] = parsed;
  }
  return ok ? rules : INVALID;
}

function validateIgnoreEntry(c: Collector, key: string, value: unknown): Checked<IgnoreEntry> {
  if (!isPlainObject(value)) {
    return c.fail(
      key,
      `must be an object like {"rule": "GL005", "reason": "..."}, got ${describe(value)}`,
    );
  }
  const before = c.issues.length;
  for (const k of Object.keys(value)) {
    if (!IGNORE_KEYS.includes(k)) {
      c.fail(
        `${key}.${k}`,
        `is not a known key.${didYouMean(k, IGNORE_KEYS)} Allowed: ${quoteList(IGNORE_KEYS)}`,
      );
    }
  }
  const rule =
    value.rule === undefined
      ? c.fail(`${key}.rule`, 'is required: name the rule to suppress, e.g. "GL005"')
      : c.ruleId(`${key}.rule`, value.rule);
  const reason =
    typeof value.reason === 'string' && value.reason.trim() !== ''
      ? value.reason
      : c.fail(`${key}.reason`, 'is required: every suppression must give a non-empty reason');
  const relation =
    value.relation === undefined ? undefined : c.nonEmptyString(`${key}.relation`, value.relation);
  const file = value.file === undefined ? undefined : c.nonEmptyString(`${key}.file`, value.file);
  if (c.issues.length !== before) return INVALID;
  return {
    rule: rule as RuleId,
    ...(relation === undefined ? {} : { relation: relation as string }),
    ...(file === undefined ? {} : { file: file as string }),
    reason: reason as string,
  };
}

function validateIgnore(c: Collector, value: unknown): Checked<IgnoreEntry[]> {
  if (!Array.isArray(value)) return c.fail('ignore', `must be an array, got ${describe(value)}`);
  const entries = value.map((entry: unknown, i) =>
    validateIgnoreEntry(c, `ignore[${String(i)}]`, entry),
  );
  return entries.every((entry) => entry !== INVALID) ? entries : INVALID;
}

function validateKey(c: Collector, key: ConfigKey, value: unknown): unknown {
  switch (key) {
    case 'migrations':
      if (typeof value === 'string') return c.nonEmptyString(key, value);
      if (Array.isArray(value)) return c.stringList(key, value, 1);
      return c.fail(key, `must be a path, a glob, or an array of them, got ${describe(value)}`);
    case 'schemaPaths':
      if (value === 'auto') return value;
      if (Array.isArray(value)) return c.stringList(key, value, 0);
      return c.fail(
        key,
        `must be "auto" or an array of paths and globs ([] to skip declarative schemas), ` +
          `got ${describe(value)}`,
      );
    case 'schemas':
      return c.stringList(key, value, 1);
    case 'clientRoles':
    case 'serviceOnly':
      return c.stringList(key, value, 0);
    case 'migrationRole':
    case 'serviceRole':
      return c.nonEmptyString(key, value);
    case 'since':
      return validateSince(c, value);
    case 'platformDefaults':
      return c.oneOf(key, value, PLATFORM_DEFAULTS);
    case 'platformRevokeAtSince':
      if (typeof value === 'boolean') return value;
      return c.fail(key, `must be true or false, got ${describe(value)}`);
    case 'postgresMajor':
      if (typeof value === 'number' && Number.isInteger(value) && value >= MIN_POSTGRES_MAJOR) {
        return value;
      }
      return c.fail(
        key,
        `must be a whole number of at least ${String(MIN_POSTGRES_MAJOR)} (e.g. 15 or 17), ` +
          `got ${describe(value)}`,
      );
    case 'rules':
      return validateRules(c, value);
    case 'ignore':
      return validateIgnore(c, value);
  }
}

/**
 * Checks a raw config object (parsed JSON, or CLI overrides) and returns the keys it sets.
 * Collects every problem and throws one `ConfigError` (exit 2) naming `source` and each key.
 */
export function validateConfig(raw: unknown, source: string): Partial<Config> {
  if (!isPlainObject(raw)) {
    throw new ConfigError(source, [
      { key: '', message: `the config must be a JSON object, got ${describe(raw)}` },
    ]);
  }
  const c = new Collector();
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    // An unset CLI flag arrives as `undefined`; JSON cannot express it.
    if (value === undefined) continue;
    if (key === '$schema') {
      if (typeof value !== 'string') c.fail(key, `must be a string, got ${describe(value)}`);
    } else if (isOneOf(key, CONFIG_KEYS)) {
      const parsed = validateKey(c, key, value);
      if (parsed !== INVALID) result[key] = parsed;
    } else {
      c.fail(key, `is not a known key.${didYouMean(key, TOP_LEVEL_KEYS)}`);
    }
  }
  if (c.issues.length > 0) throw new ConfigError(source, c.issues);
  return result;
}
