import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { UsageError } from '../errors.js';
import { globFiles, hasGlobMagic, isFileEntry } from './glob.js';

export const DEFAULT_MIGRATIONS = 'supabase/migrations';

/** Files that mark a project root. `config/defaults.ts` imports this module, hence the copy of its name. */
export const PROJECT_MARKERS = ['grants-lint.config.json', 'package.json'] as const;

export interface MigrationFile {
  /** Absolute path, platform separators. */
  readonly path: string;
  /** Path relative to the working directory with `/` separators; used in findings. */
  readonly relPath: string;
  /** File name without directories. */
  readonly name: string;
  /** Leading digits before the first `_`, or `null` when the name has no such prefix. */
  readonly version: string | null;
}

export interface DiscoveryNotice {
  readonly ruleId: 'PARSE001';
  /** `relPath` of the file the notice is about. */
  readonly file: string;
  readonly message: string;
}

export interface DiscoverOptions {
  /** Config `migrations`: a directory, a glob, a `.sql` file, or a list of these. */
  readonly migrations?: string | readonly string[];
  /** Directory that relative `migrations` entries are resolved against (`--dir`). Default: `cwd`. */
  readonly projectDir?: string;
  /** Directory that `relPath` is relative to. Default: `process.cwd()`. */
  readonly cwd?: string;
}

export interface Discovery {
  /** Replay order: versioned files by name, then unversioned files by name. */
  readonly files: MigrationFile[];
  readonly notices: DiscoveryNotice[];
}

const VERSION_PREFIX = /^([0-9]+)_/;

/** The migration version: the leading digits of `name` when they are followed by `_`. */
export function extractVersion(name: string): string | null {
  return VERSION_PREFIX.exec(name)?.[1] ?? null;
}

export function isSqlFile(name: string): boolean {
  return name.endsWith('.sql');
}

/** `abs` relative to `cwd`, always with `/` separators. `pathApi` is injectable for tests. */
export function toRelPath(cwd: string, abs: string, pathApi: path.PlatformPath = path): string {
  return pathApi.relative(cwd, abs).split(pathApi.sep).join('/');
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Replay order. Versioned files come first, ordered by file name compared by UTF-16 code
 * unit (for digit-and-ASCII names this is the byte order the Supabase CLI applies them in);
 * unversioned files follow, by name. Ties break on `relPath`, so the order never depends on
 * the file system.
 */
export function compareMigrations(a: MigrationFile, b: MigrationFile): number {
  if ((a.version === null) !== (b.version === null)) return a.version === null ? 1 : -1;
  return compareStrings(a.name, b.name) || compareStrings(a.relPath, b.relPath);
}

function exists(abs: string): boolean {
  return statSync(abs, { throwIfNoEntry: false }) !== undefined;
}

function isDirectory(abs: string): boolean {
  return statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * True when `dir` has no `supabase/migrations` but holds `.sql` files itself: the project
 * directory is the migrations folder rather than the project root, so the default `migrations`
 * means `dir` (`--dir supabase/migrations`, or running from a folder of migrations).
 */
export function isMigrationsFolder(dir: string): boolean {
  if (exists(path.join(dir, DEFAULT_MIGRATIONS)) || !isDirectory(dir)) return false;
  return readdirSync(dir, { withFileTypes: true }).some(
    (dirent) => isSqlFile(dirent.name) && isFileEntry(dirent, path.join(dir, dirent.name)),
  );
}

/**
 * The project directory when no `--dir` is given. `cwd` itself when it has `supabase/migrations`,
 * a `grants-lint.config.json` or a `package.json`; otherwise the folder that contains `supabase/`
 * when `cwd` is `supabase/migrations` or `supabase/` (so its config and `config.toml` are read
 * too, and `supabase/seed.sql` is not mistaken for the migrations); otherwise `cwd`.
 */
export function findProjectDir(cwd: string): string {
  const here = (name: string): boolean => exists(path.join(cwd, name));
  if ([DEFAULT_MIGRATIONS, ...PROJECT_MARKERS].some(here)) return cwd;
  const parent = path.dirname(cwd);
  if (path.basename(cwd) === 'migrations' && path.basename(parent) === 'supabase') {
    return path.dirname(parent);
  }
  if (path.basename(cwd) === 'supabase' && isDirectory(path.join(cwd, 'migrations'))) {
    return parent;
  }
  return cwd;
}

export function discoverMigrations(options: DiscoverOptions = {}): Discovery {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectDir = path.resolve(cwd, options.projectDir ?? '.');
  const raw = options.migrations ?? DEFAULT_MIGRATIONS;
  const entries =
    raw === DEFAULT_MIGRATIONS && isMigrationsFolder(projectDir)
      ? ['.']
      : typeof raw === 'string'
        ? [raw]
        : [...raw];
  if (entries.length === 0) {
    throw new UsageError('"migrations" is an empty list: give at least one directory or glob');
  }

  const found = new Set<string>();
  for (const rawEntry of entries) {
    // Accept Windows-style separators in config on every platform.
    const entry = rawEntry.replaceAll('\\', '/');
    if (entry.trim() === '') {
      throw new UsageError('"migrations" contains an empty path');
    }
    if (hasGlobMagic(entry)) {
      for (const abs of globFiles(entry, projectDir)) {
        if (isSqlFile(path.basename(abs))) found.add(abs);
      }
      continue;
    }
    const abs = path.resolve(projectDir, entry);
    const stat = statSync(abs, { throwIfNoEntry: false });
    if (stat === undefined) {
      throw new UsageError(
        `Migrations directory not found: ${toRelPath(cwd, abs) || '.'}. ` +
          'Run from the project root (the folder that contains supabase/), ' +
          'or pass --dir <project or migrations folder>.',
      );
    }
    if (stat.isDirectory()) {
      for (const dirent of readdirSync(abs, { withFileTypes: true })) {
        const file = path.join(abs, dirent.name);
        if (isSqlFile(dirent.name) && isFileEntry(dirent, file)) found.add(file);
      }
    } else if (isSqlFile(path.basename(abs))) {
      found.add(abs);
    } else {
      throw new UsageError(`Migrations path is not a .sql file or a directory: ${entry}`);
    }
  }

  const files = [...found]
    .map((abs): MigrationFile => {
      const name = path.basename(abs);
      return { path: abs, relPath: toRelPath(cwd, abs), name, version: extractVersion(name) };
    })
    .sort(compareMigrations);

  const notices = files
    .filter((file) => file.version === null)
    .map((file): DiscoveryNotice => ({
      ruleId: 'PARSE001',
      file: file.relPath,
      message:
        `${file.name} has no numeric version prefix (expected <version>_<name>.sql); ` +
        'it is replayed after all versioned files, in name order',
    }));

  return { files, notices };
}
