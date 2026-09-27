/**
 * The programmatic API (spec §6.5) and the pipeline behind `check`: config, discovery, parser,
 * replay with the enforcement window, rules. Reads files only; no network (G4).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config/defaults.js';
import { loadConfig } from './config/load.js';
import { validateConfig } from './config/validate.js';
import { discoverSchemaFiles, type SchemaPathsSource } from './load/declarative.js';
import { discoverMigrations, type DiscoveryNotice } from './load/discover.js';
import { loadParser, type ParsedFile } from './parse/adapter.js';
import type { ReplayInput } from './replay/engine.js';
import { replayWithWindow, type ResolvedSince, type WindowedReplay } from './replay/since.js';
import { type Finding, type Notice, replayNotices, runRules } from './rules/index.js';

export interface LintOptions {
  /** Directory relative paths (and finding paths) are resolved against. Default: `process.cwd()`. */
  readonly cwd?: string;
  /** Project directory (`--dir`): where the config and migrations are looked up. Default: `cwd`. */
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

export interface LintResult {
  readonly config: Config;
  readonly since: ResolvedSince;
  readonly summary: LintSummary;
  readonly findings: readonly Finding[];
  readonly notices: readonly Notice[];
}

/** A project's config and parsed migrations, before any replay. */
export interface LoadedProject {
  /** The resolved working directory; reported paths are relative to it. */
  readonly cwd: string;
  /** The resolved `--dir`. */
  readonly projectDir: string;
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

/**
 * Loads the config, discovers the migrations and parses them (`check` and `doctor`). Rejects with
 * a `UsageError` (exit 2) for a bad config or path.
 */
export async function loadProject(options: LintOptions = {}): Promise<LoadedProject> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectDir = path.resolve(cwd, options.dir ?? '.');
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
  const schemaFiles = discoverSchemaFiles({ schemaPaths: config.schemaPaths, projectDir, cwd });
  const { files, notices: discovery } = discoverMigrations({
    migrations: config.migrations,
    projectDir,
    cwd,
    allowMissingDefault: schemaFiles.files.length > 0,
  });

  const parser = await loadParser();
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
  return { cwd, projectDir, config, cliSince, discovery, inputs, parsed, declarative };
}

/**
 * Lints a project's migrations. Rejects with a `UsageError` (exit 2) for a bad config, path or
 * suppression comment.
 */
export async function lint(options: LintOptions = {}): Promise<LintResult> {
  const started = performance.now();
  const { config, cliSince, discovery, inputs, parsed, declarative } = await loadProject(options);
  const replay = replayWithWindow(inputs, { ...config, cliSince });
  const declared = declarative === null ? undefined : replayDeclarative(declarative, config);
  const allParsed = [...parsed, ...(declarative?.parsed ?? [])];
  const result = runRules({
    config,
    replay,
    suppressions: allParsed.flatMap((p) => p.suppressions),
    suppressionProblems: allParsed.flatMap((p) => p.suppressionProblems),
    discovery,
    strictParse: options.strictParse ?? false,
    ...(declared === undefined ? {} : { declarative: declared }),
  });
  const notices = [...replayNotices(replay), ...result.notices];
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
    since: replay.since,
    findings: result.findings,
    notices,
    summary: {
      files: inputs.length + (declarative?.files.length ?? 0),
      relations: relations.size,
      errors: count('error'),
      warnings: count('warn'),
      notices: count('info') + notices.length,
      durationMs: Math.round(performance.now() - started),
    },
  };
}
