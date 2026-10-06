/**
 * Statement IR: the typed shape of every statement the replay model (spec §6.1) handles.
 * Rules and the replay engine read this, never the parser's AST.
 *
 * Names keep the case the parser gives them: unquoted identifiers are lowercased, quoted ones
 * are kept verbatim. A `schema` of `null` means the name was not schema-qualified; resolving it
 * (for example against `public`) is the replay model's job.
 */

/** Where a statement starts. `line` and `column` are 1-based; `column` counts UTF-16 code units. */
export interface SourceLocation {
  /** Migration path relative to the working directory, with `/` separators. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface QualifiedName {
  readonly schema: string | null;
  readonly name: string;
}

/** A role as written in GRANT, REVOKE, policies and default privileges. */
export type RoleRef =
  | { readonly kind: 'public' }
  | { readonly kind: 'role'; readonly name: string }
  | { readonly kind: 'current_user' }
  | { readonly kind: 'current_role' }
  | { readonly kind: 'session_user' };

export type RelationKind = 'table' | 'view' | 'materialized view' | 'foreign table';

/** Relation kinds plus sequences: the objects RENAME, SET SCHEMA and DROP can target. */
export type ObjectKind = RelationKind | 'sequence';

export const SERIAL_TYPES = [
  'smallserial',
  'serial',
  'bigserial',
  'serial2',
  'serial4',
  'serial8',
] as const;
export type SerialType = (typeof SERIAL_TYPES)[number];

export interface SerialColumn {
  readonly column: string;
  readonly type: SerialType;
}

/**
 * A privilege as written, lowercased by the parser. `all` stands for `ALL [PRIVILEGES]`, which
 * the model expands for the object kind. `columns` is set for column-level grants.
 */
export interface Privilege {
  readonly name: string;
  readonly columns: readonly string[] | null;
}

export type PolicyCommand = 'all' | 'select' | 'insert' | 'update' | 'delete';

/**
 * How a policy's `USING` or `WITH CHECK` expression reads: `service_role` when it is only a test
 * that the request role is `service_role` (for example `auth.role() = 'service_role'`, ADR-012),
 * `false` when it is the constant `false` (ADR-019), `other` for anything else.
 */
export type PolicyPredicate = 'service_role' | 'false' | 'other';

interface Base extends SourceLocation {
  /** Source text of the statement, without the trailing `;`. */
  readonly text: string;
}

/** CREATE TABLE | VIEW | MATERIALIZED VIEW | FOREIGN TABLE, including `AS` and `PARTITION OF`. */
export interface CreateRelation extends Base {
  readonly kind: 'CreateRelation';
  readonly relation: QualifiedName;
  readonly relationKind: RelationKind;
  /** `CREATE TEMP ...`: temporary relations are not tracked. */
  readonly temporary: boolean;
  readonly ifNotExists: boolean;
  /** `CREATE OR REPLACE VIEW`. */
  readonly orReplace: boolean;
  /** Parent of `CREATE TABLE ... PARTITION OF`, otherwise `null`. */
  readonly partitionOf: QualifiedName | null;
  /** Columns declared with a serial pseudo-type; each gets an owned sequence. */
  readonly serialColumns: readonly SerialColumn[];
}

export interface CreateSequence extends Base {
  readonly kind: 'CreateSequence';
  readonly sequence: QualifiedName;
  readonly temporary: boolean;
  readonly ifNotExists: boolean;
}

/** `ALTER ... RENAME TO` on a relation or sequence. */
export interface RenameObject extends Base {
  readonly kind: 'RenameObject';
  readonly objectKind: ObjectKind;
  readonly object: QualifiedName;
  readonly newName: string;
  readonly ifExists: boolean;
}

/** `ALTER ... SET SCHEMA` on a relation or sequence. */
export interface SetSchema extends Base {
  readonly kind: 'SetSchema';
  readonly objectKind: ObjectKind;
  readonly object: QualifiedName;
  readonly newSchema: string;
  readonly ifExists: boolean;
}

/** `DROP TABLE | VIEW | MATERIALIZED VIEW | FOREIGN TABLE | SEQUENCE` with one or more names. */
export interface DropObjects extends Base {
  readonly kind: 'DropObjects';
  readonly objectKind: ObjectKind;
  readonly objects: readonly QualifiedName[];
  readonly ifExists: boolean;
  readonly cascade: boolean;
}

export type GrantTarget =
  /** Named objects (`ON [TABLE] a, b` or `ON SEQUENCE a, b`). */
  | { readonly kind: 'objects'; readonly objects: readonly QualifiedName[] }
  /** `ON ALL TABLES | ALL SEQUENCES IN SCHEMA s, ...`: the objects existing at that point. */
  | { readonly kind: 'allInSchema'; readonly schemas: readonly string[] };

/** GRANT or REVOKE of privileges on tables (and other relations) or sequences. */
export interface Grant extends Base {
  readonly kind: 'Grant';
  readonly action: 'grant' | 'revoke';
  /**
   * `table` covers `ON [TABLE]` (tables, views, materialized and foreign tables; Postgres also
   * accepts a sequence name here). `sequence` is `ON SEQUENCE` / `ALL SEQUENCES`.
   */
  readonly objectKind: 'table' | 'sequence';
  readonly target: GrantTarget;
  readonly privileges: readonly Privilege[];
  readonly grantees: readonly RoleRef[];
  /** GRANT: `WITH GRANT OPTION`. REVOKE: `GRANT OPTION FOR`, which keeps the privilege itself. */
  readonly grantOption: boolean;
}

/** `ALTER DEFAULT PRIVILEGES ... GRANT | REVOKE ... ON TABLES | SEQUENCES`. */
export interface AlterDefaultPrivileges extends Base {
  readonly kind: 'AlterDefaultPrivileges';
  readonly action: 'grant' | 'revoke';
  /** `FOR ROLE r, ...`; `null` when omitted (the role running the migration). */
  readonly forRoles: readonly RoleRef[] | null;
  /** `IN SCHEMA s, ...`; `null` when omitted (all schemas). */
  readonly inSchemas: readonly string[] | null;
  readonly objectKind: 'table' | 'sequence';
  readonly privileges: readonly Privilege[];
  readonly grantees: readonly RoleRef[];
  readonly grantOption: boolean;
}

export interface CreatePolicy extends Base {
  readonly kind: 'CreatePolicy';
  readonly name: string;
  readonly relation: QualifiedName;
  /** Defaults to `all` when `FOR` is omitted. */
  readonly command: PolicyCommand;
  /** Defaults to `[PUBLIC]` when `TO` is omitted. */
  readonly roles: readonly RoleRef[];
  readonly permissive: boolean;
  /** The `USING` expression, or `null` when absent. */
  readonly using: PolicyPredicate | null;
  /** The `WITH CHECK` expression, or `null` when absent. */
  readonly withCheck: PolicyPredicate | null;
}

/** `ALTER POLICY ... [TO ...] [USING ...] [WITH CHECK ...]`. */
export interface AlterPolicy extends Base {
  readonly kind: 'AlterPolicy';
  readonly name: string;
  readonly relation: QualifiedName;
  /** The new `TO` list, or `null` when the statement leaves the roles unchanged. */
  readonly roles: readonly RoleRef[] | null;
  /** The new `USING` expression, or `null` when the statement leaves it unchanged. */
  readonly using: PolicyPredicate | null;
  /** The new `WITH CHECK` expression, or `null` when the statement leaves it unchanged. */
  readonly withCheck: PolicyPredicate | null;
}

export interface RenamePolicy extends Base {
  readonly kind: 'RenamePolicy';
  readonly name: string;
  readonly relation: QualifiedName;
  readonly newName: string;
}

export interface DropPolicy extends Base {
  readonly kind: 'DropPolicy';
  readonly name: string;
  readonly relation: QualifiedName;
  readonly ifExists: boolean;
}

/** `SET [LOCAL] ROLE r`, or `RESET ROLE` / `SET ROLE NONE` (`role: null`). */
export interface SetRole extends Base {
  readonly kind: 'SetRole';
  readonly role: string | null;
  readonly local: boolean;
}

export const ROW_SECURITY_ACTIONS = ['enable', 'disable', 'force', 'no-force'] as const;
export type RowSecurityAction = (typeof ROW_SECURITY_ACTIONS)[number];

/**
 * `ALTER TABLE ... ENABLE | DISABLE | FORCE | NO FORCE ROW LEVEL SECURITY`. Other subcommands of
 * the same statement are not modelled; an `ALTER TABLE` without any of these four stays `Unknown`.
 */
export interface AlterTableRowSecurity extends Base {
  readonly kind: 'AlterTableRowSecurity';
  readonly relation: QualifiedName;
  readonly ifExists: boolean;
  /** `ALTER TABLE ONLY`; row security subcommands never recurse to partitions either way. */
  readonly only: boolean;
  /** In statement order. */
  readonly actions: readonly RowSecurityAction[];
}

/**
 * When an event trigger fires: `O` (`ENABLE`, the default), `R` (`ENABLE REPLICA`), `A`
 * (`ENABLE ALWAYS`) or `D` (`DISABLE`), as in `pg_event_trigger.evtenabled`.
 */
export type EventTriggerState = 'O' | 'R' | 'A' | 'D';

/** `CREATE | ALTER ... ENABLE/DISABLE | ALTER ... RENAME TO | DROP EVENT TRIGGER`. */
export type EventTrigger = Base & { readonly kind: 'EventTrigger' } & (
    | {
        readonly action: 'create';
        readonly name: string;
        /** E.g. `ddl_command_end`. */
        readonly event: string;
        /** `WHEN TAG IN (...)` as written, or `null` when the trigger fires for every tag. */
        readonly tags: readonly string[] | null;
        readonly function: QualifiedName;
      }
    | { readonly action: 'enable'; readonly name: string; readonly state: EventTriggerState }
    | { readonly action: 'rename'; readonly name: string; readonly newName: string }
    | { readonly action: 'drop'; readonly names: readonly string[]; readonly ifExists: boolean }
  );

/** `CREATE [OR REPLACE] FUNCTION | PROCEDURE`. The body is not interpreted. */
export interface FunctionDefinition extends Base {
  readonly kind: 'FunctionDefinition';
  readonly name: QualifiedName;
  /** `RETURNS event_trigger`: what the `rls_auto_enable` fingerprint looks for (ADR-010). */
  readonly returnsEventTrigger: boolean;
  /** Publications the body alters, creates or drops (`publicationMentions`). */
  readonly publicationMentions: readonly PublicationMention[];
}

/** `DROP FUNCTION | PROCEDURE` with one or more names; argument lists are not kept. */
export interface DropFunctions extends Base {
  readonly kind: 'DropFunctions';
  readonly functions: readonly QualifiedName[];
  readonly ifExists: boolean;
  readonly cascade: boolean;
}

/**
 * A top-level `SELECT f(), g()` (only function calls, no `FROM`) or `CALL p()`: what makes a
 * function body that changes publications run in a migration.
 */
export interface FunctionCall extends Base {
  readonly kind: 'FunctionCall';
  readonly functions: readonly QualifiedName[];
}

/**
 * A publication named in an `ALTER | CREATE | DROP PUBLICATION` inside a body the replay does not
 * interpret, or `'*'` when the name is not a plain or quoted identifier (`%I` in `format()`).
 */
export type PublicationMention = string;

/** Tables and schemas a publication statement lists; `null` is `CURRENT_SCHEMA`. */
export interface PublicationObjects {
  readonly tables: readonly QualifiedName[];
  readonly schemas: readonly (string | null)[];
}

/**
 * `CREATE | ALTER | DROP PUBLICATION`. Row filters, column lists and `publish` options are not
 * kept: the model is membership only. `ALTER PUBLICATION ... OWNER TO` and `SET (...)` are `noop`.
 */
export type Publication = Base & { readonly kind: 'Publication' } & (
    | ({
        readonly action: 'create';
        readonly name: string;
        readonly allTables: boolean;
      } & PublicationObjects)
    | ({
        readonly action: 'alter';
        readonly name: string;
        readonly op: 'add' | 'drop' | 'set';
      } & PublicationObjects)
    | { readonly action: 'rename'; readonly name: string; readonly newName: string }
    | { readonly action: 'drop'; readonly names: readonly string[]; readonly ifExists: boolean }
    | { readonly action: 'noop'; readonly name: string; readonly change: 'owner' | 'options' }
  );

/** Keywords that make a `DO` body worth a PARSE002 notice (spec §6.1). */
export const DYNAMIC_SQL_KEYWORDS = [
  'grant',
  'revoke',
  'create table',
  'create policy',
  'default privileges',
] as const;
export type DynamicSqlKeyword = (typeof DYNAMIC_SQL_KEYWORDS)[number];

/** A `DO` block: its body cannot be modelled. */
export interface DynamicSql extends Base {
  readonly kind: 'DynamicSql';
  readonly language: string | null;
  readonly body: string;
  /** Which of `DYNAMIC_SQL_KEYWORDS` the body mentions; PARSE002 fires when non-empty. */
  readonly mentions: readonly DynamicSqlKeyword[];
  /** Publications the body alters, creates or drops; separate from `mentions` (engine only). */
  readonly publicationMentions: readonly PublicationMention[];
}

/** A statement the parser rejected (PARSE001). It is skipped. */
export interface Unparseable extends Base {
  readonly kind: 'Unparseable';
  /** The parser's message, with the error's line and column. */
  readonly message: string;
}

/** A valid statement the replay model does not need (SELECT, CREATE INDEX, GRANT on functions ...). */
export interface Unknown extends Base {
  readonly kind: 'Unknown';
  /** The parser's node type, e.g. `CreateFunctionStmt`. */
  readonly nodeType: string;
  /** Why a statement of a handled family is not modelled, e.g. `object type OBJECT_FUNCTION`. */
  readonly detail: string | null;
}

export type Statement =
  | CreateRelation
  | CreateSequence
  | RenameObject
  | SetSchema
  | DropObjects
  | Grant
  | AlterDefaultPrivileges
  | CreatePolicy
  | AlterPolicy
  | RenamePolicy
  | DropPolicy
  | SetRole
  | AlterTableRowSecurity
  | EventTrigger
  | FunctionDefinition
  | DropFunctions
  | FunctionCall
  | Publication
  | DynamicSql
  | Unparseable
  | Unknown;

export type StatementKind = Statement['kind'];
