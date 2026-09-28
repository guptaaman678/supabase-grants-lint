export { version } from './version.js';
export {
  type DetectedLocation,
  lint,
  type LintOptions,
  type LintResult,
  type LintSummary,
} from './lint.js';
export type { Finding, Notice, Severity } from './rules/types.js';
export type { JsonReport } from './report/json.js';
