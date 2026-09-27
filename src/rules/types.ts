/**
 * The shape every rule has (spec §6.2, T3.0). A rule reads the replay through a `RuleContext` and
 * returns what it found; the framework in `index.ts` applies severities, suppressions and
 * ordering. Rules never change the model: the catalog is immutable and the context is frozen.
 */
import type { Config, RuleId } from '../config/defaults.js';
import type { LiveSnapshot } from '../live/snapshot.js';
import type { DiscoveryNotice } from '../load/discover.js';
import type { Grantee } from '../model/acl.js';
import type { RelationName } from '../model/relations.js';
import type { SourceLocation } from '../parse/ir.js';
import type { FileReplay } from '../replay/engine.js';
import type { WindowedReplay } from '../replay/since.js';

export type Severity = 'error' | 'warn' | 'info';

/** One replayed file as a rule sees it. */
export interface FileContext extends FileReplay {
  /** Whether GL001 to GL006 and GL008 check this file (the enforcement window, §6.1). */
  readonly enforced: boolean;
}

export interface RuleContext {
  readonly config: Config;
  readonly replay: WindowedReplay;
  /** Every replayed file, in replay order. */
  readonly files: readonly FileContext[];
  /** The files in the enforcement window, in replay order. */
  readonly enforced: readonly FileContext[];
  /** Migration files discovery found without a version prefix (PARSE001). */
  readonly discovery: readonly DiscoveryNotice[];
  /** Whether rules check relations in this schema (config `schemas`). */
  inScope(name: RelationName): boolean;
  /** Config `clientRoles` (default `anon`, `authenticated`). */
  isClientRole(role: Grantee): boolean;
  /** Config `serviceOnly`: exempt from GL002 and GL003 for client roles. */
  isServiceOnly(name: RelationName): boolean;
  /** Live mode only (`diff`, `doctor --db-url`): the database GL009 compares with. */
  readonly live?: LiveSnapshot;
}

/** What a rule reports. The framework adds the rule ID, severity and docs URL. */
export interface RuleFinding {
  readonly at: SourceLocation;
  /** States the consequence and the fix in one or two sentences. */
  readonly message: string;
  readonly relation?: RelationName;
  readonly role?: Grantee;
  readonly privilege?: string;
  /** SQL that resolves the finding (see `src/fix/sql.ts`). */
  readonly fix?: string;
  /** Overrides the rule's default severity for this finding (GL003 unknown relation, GL007). */
  readonly severity?: Severity;
}

export interface Rule {
  readonly id: RuleId;
  /** Kebab-case name, e.g. `missing-service-role-grant`. */
  readonly name: string;
  readonly defaultSeverity: Severity;
  /** One sentence for `--help` and SARIF `shortDescription`. */
  readonly docs: string;
  check(ctx: RuleContext): readonly RuleFinding[];
}

/** A finding as reporters print it (JSON `findings[]`, §6.3). */
export interface Finding {
  readonly ruleId: RuleId;
  readonly severity: Severity;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** `schema.name`. */
  readonly relation?: string;
  /** A role name, or `PUBLIC`. */
  readonly role?: string;
  readonly privilege?: string;
  readonly fix?: string;
  readonly docsUrl: string;
}

/** Something the user should know that is not a finding (JSON `notices[]`, §6.3). */
export interface Notice {
  readonly code: 'unused-suppression' | 'unused-ignore' | 'platform-revoke' | 'invalid-privilege';
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface RuleRunResult {
  /** Sorted by file (replay order), line, column, rule. */
  readonly findings: readonly Finding[];
  readonly notices: readonly Notice[];
}
