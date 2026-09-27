/**
 * Declarative schema discovery (spec T11.2, ADR-017): the `.sql` files that describe the desired
 * state of the database, in the order the Supabase CLI applies them to build that state.
 *
 * Config `schemaPaths: "auto"` follows the CLI's own ladder: `[db.migrations] schema_paths` in
 * `supabase/config.toml` when it lists anything (entries relative to `supabase/`), else
 * `[experimental.pgdelta] declarative_schema_path` (default `schemas`) when pg-delta is enabled
 * and that directory exists, else `supabase/schemas` when it exists, else nothing. A list in the
 * config (relative to the project directory) replaces the ladder; `[]` turns discovery off.
 *
 * Order, as in the CLI: entries in the order given; each entry's matches sorted by UTF-8 byte
 * order; a matched directory expands to every `.sql` file below it; a file an earlier entry
 * already matched is skipped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { UsageError } from '../errors.js';
import { toRelPath } from './discover.js';
import { globFiles, hasGlobMagic } from './glob.js';
import { readSupabaseToml } from './supabase-config.js';

export type SchemaPathsSetting = 'auto' | readonly string[];

/** Where the declarative files were found. */
export type SchemaPathsSource = 'config' | 'config.toml' | 'pgdelta' | 'default';

export interface SchemaFile {
  /** Absolute path, platform separators. */
  readonly path: string;
  /** Path relative to the working directory with `/` separators; used in findings. */
  readonly relPath: string;
}

export interface DeclarativeDiscovery {
  /** In the order the CLI applies them. Empty when the project has no declarative schemas. */
  readonly files: readonly SchemaFile[];
  /** `null` when there are no declarative files. */
  readonly source: SchemaPathsSource | null;
}

export interface DeclarativeOptions {
  readonly schemaPaths: SchemaPathsSetting;
  /** The project directory (`--dir`). */
  readonly projectDir: string;
  /** Directory that `relPath` is relative to. */
  readonly cwd: string;
}

const NONE: DeclarativeDiscovery = { files: [], source: null };

/** UTF-8 byte order, as the Supabase CLI sorts. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function isDirectory(abs: string): boolean {
  return statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Every regular `.sql` file below `dir`; symlinks below the root are not followed (as the CLI). */
function walkSql(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile() && entry.name.endsWith('.sql')) out.push(abs);
    }
  };
  visit(dir);
  return out;
}

/**
 * The files one entry names, sorted by byte order of their path relative to `base`. A literal
 * path that does not exist is a usage error; a glob that matches nothing contributes nothing.
 */
function expand(entry: string, base: string, origin: string): string[] {
  const pattern = entry.replaceAll('\\', '/');
  if (pattern.trim() === '') throw new UsageError(`${origin} contains an empty path`);
  const byPath = (abs: string): string => toRelPath(base, abs);
  const sorted = (files: string[]): string[] =>
    files.sort((a, b) => compareUtf8(byPath(a), byPath(b)));
  if (hasGlobMagic(pattern)) {
    let matches: string[];
    try {
      matches = globFiles(pattern, base);
    } catch (error) {
      // The glob's fixed directory does not exist: no matches, as the CLI skips such globs.
      if (error instanceof UsageError) return [];
      throw error;
    }
    return sorted(matches.filter((abs) => abs.endsWith('.sql')));
  }
  const abs = path.resolve(base, pattern);
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (stat === undefined) {
    throw new UsageError(
      `Declarative schema path not found: ${pattern} (from ${origin}). ` +
        'Fix the path, or set "schemaPaths": [] in the config to skip declarative schemas.',
    );
  }
  if (stat.isDirectory()) return sorted(walkSql(abs));
  return [abs];
}

function collect(
  entries: readonly string[],
  base: string,
  origin: string,
  cwd: string,
): SchemaFile[] {
  const seen = new Set<string>();
  const files: SchemaFile[] = [];
  for (const entry of entries) {
    for (const abs of expand(entry, base, origin)) {
      if (seen.has(abs)) continue;
      seen.add(abs);
      files.push({ path: abs, relPath: toRelPath(cwd, abs) });
    }
  }
  return files;
}

function found(files: SchemaFile[], source: SchemaPathsSource): DeclarativeDiscovery {
  return files.length === 0 ? NONE : { files, source };
}

export function discoverSchemaFiles(options: DeclarativeOptions): DeclarativeDiscovery {
  const { schemaPaths, projectDir, cwd } = options;
  if (schemaPaths !== 'auto') {
    return found(collect(schemaPaths, projectDir, 'config "schemaPaths"', cwd), 'config');
  }
  const supabaseDir = path.join(projectDir, 'supabase');
  const tomlFile = path.join(supabaseDir, 'config.toml');
  const toml = existsSync(tomlFile) ? readSupabaseToml(readFileSync(tomlFile, 'utf8')) : null;

  const listed = toml?.get('db.migrations.schema_paths');
  if (Array.isArray(listed) && listed.length > 0) {
    const origin = 'supabase/config.toml [db.migrations] schema_paths';
    return found(collect(listed as string[], supabaseDir, origin, cwd), 'config.toml');
  }
  if (toml?.get('experimental.pgdelta.enabled') === true) {
    const declared = toml.get('experimental.pgdelta.declarative_schema_path');
    const dir = path.resolve(supabaseDir, typeof declared === 'string' ? declared : 'schemas');
    if (isDirectory(dir)) return found(collect([dir], supabaseDir, 'pg-delta', cwd), 'pgdelta');
  }
  const schemasDir = path.join(supabaseDir, 'schemas');
  if (isDirectory(schemasDir)) {
    return found(collect([schemasDir], supabaseDir, 'supabase/schemas', cwd), 'default');
  }
  return NONE;
}
