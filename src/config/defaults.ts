import { DEFAULT_MIGRATIONS } from '../load/discover.js';

/** Every rule ID the tool knows. IDs are never reused. */
export const RULE_IDS = [
  'GL000',
  'GL001',
  'GL002',
  'GL003',
  'GL004',
  'GL005',
  'GL006',
  'GL007',
  'GL008',
  'GL009',
  'PARSE001',
  'PARSE002',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export const RULE_SETTINGS = ['off', 'warn', 'error'] as const;
export type RuleSetting = (typeof RULE_SETTINGS)[number];

export const PLATFORM_DEFAULTS = ['legacy', 'explicit'] as const;
export type PlatformDefaults = (typeof PLATFORM_DEFAULTS)[number];

/**
 * Whether new tables in `public` start with row level security on, as Supabase's `ensure_rls`
 * event trigger makes them (engine only; grants-lint's rules do not read RLS state).
 */
export const AUTO_RLS_MODES = ['auto', 'on', 'off'] as const;
export type AutoRlsMode = (typeof AUTO_RLS_MODES)[number];

/** `"auto"`, `"none"`, or a migration version (the leading digits of a file name). */
export type Since = string;

export interface IgnoreEntry {
  readonly rule: RuleId;
  readonly relation?: string;
  readonly file?: string;
  readonly reason: string;
}

export interface Config {
  readonly migrations: string | readonly string[];
  /** Declarative schema files (ADR-017): `"auto"` follows the Supabase CLI; `[]` turns them off. */
  readonly schemaPaths: 'auto' | readonly string[];
  readonly schemas: readonly string[];
  readonly since: Since;
  readonly platformDefaults: PlatformDefaults;
  /** Apply the announced platform revoke before the first enforced file (ADR-002 item 1). */
  readonly platformRevokeAtSince: boolean;
  /** Automatic RLS from the `ensure_rls` trigger (engine only). */
  readonly autoRls: AutoRlsMode;
  /** Publications that exist, empty, before the first migration (engine only). */
  readonly platformPublications: readonly string[];
  readonly migrationRole: string;
  readonly clientRoles: readonly string[];
  readonly serviceRole: string;
  readonly serviceOnly: readonly string[];
  readonly postgresMajor: number;
  readonly rules: Readonly<Partial<Record<RuleId, RuleSetting>>>;
  readonly ignore: readonly IgnoreEntry[];
}

export type ConfigKey = keyof Config;

export const CONFIG_FILE_NAME = 'grants-lint.config.json';
export const PACKAGE_JSON_KEY = 'grantsLint';

export const DEFAULT_CONFIG: Config = {
  migrations: DEFAULT_MIGRATIONS,
  schemas: ['public'],
  schemaPaths: 'auto',
  since: 'auto',
  platformDefaults: 'legacy',
  platformRevokeAtSince: true,
  autoRls: 'auto',
  platformPublications: ['supabase_realtime'],
  migrationRole: 'postgres',
  clientRoles: ['anon', 'authenticated'],
  serviceRole: 'service_role',
  serviceOnly: [],
  postgresMajor: 15,
  rules: {},
  ignore: [],
};
