import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import {
  type Config,
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  PLATFORM_DEFAULTS,
  AUTO_RLS_MODES,
  RULE_IDS,
  RULE_SETTINGS,
} from '../../src/config/defaults.js';
import { COMMAND_LINE_SOURCE, loadConfig } from '../../src/config/load.js';
import { CONFIG_KEYS, editDistance, suggest, validateConfig } from '../../src/config/validate.js';
import { ConfigError, UsageError } from '../../src/errors.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'grants-lint-config-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, content: unknown): void {
  const abs = path.join(root, ...relPath.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function load(options: Parameters<typeof loadConfig>[0] = {}) {
  return loadConfig({ cwd: root, ...options });
}

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected a ConfigError');
}

/** Error from `grants-lint.config.json` containing `raw`. */
function fileError(raw: unknown): ConfigError {
  write(CONFIG_FILE_NAME, raw);
  return configError(() => load());
}

const FULL: Config = {
  migrations: ['db/migrations', 'extra/*.sql'],
  schemaPaths: ['db/schemas', 'db/views/*.sql'],
  schemas: ['public', 'api'],
  since: '20261001090000',
  platformDefaults: 'explicit',
  platformRevokeAtSince: false,
  autoRls: 'off',
  platformPublications: [],
  migrationRole: 'supabase_admin',
  clientRoles: ['anon', 'authenticated', 'app_user'],
  serviceRole: 'service_role',
  serviceOnly: ['public.audit_log'],
  postgresMajor: 17,
  rules: { GL005: 'off', GL008: 'error', PARSE001: 'warn' },
  ignore: [
    {
      rule: 'GL003',
      relation: 'public.messages',
      file: 'supabase/migrations/1_a.sql',
      reason: 'legacy',
    },
    { rule: 'GL008', reason: 'reviewed' },
  ],
};

describe('loadConfig: sources and precedence', () => {
  it('returns the defaults when there is no config anywhere', () => {
    expect(load()).toEqual({ config: DEFAULT_CONFIG, sources: [] });
  });

  it('ignores a package.json without a grantsLint key', () => {
    write('package.json', { name: 'app', version: '1.0.0' });
    expect(load()).toEqual({ config: DEFAULT_CONFIG, sources: [] });
  });

  it('reads package.json#grantsLint', () => {
    write('package.json', { name: 'app', grantsLint: { since: 'none' } });
    const { config, sources } = load();
    expect(config.since).toBe('none');
    expect(sources).toEqual(['package.json#grantsLint']);
  });

  it('applies defaults < package.json < grants-lint.config.json < --config < CLI flags', () => {
    write('package.json', {
      grantsLint: {
        since: '1',
        schemas: ['a'],
        migrationRole: 'r1',
        postgresMajor: 16,
        serviceRole: 's1',
      },
    });
    write(CONFIG_FILE_NAME, { since: '2', schemas: ['b'], migrationRole: 'r2', postgresMajor: 17 });
    write('conf/custom.json', { since: '3', schemas: ['c'] });
    const { config, sources } = load({
      configFile: 'conf/custom.json',
      overrides: { since: '4' },
    });
    expect(config).toEqual({
      ...DEFAULT_CONFIG,
      since: '4',
      schemas: ['c'],
      migrationRole: 'r2',
      postgresMajor: 17,
      serviceRole: 's1',
    });
    expect(sources).toEqual([
      'package.json#grantsLint',
      CONFIG_FILE_NAME,
      'conf/custom.json',
      COMMAND_LINE_SOURCE,
    ]);
  });

  it('replaces whole top-level keys rather than merging rules across sources', () => {
    write('package.json', { grantsLint: { rules: { GL005: 'off' } } });
    write(CONFIG_FILE_NAME, { rules: { GL008: 'error' } });
    expect(load().config.rules).toEqual({ GL008: 'error' });
  });

  it('reads config files from --dir, and resolves --config against the working directory', () => {
    write('app/grants-lint.config.json', { since: 'none' });
    write('elsewhere.json', { schemas: ['api'] });
    const { config, sources } = load({ projectDir: 'app', configFile: 'elsewhere.json' });
    expect(config.since).toBe('none');
    expect(config.schemas).toEqual(['api']);
    expect(sources).toEqual(['app/grants-lint.config.json', 'elsewhere.json']);
  });

  it('reads the default file once when --config names it', () => {
    write(CONFIG_FILE_NAME, { since: 'none' });
    expect(load({ configFile: CONFIG_FILE_NAME }).sources).toEqual([CONFIG_FILE_NAME]);
  });

  it('does not record an empty set of CLI overrides as a source', () => {
    expect(load({ overrides: {} }).sources).toEqual([]);
  });

  it('treats a CLI override of undefined as unset', () => {
    write(CONFIG_FILE_NAME, { since: 'none' });
    const { config, sources } = load({ overrides: { since: undefined, schemas: undefined } });
    expect(config.since).toBe('none');
    expect(config.schemas).toEqual(['public']);
    expect(sources).toEqual([CONFIG_FILE_NAME]);
  });

  it('accepts a byte order mark and a $schema key', () => {
    const bom = String.fromCharCode(0xfeff);
    write(CONFIG_FILE_NAME, bom + JSON.stringify({ $schema: './schema.json', since: 'none' }));
    expect(load().config.since).toBe('none');
  });

  it('exits 2 when --config points at a missing file, naming it', () => {
    const error = configError(() => load({ configFile: 'nope/missing.json' }));
    expect(error.exitCode).toBe(ExitCode.Usage);
    expect(error.message).toBe(
      'Invalid config in nope/missing.json: file not found (from --config)',
    );
  });

  it('exits 2 when --config points at a directory', () => {
    mkdirSync(path.join(root, 'dir.json'));
    expect(configError(() => load({ configFile: 'dir.json' })).message).toContain('dir.json');
  });

  it('exits 2 on invalid JSON, naming the file', () => {
    const error = fileError('{ "since": "none", }');
    expect(error.exitCode).toBe(ExitCode.Usage);
    expect(error.message).toMatch(/^Invalid config in grants-lint\.config\.json: not valid JSON: /);
  });

  it('exits 2 on an invalid package.json, naming it', () => {
    write('package.json', '{ nope');
    expect(configError(() => load()).message).toMatch(
      /^Invalid config in package\.json: not valid JSON/,
    );
  });

  it('names package.json#grantsLint for an invalid value there', () => {
    write('package.json', { grantsLint: { since: 'later' } });
    expect(configError(() => load()).message).toMatch(
      /^Invalid config in package\.json#grantsLint: "since"/,
    );
  });

  it('names the command line for an invalid flag value', () => {
    const error = configError(() => load({ overrides: { since: 'soon' } }));
    expect(error.source).toBe(COMMAND_LINE_SOURCE);
    expect(error.message).toMatch(/^Invalid config in command line: "since" must be/);
  });

  it('reports paths relative to the working directory with / separators', () => {
    write('a/b/grants-lint.config.json', { sinse: 'none' });
    expect(configError(() => load({ projectDir: 'a/b' })).source).toBe(
      'a/b/grants-lint.config.json',
    );
  });

  it('is a UsageError, so the CLI exits 2', () => {
    expect(fileError({ since: 1 })).toBeInstanceOf(UsageError);
  });
});

describe('round trip', () => {
  it('loads a config that sets every key to a non-default value unchanged', () => {
    write(CONFIG_FILE_NAME, FULL);
    expect(load().config).toEqual(FULL);
  });

  it('re-loads its own serialised output unchanged', () => {
    write(CONFIG_FILE_NAME, FULL);
    const first = load().config;
    write('again.json', JSON.stringify(first));
    expect(load({ configFile: 'again.json' }).config).toEqual(first);
  });

  it('re-loads the serialised defaults unchanged', () => {
    write(CONFIG_FILE_NAME, DEFAULT_CONFIG);
    expect(load().config).toEqual(DEFAULT_CONFIG);
  });

  it('sets every config key in the full example', () => {
    expect(Object.keys(FULL).sort()).toEqual([...CONFIG_KEYS].sort());
  });
});

describe('validateConfig: valid values for each key', () => {
  it.each<[string, unknown]>([
    ['migrations', 'supabase/migrations'],
    ['migrations', 'db/**/*.sql'],
    ['migrations', ['a', 'b/*.sql']],
    ['schemas', ['public']],
    ['schemas', ['public', 'api']],
    ['since', 'auto'],
    ['since', 'none'],
    ['since', '20261001090000'],
    ['since', '1'],
    ['platformDefaults', 'legacy'],
    ['platformDefaults', 'explicit'],
    ['platformRevokeAtSince', true],
    ['platformRevokeAtSince', false],
    ['autoRls', 'auto'],
    ['autoRls', 'on'],
    ['autoRls', 'off'],
    ['platformPublications', []],
    ['platformPublications', ['supabase_realtime', 'audit']],
    ['migrationRole', 'postgres'],
    ['clientRoles', []],
    ['clientRoles', ['anon', 'authenticated', 'app_user']],
    ['serviceRole', 'service_role'],
    ['serviceOnly', []],
    ['serviceOnly', ['public.audit_log', 'orders']],
    ['postgresMajor', 15],
    ['postgresMajor', 17],
    ['postgresMajor', 10],
    ['rules', {}],
    ['rules', { GL000: 'off', GL001: 'warn', PARSE002: 'error' }],
    ['ignore', []],
    ['ignore', [{ rule: 'GL005', reason: 'intentional' }]],
    ['ignore', [{ rule: 'GL002', relation: 'public.todos', file: 'x.sql', reason: 'r' }]],
  ])('%s = %j', (key, value) => {
    expect(validateConfig({ [key]: value }, 'c.json')).toEqual({ [key]: value });
  });

  it('accepts every rule ID and setting', () => {
    for (const id of RULE_IDS) {
      for (const setting of RULE_SETTINGS) {
        expect(validateConfig({ rules: { [id]: setting } }, 'c.json')).toEqual({
          rules: { [id]: setting },
        });
      }
    }
  });

  it('returns only the keys that are set', () => {
    expect(validateConfig({ since: 'none', $schema: 'x' }, 'c.json')).toEqual({ since: 'none' });
  });
});

describe('validateConfig: errors name the file and the key', () => {
  it.each<[string, unknown, string, RegExp]>([
    ['migrations', '', 'migrations', /must be a non-empty string/],
    ['migrations', '   ', 'migrations', /must be a non-empty string/],
    [
      'migrations',
      5,
      'migrations',
      /must be a path, a glob, or an array of them, got the number 5/,
    ],
    ['migrations', [], 'migrations', /at least 1 entry/],
    ['migrations', ['ok', ''], 'migrations[1]', /non-empty string/],
    ['schemas', 'public', 'schemas', /must be an array of strings, got the string "public"/],
    ['schemas', [], 'schemas', /at least 1 entry/],
    ['schemas', ['public', 3], 'schemas[1]', /got the number 3/],
    ['since', 'later', 'since', /must be "auto", "none" or a migration version/],
    ['since', 20261001090000, 'since', /got the number 20261001090000/],
    ['since', '', 'since', /migration version/],
    ['since', '12a', 'since', /migration version/],
    [
      'platformDefaults',
      'modern',
      'platformDefaults',
      /must be one of "legacy", "explicit", got the string "modern"/,
    ],
    ['platformDefaults', null, 'platformDefaults', /got null/],
    [
      'platformRevokeAtSince',
      'true',
      'platformRevokeAtSince',
      /must be true or false, got the string "true"/,
    ],
    ['autoRls', true, 'autoRls', /must be one of "auto", "on", "off", got boolean true/],
    ['platformPublications', 'supabase_realtime', 'platformPublications', /array of strings/],
    ['migrationRole', '', 'migrationRole', /non-empty string/],
    ['migrationRole', ['postgres'], 'migrationRole', /got an array/],
    ['clientRoles', 'anon', 'clientRoles', /array of strings/],
    ['clientRoles', [''], 'clientRoles[0]', /non-empty string/],
    ['serviceRole', false, 'serviceRole', /got boolean false/],
    ['serviceOnly', {}, 'serviceOnly', /got an object/],
    ['postgresMajor', '15', 'postgresMajor', /whole number of at least 10/],
    ['postgresMajor', 15.5, 'postgresMajor', /whole number/],
    ['postgresMajor', 9, 'postgresMajor', /at least 10/],
    ['rules', [], 'rules', /must be an object mapping rule IDs/],
    [
      'rules',
      { GL001: 'on' },
      'rules.GL001',
      /must be one of "off", "warn", "error", got the string "on"/,
    ],
    ['rules', { GL001: 2 }, 'rules.GL001', /got the number 2/],
    ['rules', { GL999: 'off' }, 'rules.GL999', /is not a known rule ID/],
    ['ignore', {}, 'ignore', /must be an array, got an object/],
    ['ignore', ['GL005'], 'ignore[0]', /must be an object like/],
    [
      'ignore',
      [{ rule: 'GL005' }],
      'ignore[0].reason',
      /is required: every suppression must give a non-empty reason/,
    ],
    ['ignore', [{ rule: 'GL005', reason: '' }], 'ignore[0].reason', /non-empty reason/],
    ['ignore', [{ rule: 'GL005', reason: '  ' }], 'ignore[0].reason', /non-empty reason/],
    ['ignore', [{ rule: 'GL005', reason: 7 }], 'ignore[0].reason', /non-empty reason/],
    ['ignore', [{ reason: 'x' }], 'ignore[0].rule', /is required: name the rule to suppress/],
    [
      'ignore',
      [{ rule: 5, reason: 'x' }],
      'ignore[0].rule',
      /must be a rule ID .*, got the number 5/,
    ],
    ['ignore', [{ rule: 'GL099', reason: 'x' }], 'ignore[0].rule', /must be a rule ID/],
    [
      'ignore',
      [{ rule: 'GL005', reason: 'x', relation: '' }],
      'ignore[0].relation',
      /non-empty string/,
    ],
    ['ignore', [{ rule: 'GL005', reason: 'x', file: 3 }], 'ignore[0].file', /non-empty string/],
    ['ignore', [{ rule: 'GL005', reason: 'x', note: 'y' }], 'ignore[0].note', /is not a known key/],
  ])('%s = %j -> "%s"', (key, value, issueKey, pattern) => {
    const error = fileError({ [key]: value });
    expect(error.exitCode).toBe(ExitCode.Usage);
    expect(error.source).toBe(CONFIG_FILE_NAME);
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.key).toBe(issueKey);
    expect(error.issues[0]?.message).toMatch(pattern);
    expect(error.message).toContain(`Invalid config in ${CONFIG_FILE_NAME}: "${issueKey}" `);
  });

  it.each<[unknown, string]>([
    [[], 'an array'],
    [null, 'null'],
    ['since', 'the string "since"'],
    [3, 'the number 3'],
  ])('rejects a top level of %j', (raw, described) => {
    const error = fileError(JSON.stringify(raw));
    expect(error.message).toBe(
      `Invalid config in ${CONFIG_FILE_NAME}: the config must be a JSON object, got ${described}`,
    );
  });

  it('rejects a non-string $schema', () => {
    expect(fileError({ $schema: 1 }).issues).toEqual([
      { key: '$schema', message: 'must be a string, got the number 1' },
    ]);
  });

  it('rejects a non-object grantsLint section in package.json', () => {
    write('package.json', { grantsLint: 'on' });
    expect(configError(() => load()).message).toContain('package.json#grantsLint');
  });

  it('lists every problem, one per line, when there are several', () => {
    const error = fileError({ sinse: 'none', schemas: [], ignore: [{ rule: 'GL005' }] });
    expect(error.issues.map((i) => i.key)).toEqual(['sinse', 'schemas', 'ignore[0].reason']);
    expect(error.message.split('\n')).toEqual([
      `Invalid config in ${CONFIG_FILE_NAME}:`,
      '  - "sinse" is not a known key. Did you mean "since"?',
      '  - "schemas" must list at least 1 entry',
      '  - "ignore[0].reason" is required: every suppression must give a non-empty reason',
    ]);
  });
});

