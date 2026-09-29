/**
 * The programmatic API (spec §6.5) and the pipeline behind `check`: config, discovery, parser,
 * replay with the enforcement window, rules. Reads files only; no network (G4).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config/defaults.js';
import { loadConfig } from './config/load.js';
import { validateConfig } from './config/validate.js';
import {
  DEFAULT_MIGRATIONS,
  discoverMigrations,
  type DiscoveryNotice,
  findProjectDir,
  isMigrationsFolder,
  toRelPath,
} from './load/discover.js';
import { loadParser, type ParsedFile } from './parse/adapter.js';
import type { ReplayInput } from './replay/engine.js';
import { replayWithWindow, type ResolvedSince } from './replay/since.js';
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
}

/**
 * Loads the config, discovers the migrations and parses them (`check` and `doctor`). Rejects with
 * a `UsageError` (exit 2) for a bad config or path.
 */
export async function loadProject(options: LintOptions = {}): Promise<LoadedProject> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectDir =
    options.dir === undefined ? findProjectDir(cwd) : path.resolve(cwd, options.dir);
  const cliSince =
    options.since === undefined
      ? undefined
      : (validateConfig({ since: options.since }, '--since').since as string);
  const { config } = loadConfig({
    cwd,
    projectDir,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    ...(options.schemas === undefined ? {} : { overrides: { schemas: [...options.schemas] } }),
  });
  const { files, notices: discovery } = discoverMigrations({
    migrations: config.migrations,
    projectDir,
    cwd,
  });

  const parser = await loadParser();
  const parsed = files.map((file) => parser.parse(readFileSync(file.path, 'utf8'), file.relPath));
  const inputs = files.map((file, i) => ({
    file: file.relPath,
    version: file.version,
    statements: parsed[i]?.statements ?? [],
  }));
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
  const { config, location, cliSince, discovery, inputs, parsed } = await loadProject(options);
  const replay = replayWithWindow(inputs, { ...config, cliSince });
  const result = runRules({
    config,
    replay,
    suppressions: parsed.flatMap((p) => p.suppressions),
    suppressionProblems: parsed.flatMap((p) => p.suppressionProblems),
    discovery,
    strictParse: options.strictParse ?? false,
  });
  const notices = [...replayNotices(replay), ...result.notices];
  const count = (severity: Finding['severity']): number =>
    result.findings.filter((finding) => finding.severity === severity).length;

  return {
    config,
    ...(location === undefined ? {} : { location }),
    since: replay.since,
    findings: result.findings,
    notices,
    summary: {
      files: inputs.length,
      relations: replay.final.relations().filter((relation) => replay.inScope(relation)).length,
      errors: count('error'),
      warnings: count('warn'),
      notices: count('info') + notices.length,
      durationMs: Math.round(performance.now() - started),
    },
  };
}
