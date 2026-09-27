import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { UsageError } from '../errors.js';
import { globFiles, hasGlobMagic, isFileEntry } from './glob.js';

export const DEFAULT_MIGRATIONS = 'supabase/migrations';

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
  /**
   * A missing default `supabase/migrations` means no migrations rather than a usage error: the
   * project has declarative schemas and may not have generated a migration yet.
   */
  readonly allowMissingDefault?: boolean;
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

/**
 * The version of the migration at `abs`: from its file name, else from its directory's name, for
 * layouts with one directory per migration (Prisma: `<version>_<name>/migration.sql`, ADR-017).
 */
export function migrationVersion(abs: string): string | null {
  return extractVersion(path.basename(abs)) ?? extractVersion(path.basename(path.dirname(abs)));
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

/**
 * True when `dir` has no `supabase/migrations` but holds `.sql` files itself: `--dir` was given the
 * migrations folder rather than the project root, so the default `migrations` means `dir`. Only
 * for an explicit `--dir`, so stray `.sql` files in the working directory are never linted.
 */
function isMigrationsFolder(dir: string): boolean {
  if (statSync(path.join(dir, DEFAULT_MIGRATIONS), { throwIfNoEntry: false }) !== undefined) {
    return false;
  }
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return false;
  return readdirSync(dir, { withFileTypes: true }).some(
    (dirent) => isSqlFile(dirent.name) && isFileEntry(dirent, path.join(dir, dirent.name)),
  );
}

export function discoverMigrations(options: DiscoverOptions = {}): Discovery {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectDir = path.resolve(cwd, options.projectDir ?? '.');
  const raw = options.migrations ?? DEFAULT_MIGRATIONS;
  const entries =
    raw === DEFAULT_MIGRATIONS && projectDir !== cwd && isMigrationsFolder(projectDir)
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
    if (stat === undefined && options.allowMissingDefault === true && raw === DEFAULT_MIGRATIONS) {
      continue;
    }
    if (stat === undefined) {
      throw new UsageError(
        `Migrations directory not found: ${toRelPath(cwd, abs) || '.'}. ` +
          'Run from the project root, pass --dir <project>, or set "migrations" in the config.',
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
      return { path: abs, relPath: toRelPath(cwd, abs), name, version: migrationVersion(abs) };
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