describe('did you mean', () => {
  it.each<[string, string]>([
    ['sinec', 'since'],
    ['sinse', 'since'],
    ['Since', 'since'],
    ['schema', 'schemas'],
    ['migration', 'migrations'],
    ['platformDefault', 'platformDefaults'],
    ['clientRole', 'clientRoles'],
    ['servicerole', 'serviceRole'],
    ['postgresMajr', 'postgresMajor'],
    ['postgres', 'postgresMajor'],
    ['ignores', 'ignore'],
    ['rule', 'rules'],
    ['$shema', '$schema'],
  ])('unknown key %s suggests %s', (key, expected) => {
    expect(fileError({ [key]: 1 }).issues).toEqual([
      { key, message: `is not a known key. Did you mean "${expected}"?` },
    ]);
  });

  it('gives no suggestion for an unrelated key', () => {
    expect(fileError({ colour: true }).issues).toEqual([
      { key: 'colour', message: 'is not a known key.' },
    ]);
  });

  it.each<[string, string]>([
    ['GL01', 'GL001'],
    ['gl005', 'GL005'],
    ['PARSE01', 'PARSE001'],
  ])('unknown rule ID %s suggests %s', (id, expected) => {
    expect(fileError({ rules: { [id]: 'off' } }).issues[0]?.message).toBe(
      `is not a known rule ID. Did you mean "${expected}"?`,
    );
    expect(fileError({ ignore: [{ rule: id, reason: 'x' }] }).issues[0]?.message).toContain(
      `Did you mean "${expected}"?`,
    );
  });

  it('suggests enum values', () => {
    expect(fileError({ platformDefaults: 'legasy' }).message).toContain('Did you mean "legacy"?');
    expect(fileError({ rules: { GL001: 'warning' } }).message).toContain('Did you mean "warn"?');
    expect(fileError({ rules: { GL001: 'of' } }).message).toContain('Did you mean "off"?');
  });

  it('does not suggest "off" for "on"', () => {
    expect(fileError({ rules: { GL001: 'on' } }).message).not.toContain('Did you mean');
  });

  it('suggests the version when since is a file name', () => {
    expect(fileError({ since: '20261001090000_opt_in.sql' }).message).toContain(
      'Did you mean "20261001090000"?',
    );
  });

  it('suggests auto or none for a near miss', () => {
    expect(fileError({ since: 'Auto' }).message).toContain('Did you mean "auto"?');
    expect(fileError({ since: 'non' }).message).toContain('Did you mean "none"?');
  });

  it('suggests ignore entry keys', () => {
    expect(
      fileError({ ignore: [{ rule: 'GL005', reason: 'x', relaton: 'public.todos' }] }).message,
    ).toContain(
      '"ignore[0].relaton" is not a known key. Did you mean "relation"? Allowed: "rule", "relation", "file", "reason"',
    );
  });

  it.each<[string, string, number]>([
    ['since', 'since', 0],
    ['since', 'SINCE', 0],
    ['sinec', 'since', 1],
    ['since', 'sinc', 1],
    ['since', 'sxnce', 1],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['kitten', 'sitting', 3],
  ])('editDistance(%j, %j) = %i', (a, b, expected) => {
    expect(editDistance(a, b)).toBe(expected);
  });

  it('picks the closest candidate and keeps the first on ties', () => {
    expect(suggest('abcd', ['abxx', 'abcx'])).toBe('abcx');
    expect(suggest('abcd', ['abcx', 'abcy'])).toBe('abcx');
    expect(suggest('zzzz', ['abcx'])).toBeUndefined();
  });
});

