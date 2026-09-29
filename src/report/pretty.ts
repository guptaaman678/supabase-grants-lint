/**
 * The default terminal output (spec §6.3): findings grouped by file, each with its fix and docs
 * link aligned under the rule ID, then notices, then a one-line summary.
 */
import { type Colors, colors as makeColors } from '../cli/color.js';
import type { LintResult } from '../lint.js';
import type { Finding, Severity } from '../rules/types.js';
import { type ReportOptions, reportedFindings, reportedNotices } from './select.js';

export interface PrettyOptions extends ReportOptions {
  /** Default: no colour. */
  readonly colors?: Colors;
}

const SEVERITY_WIDTH = 'error'.length;

/** The coloured label, padded outside the colour codes. */
function paintSeverity(c: Colors, severity: Severity): string {
  const pad = ' '.repeat(SEVERITY_WIDTH - severity.length);
  if (severity === 'error') return c.red(severity) + pad;
  if (severity === 'warn') return c.yellow(severity) + pad;
  return c.cyan(severity) + pad;
}

/** One block per file: location, severity, rule and message, then `fix` and `docs` lines. */
function fileBlock(file: string, findings: readonly Finding[], c: Colors): string[] {
  const where = (f: Finding): string => `${String(f.line)}:${String(f.column)}`;
  const whereWidth = Math.max(...findings.map((f) => where(f).length));
  const ruleWidth = Math.max(...findings.map((f) => f.ruleId.length));
  const indent = ' '.repeat(2 + whereWidth + 2 + SEVERITY_WIDTH + 2);
  const out = [c.bold(file)];
  for (const f of findings) {
    const head = `  ${where(f).padEnd(whereWidth)}  ${paintSeverity(c, f.severity)}  `;
    out.push(`${head}${f.ruleId.padEnd(ruleWidth)}  ${f.message}`);
    if (f.fix !== undefined) {
      const [first, ...rest] = f.fix.split('\n');
      out.push(`${indent}${c.dim('fix ')}  ${first ?? ''}`);
      for (const line of rest) out.push(`${indent}      ${line}`);
    }
    out.push(`${indent}${c.dim('docs')}  ${f.docsUrl}`);
  }
  return out;
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

export function formatPretty(result: LintResult, options: PrettyOptions = {}): string {
  const c = options.colors ?? makeColors(false);
  // Findings arrive sorted by file in replay order; a Map keeps that order.
  const byFile = new Map<string, Finding[]>();
  for (const finding of reportedFindings(result, options)) {
    const group = byFile.get(finding.file);
    if (group === undefined) byFile.set(finding.file, [finding]);
    else group.push(finding);
  }
  const blocks = [...byFile].map(([file, findings]) => fileBlock(file, findings, c));

  const notices = reportedNotices(result, options).map((notice) => {
    const where =
      notice.file === undefined
        ? ''
        : `${notice.file}${notice.line === undefined ? '' : `:${String(notice.line)}`}: `;
    return `${c.dim('notice')}  ${where}${notice.message}`;
  });
  if (notices.length > 0) blocks.push(notices);

  const { errors, warnings } = result.summary;
  const summary = summaryLine(result);
  blocks.push([errors > 0 ? c.red(summary) : warnings > 0 ? c.yellow(summary) : summary]);
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}

/**
 * `1 error, 0 warnings  (74 files, 61 relations, 0.4s)`, plus `, project root ../..` when the
 * project was found above the working directory.
 */
export function summaryLine(result: LintResult): string {
  const { errors, warnings, files, relations, durationMs } = result.summary;
  const where =
    result.location === undefined ? '' : `, ${result.location.kind} ${result.location.path}`;
  return (
    `${plural(errors, 'error')}, ${plural(warnings, 'warning')}  ` +
    `(${plural(files, 'file')}, ${plural(relations, 'relation')}, ${(durationMs / 1000).toFixed(1)}s${where})`
  );
}
