/**
 * The programmatic API (spec §6.5) and the pipeline behind `check`: config, discovery, parser,
 * replay with the enforcement window, rules. Reads files only; no network (G4).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config/defaults.js';
import { loadConfig } from './config/load.js';
import { validateConfig } from './config/validate.js';
import {
  type DeclarativeDiscovery,
  discoverSchemaFiles,
  type SchemaPathsSource,
} from './load/declarative.js';
import {
  DEFAULT_MIGRATIONS,
  discoverMigrations,
  type Discovery,
  type DiscoveryNotice,
  findProjectDir,
  isMigrationsFolder,
  toRelPath,
} from './load/discover.js';
import { autoExposeSetting } from './load/supabase-config.js';
import { loadParser, type MigrationParser, type ParsedFile } from './parse/adapter.js';
import type { ReplayInput } from './replay/engine.js';
import { replayWithWindow, type ResolvedSince, type WindowedReplay } from './replay/since.js';
import { type Finding, type Notice, replayNotices, runRules } from './rules/index.js';

export interface LintOptions {
  /** Directory relative paths (and finding paths) are resolved against. Default: `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Project directory (`--dir`): where the config and migrations are looked up. Default: `cwd`, or
   * the folder that contains `supabase/` when `cwd` is `supabase/` or `supabase/migrations`.
   */
  readonly dir?: string;
  /** Explicit config file (`--config`). */
  readonly configFile?: string;
  /** `--since`: a version, `"none"` or `"auto"`; takes precedence over config `since`. */
  readonly since?: string;
  /** `--schema`: replaces config `schemas`. */
  readonly schemas?: readonly string[];
  /** `--strict-parse`: PARSE001 findings are errors. */
  readonly strictParse?: boolean;
}

export interface LintSummary {
  readonly files: number;
  /** In-scope relations that exist after the last migration. */
  readonly relations: number;
  readonly errors: number;
  readonly warnings: number;
  /** Info-level findings plus notices. */
  readonly notices: number;
  readonly durationMs: number;
}

/**
 * Where the migrations were read from when no `--dir` was given and they were not the working
 * directory's `supabase/migrations`: the project root found above it, or the working directory
 * itself as a folder of migrations. `path` is relative to the working directory.
 */
export interface DetectedLocation {
  readonly kind: 'project root' | 'migrations folder';
  readonly path: string;
}

export interface LintResult {
  readonly config: Config;
  readonly location?: DetectedLocation;
  readonly since: ResolvedSince;
  readonly summary: LintSummary;
  readonly findings: readonly Finding[];
  readonly notices: readonly Notice[];
}

/** A project's config and parsed migrations, before any replay. */
export interface LoadedProject {
  /** The resolved working directory; reported paths are relative to it. */
  readonly cwd: string;
  /** The resolved `--dir`, or the detected project directory. */
  readonly projectDir: string;
  readonly location?: DetectedLocation;
  readonly config: Config;
  /** The validated `--since` flag, if given. */
  readonly cliSince: string | undefined;
  readonly discovery: readonly DiscoveryNotice[];
  /** One per migration file, in replay order. */
  readonly inputs: readonly ReplayInput[];
  readonly parsed: readonly ParsedFile[];
  /** The declarative schema files (ADR-017); `null` when the project has none. */
  readonly declarative: DeclarativeProject | null;
}

export interface DeclarativeProject {
  readonly source: SchemaPathsSource;
  /** The files, in the order the Supabase CLI applies them. */
  readonly files: readonly string[];
  /** Every file's statements, as one replay unit. */
  readonly input: ReplayInput;
  readonly parsed: readonly ParsedFile[];
}

/**
 * Whether the declarative schema files are checked (ADR-017): only once the project is opted in,
 * that is `since` resolved (an opt-in migration, config `since` or `--since`) or
 * `supabase/config.toml` sets `auto_expose_new_tables = false`. Before that the platform still
 * grants new tables automatically, and checking the files would fail CI nobody changed.
 */