describe('schema/config.schema.json', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../../schema/config.schema.json', import.meta.url), 'utf8'),
  ) as {
    $id: string;
    $schema: string;
    description: string;
    additionalProperties: boolean;
    definitions: { ruleId: { enum: string[] }; ruleSetting: { enum: string[] } };
    properties: Record<string, { description?: string; default?: unknown; enum?: string[] }>;
  };

  it('has an $id and a draft', () => {
    expect(schema.$id).toBe(
      'https://raw.githubusercontent.com/guptaaman678/supabase-grants-lint/main/schema/config.schema.json',
    );
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.additionalProperties).toBe(false);
  });

  it('describes exactly the keys the validator accepts', () => {
    expect(Object.keys(schema.properties).sort()).toEqual(['$schema', ...CONFIG_KEYS].sort());
  });

  it('has a description on every property for editor hover', () => {
    for (const [key, property] of Object.entries(schema.properties)) {
      expect(property.description, key).toMatch(/\S/);
    }
  });

  it('documents the same defaults the loader uses', () => {
    for (const key of CONFIG_KEYS) {
      expect(schema.properties[key]?.default, key).toEqual(DEFAULT_CONFIG[key]);
    }
  });

  it('lists the same rule IDs, settings and platform defaults', () => {
    expect(schema.definitions.ruleId.enum).toEqual([...RULE_IDS]);
    expect(schema.definitions.ruleSetting.enum).toEqual([...RULE_SETTINGS]);
    expect(schema.properties.platformDefaults?.enum).toEqual([...PLATFORM_DEFAULTS]);
    expect(schema.properties.autoRls?.enum).toEqual([...AUTO_RLS_MODES]);
  });

  it('contains no em dash', () => {
    expect(JSON.stringify(schema)).not.toContain(String.fromCharCode(0x2014));
  });
});
