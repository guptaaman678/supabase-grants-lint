/**
 * `supabase-grants-lint/engine` (experimental in 0.x, see docs/engine.md): the replay as a library.
 * After one awaited `loadEngine()`, `replayProjectSync` replays a project's migrations exactly as
 * `check` does (same config lookup, discovery, `since` window and platform defaults) and returns
 * the database they build as a `SchemaSnapshot`. Reads files only; no network.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { type Config, PACKAGE_JSON_KEY } from './config/defaults.js';
import { COMMAND_LINE_SOURCE } from './config/load.js';
import { ConfigError, UsageError } from './errors.js';
import { DEFAULT_MIGRATIONS, isMigrationsFolder } from './load/discover.js';
import { hasGlobMagic } from './load/glob.js';
import { type ProjectFiles, parseProject, resolveProjectFiles } from './lint.js';
import { loadParser, type MigrationParser } from './parse/adapter.js';
import { replayWithWindow } from './replay/since.js';
import { type SchemaSnapshot, toSnapshot } from './snapshot.js';
import { version } from './version.js';

export { version } from './version.js';
export {
  publicationMembership,
  type SchemaSnapshot,
  type SnapshotLocation,
  type SnapshotMeta,
  type SnapshotName,
  type SnapshotPolicy,
  type SnapshotPublication,
  type SnapshotRelation,
  type SnapshotSequence,
} from './snapshot.js';

/** The config keys `overrides` may set: the ones that change what the replay builds. */
export const OVERRIDE_KEYS = [
  'migrations',
  'schemas',
  'since',
  'platformDefaults',
  'platformRevokeAtSince',
  'migrationRole',
  'autoRls',
  'platformPublications',
] as const;

export type OverrideKey = (typeof OVERRIDE_KEYS)[number];

export interface ReplayProjectOptions {
  /** The project directory: where the config and migrations are looked up, and paths start. */
  readonly projectDir: string;
  /** A config file to read instead of grants-lint's own lookup, relative to `projectDir`. */
  readonly configFile?: string;
  /** Config values above every config source, validated like the config file. */
  readonly overrides?: Readonly<Partial<Pick<Config, OverrideKey>>>;
}

export interface ReplayInputs {
  readonly projectDir: string;
  /** The config file with the highest precedence (absolute), or `null` for the defaults. */
  readonly configFile: string | null;
  /** That source as grants-lint names it, or `defaults`. */
  readonly configSource: string;
  /** Absolute paths, in replay order. */
  readonly migrations: readonly string[];
  /** Absolute directories whose listing can change the inputs, sorted. */
  readonly watchDirs: readonly string[];
}

export type EngineErrorCode = 'not-loaded' | 'config' | 'project';

/** A problem the caller can fix: the engine not loaded yet, a bad config, or a bad project path. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineError';
    this.code = code;
  }
}

let parser: MigrationParser | undefined;

/** Loads the SQL parser (WebAssembly) once. Idempotent; await it before `replayProjectSync`. */
export async function loadEngine(): Promise<void> {
  parser ??= await loadParser();
}

export function isEngineLoaded(): boolean {
  return parser !== undefined;
}

const DEFAULTS_SOURCE = 'defaults';

/** Runs `fn`, turning grants-lint's usage errors into `EngineError`s with the same message. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new EngineError('config', error.message, { cause: error });
    }
    if (error instanceof UsageError) {
      throw new EngineError('project', error.message, { cause: error });
    }
    throw error;
  }
}

function resolve(options: ReplayProjectOptions): ProjectFiles {
  const projectDir = path.resolve(options.projectDir);
  if (statSync(projectDir, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new EngineError('project', `Project directory not found: ${projectDir}`);
  }
  const overrides = options.overrides ?? {};
  const unknown = Object.keys(overrides).filter(
    (key) => !(OVERRIDE_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    const issues = unknown.map((key) => ({ key, message: 'cannot be overridden' }));
    throw new EngineError('config', new ConfigError('overrides', issues).message);
  }
  return guarded(() =>
    resolveProjectFiles({
      cwd: projectDir,
      dir: projectDir,
      ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
      overrides,
    }),
  );
}

/** The config source with the highest precedence, ignoring `overrides`. */
function configSource(project: ProjectFiles): string {
  return project.configSources.filter((s) => s !== COMMAND_LINE_SOURCE).at(-1) ?? DEFAULTS_SOURCE;
}

/**
 * Replays the project's migrations and returns the database they build. Throws `EngineError`:
 * `not-loaded` before `loadEngine()` resolves, `config` for an invalid config or override,
 * `project` for a missing project or migrations directory or a bad glob. SQL never throws:
 * statements the parser cannot read and `DO` blocks are counted in `meta`.
 */
export function replayProjectSync(options: ReplayProjectOptions): SchemaSnapshot {
  if (parser === undefined) {
    throw new EngineError('not-loaded', 'Call and await loadEngine() before replayProjectSync()');
  }
  const project = resolve(options);
  const loaded = parseProject(project, {}, parser);
  const replay = replayWithWindow(loaded.inputs, { ...loaded.config });
  const statements = loaded.parsed.flatMap((file) => file.statements);
  const count = (kind: string): number => statements.filter((s) => s.kind === kind).length;
  return toSnapshot(replay.final, {
    engineVersion: version,
    configSource: configSource(project),
    files: loaded.inputs.length,
    since: { value: replay.since.value, source: replay.since.source },
    parseProblems: count('Unparseable'),
    dynamicSql: count('DynamicSql'),
    declarativeFiles: project.schemaFiles.files.length,
  });
}

/** `await loadEngine()`, then `replayProjectSync(options)`. */
export async function replayProject(options: ReplayProjectOptions): Promise<SchemaSnapshot> {
  await loadEngine();
  return replayProjectSync(options);
}

/** The directories a `migrations` entry lists: a directory itself, or a glob's fixed part. */
function entryDirs(entry: string, projectDir: string): string[] {
  const normalized = entry.replaceAll('\\', '/');
  if (hasGlobMagic(normalized)) {
    const segments = normalized.split('/');
    const fixed = segments
      .slice(
        0,
        segments.findIndex((s) => hasGlobMagic(s)),
      )
      .join('/');
    return [path.resolve(projectDir, fixed || '.')];
  }
  const abs = path.resolve(projectDir, normalized);
  return statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true ? [abs] : [];
}

/**
 * The files `replayProjectSync` reads, without loading the parser: for a cache to watch. A new
 * file appears in the listing of one of `watchDirs` (the project directory, each migrations
 * directory, a glob's fixed directory and every directory holding a migration).
 */
export function listReplayInputs(options: ReplayProjectOptions): ReplayInputs {
  const project = resolve(options);
  const { projectDir, config } = project;
  const source = configSource(project);
  const pkgSuffix = `#${PACKAGE_JSON_KEY}`;
  const file = source.endsWith(pkgSuffix) ? source.slice(0, -pkgSuffix.length) : source;
  const configFile = source === DEFAULTS_SOURCE ? null : path.resolve(projectDir, file);
  const migrations = project.migrations.files.map((file) => file.path);
  const raw = config.migrations;
  const entries =
    raw === DEFAULT_MIGRATIONS && isMigrationsFolder(projectDir)
      ? ['.']
      : typeof raw === 'string'
        ? [raw]
        : raw;
  const watchDirs = new Set([
    projectDir,
    ...entries.flatMap((entry) => entryDirs(entry, projectDir)),
    ...migrations.map((file) => path.dirname(file)),
  ]);
  return {
    projectDir,
    configFile,
    configSource: source,
    migrations,
    watchDirs: [...watchDirs].sort(),
  };
}
