/**
 * Live mode (spec T11.1): the pipeline behind `diff` and `doctor --db-url`. Replays the migrations
 * as `check` does, reads the database's grants read-only, and runs GL009 to report where they
 * disagree. The only pipeline that opens a connection, and only to the URL the user passed (G4).
 */
import { type LintOptions, type LintResult, loadProject } from './lint.js';
import { readCatalog } from './live/read.js';
import { buildSnapshot, type LiveSnapshot } from './live/snapshot.js';
import { replayWithWindow } from './replay/since.js';
import { GL009 } from './rules/GL009.js';
import { type Finding, runRules } from './rules/index.js';

export interface DriftOptions extends LintOptions {
  /** A `postgres://` connection string; see `resolveDbUrl`. */
  readonly dbUrl: string;
}

/** Reads the database's grants in `schemas`. Rejects with a `UsageError` when it cannot connect. */
export async function readLive(dbUrl: string, schemas: readonly string[]): Promise<LiveSnapshot> {
  return buildSnapshot(await readCatalog(dbUrl, schemas));
}

/** `diff`: GL009 findings, in the shape `check` reports. */
export async function drift(options: DriftOptions): Promise<LintResult & { live: LiveSnapshot }> {
  const started = performance.now();
  const { config, cliSince, discovery, inputs, parsed } = await loadProject(options);
  const replay = replayWithWindow(inputs, { ...config, cliSince });
  const live = await readLive(options.dbUrl, config.schemas);
  const result = runRules({
    config,
    replay,
    suppressions: parsed.flatMap((p) => p.suppressions),
    suppressionProblems: parsed.flatMap((p) => p.suppressionProblems),
    discovery,
    rules: [GL009],
    live,
  });
  const count = (severity: Finding['severity']): number =>
    result.findings.filter((finding) => finding.severity === severity).length;
  return {
    config,
    since: replay.since,
    findings: result.findings,
    notices: result.notices,
    live,
    summary: {
      files: inputs.length,
      relations: replay.final.relations().filter((relation) => replay.inScope(relation)).length,
      errors: count('error'),
      warnings: count('warn'),
      notices: count('info') + result.notices.length,
      durationMs: Math.round(performance.now() - started),
    },
  };
}