export function isDeclarativeEnforced(since: ResolvedSince, projectDir: string): boolean {
  if (since.value !== null) return true;
  const toml = path.join(projectDir, 'supabase', 'config.toml');
  return existsSync(toml) && autoExposeSetting(readFileSync(toml, 'utf8')) === false;
}

/** The one notice for declarative schema files that were not checked. */
export function declarativeSkippedNotice(project: DeclarativeProject): Notice {
  const count = project.files.length;
  return {
    code: 'declarative-not-checked',
    message:
      `${String(count)} declarative schema file${count === 1 ? ' was' : 's were'} not checked: ` +
      'the project is not opted in to explicit grants yet (no opt-in migration or since ' +
      'setting, and auto_expose_new_tables is not false in supabase/config.toml). ' +
      `${count === 1 ? 'It is' : 'They are'} checked once it is.`,
    file: project.input.file,
    line: 1,
    column: 1,
  };
}

/**
 * How declarative schemas replay (ADR-017): as one unit, since the diff engine orders statements
 * by dependency rather than by file; from no default grants, because the state they describe
 * must carry its own grants once auto-grants are gone; every relation in them enforced.
 */
export function replayDeclarative(project: DeclarativeProject, config: Config): WindowedReplay {
  return replayWithWindow([project.input], {
    ...config,
    since: 'none',
    platformDefaults: 'explicit',
    platformRevokeAtSince: false,
  });
}

/** `loadProject`'s options, plus config values set by a caller (the engine export's `overrides`). */
export interface ProjectOptions extends LintOptions {
  /** Validated like a config file, above every config source; `schemas` wins over its key. */
  readonly overrides?: Readonly<Record<string, unknown>>;
}

/** The config and the migration files a project replays: everything before the parser. */
export interface ProjectFiles {
  readonly cwd: string;
  readonly projectDir: string;
  readonly config: Config;
  /** The config sources applied, lowest precedence first (`LoadedConfig.sources`). */
  readonly configSources: readonly string[];
  readonly cliSince: string | undefined;
  readonly schemaFiles: DeclarativeDiscovery;
  readonly migrations: Discovery;
}

/**
 * Resolves the project directory, loads the config and discovers the migrations and declarative
 * schema files, without reading them. Throws a `UsageError` for a bad config or path.
 */
export function resolveProjectFiles(options: ProjectOptions = {}): ProjectFiles {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectDir =
    options.dir === undefined ? findProjectDir(cwd) : path.resolve(cwd, options.dir);
  const cliSince =
    options.since === undefined
      ? undefined
      : (validateConfig({ since: options.since }, '--since').since as string);
  const overrides = {
    ...options.overrides,
    ...(options.schemas === undefined ? {} : { schemas: [...options.schemas] }),
  };
  const { config, sources } = loadConfig({
    cwd,
    projectDir,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
  });
  const schemaFiles = discoverSchemaFiles({ schemaPaths: config.schemaPaths, projectDir, cwd });
  const migrations = discoverMigrations({
    migrations: config.migrations,
    projectDir,
    cwd,
    allowMissingDefault: schemaFiles.files.length > 0,
  });
  return { cwd, projectDir, config, configSources: sources, cliSince, schemaFiles, migrations };
}

/**
 * Loads the config, discovers the migrations and parses them (`check` and `doctor`). Rejects with
 * a `UsageError` (exit 2) for a bad config or path.
 */
export async function loadProject(options: ProjectOptions = {}): Promise<LoadedProject> {
  const files = resolveProjectFiles(options);
  return parseProject(files, options, await loadParser());
}

/** `loadProject` once the parser is loaded: synchronous, the same steps in the same order. */
export function parseProject(
  project: ProjectFiles,
  options: LintOptions,
  parser: MigrationParser,
): LoadedProject {
  const { cwd, projectDir, config, cliSince, schemaFiles } = project;
  const { files, notices: discovery } = project.migrations;
  const parse = (file: { path: string; relPath: string }): ParsedFile =>
    parser.parse(readFileSync(file.path, 'utf8'), file.relPath);
  const parsed = files.map(parse);
  const inputs = files.map((file, i) => ({
    file: file.relPath,
    version: file.version,
    statements: parsed[i]?.statements ?? [],
  }));

  let declarative: DeclarativeProject | null = null;
  const [first] = schemaFiles.files;
  if (schemaFiles.source !== null && first !== undefined) {
    const declared = schemaFiles.files.map(parse);
    const sources = schemaFiles.files.map((file) => file.relPath);
    declarative = {
      source: schemaFiles.source,
      files: sources,
      parsed: declared,
      input: {
        file: first.relPath,
        version: null,
        sources,
        statements: declared.flatMap((p) => p.statements),
      },
    };
  }
  const location = detectedLocation(options, cwd, projectDir, config);
  return {
    cwd,
    projectDir,
    ...(location === undefined ? {} : { location }),
    config,
    cliSince,
    discovery,
    inputs,
    parsed,
    declarative,
  };
}

function detectedLocation(
  options: LintOptions,
  cwd: string,
  projectDir: string,
  config: Config,
): DetectedLocation | undefined {
  if (options.dir !== undefined) return undefined;
  if (projectDir !== cwd) return { kind: 'project root', path: toRelPath(cwd, projectDir) };
  if (config.migrations === DEFAULT_MIGRATIONS && isMigrationsFolder(projectDir)) {
    return { kind: 'migrations folder', path: '.' };
  }
  return undefined;
}

/**
 * Lints a project's migrations. Rejects with a `UsageError` (exit 2) for a bad config, path or
 * suppression comment.
 */
export async function lint(options: LintOptions = {}): Promise<LintResult> {
  const started = performance.now();
  const { projectDir, config, location, cliSince, discovery, inputs, parsed, declarative } =
    await loadProject(options);
  const replay = replayWithWindow(inputs, { ...config, cliSince });
  const checked =
    declarative !== null && isDeclarativeEnforced(replay.since, projectDir) ? declarative : null;
  const declared = checked === null ? undefined : replayDeclarative(checked, config);
  const allParsed = [...parsed, ...(checked?.parsed ?? [])];
  const result = runRules({
    config,
    replay,
    suppressions: allParsed.flatMap((p) => p.suppressions),
    suppressionProblems: allParsed.flatMap((p) => p.suppressionProblems),
    discovery,
    strictParse: options.strictParse ?? false,
    ...(declared === undefined ? {} : { declarative: declared }),
  });
  const skipped = declarative !== null && checked === null;
  const notices = [
    ...replayNotices(replay),
    ...(skipped ? [declarativeSkippedNotice(declarative)] : []),
    // An ignore entry may be there for the unchecked schema files: "remove it" would be wrong.
    ...result.notices.filter((notice) => !skipped || notice.code !== 'unused-ignore'),
  ];
  const count = (severity: Finding['severity']): number =>
    result.findings.filter((finding) => finding.severity === severity).length;
  // A relation both migrations and declarative files create counts once.
  const relations = new Set(
    [replay, ...(declared === undefined ? [] : [declared])].flatMap((r) =>
      r.final
        .relations()
        .filter((relation) => r.inScope(relation))
        .map((relation) => `${relation.schema}.${relation.name}`),
    ),
  );

  return {
    config,
    ...(location === undefined ? {} : { location }),
    since: replay.since,
    findings: result.findings,
    notices,
    summary: {
      files: inputs.length + (checked?.files.length ?? 0),
      relations: relations.size,
      errors: count('error'),
      warnings: count('warn'),
      notices: count('info') + notices.length,
      durationMs: Math.round(performance.now() - started),
    },
  };
}
