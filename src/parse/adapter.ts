import {
  type AccessPriv,
  type AlterDefaultPrivilegesStmt,
  type GrantStmt,
  loadModule,
  type Node,
  type ObjectType,
  parseSync,
  type RangeVar,
  type RawStmt,
  type RoleSpec,
  type ScanToken,
  type SelectStmt,
  scanSync,
} from 'libpg-query';
import {
  DYNAMIC_SQL_KEYWORDS,
  type DynamicSqlKeyword,
  type EventTriggerState,
  type ObjectKind,
  type PolicyCommand,
  type PolicyPredicate,
  type Privilege,
  type PublicationMention,
  type PublicationObjects,
  type QualifiedName,
  type RoleRef,
  type RowSecurityAction,
  SERIAL_TYPES,
  type SerialColumn,
  type SerialType,
  type SourceLocation,
  type Statement,
} from './ir.js';
import {
  scanSuppressions,
  type SqlComment,
  type Suppression,
  type SuppressionProblem,
} from './suppressions.js';

export interface ParsedFile {
  readonly file: string;
  /** Every statement in source order, including `Unparseable` and `Unknown` ones. */
  readonly statements: Statement[];
  readonly suppressions: Suppression[];
  readonly suppressionProblems: SuppressionProblem[];
}

export interface MigrationParser {
  /** Parses one migration. `file` is the path used in locations. Never throws on bad SQL. */
  parse(source: string, file: string): ParsedFile;
}

let ready: Promise<void> | undefined;

/** Loads the Postgres parser (WASM) once. */
export async function loadParser(): Promise<MigrationParser> {
  ready ??= loadModule();
  await ready;
  return { parse: parseMigration };
}

// ---------------------------------------------------------------------------------------------
// Locations. The parser reports UTF-8 byte offsets (ADR-005); findings need line and column.

/** Maps UTF-8 byte offsets of one source to 1-based line and column (UTF-16 code units). */
export class LineIndex {
  private readonly lineStarts: number[] = [0];

  constructor(readonly bytes: Buffer) {
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0a) this.lineStarts.push(i + 1);
    }
  }

  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  position(offset: number): { line: number; column: number } {
    const line = this.lineOf(offset);
    const start = this.lineStarts[line - 1] ?? 0;
    return { line, column: this.bytes.toString('utf8', start, offset).length + 1 };
  }

  text(start: number, end: number): string {
    return this.bytes.toString('utf8', start, end);
  }
}

/** Byte offset of the `codePoints`-th code point of `text` (the parser's error cursor unit). */
export function codePointToByteOffset(text: string, codePoints: number): number {
  let bytes = 0;
  let seen = 0;
  for (const char of text) {
    if (seen === codePoints) break;
    bytes += Buffer.byteLength(char);
    seen++;
  }
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// Parsing with statement-level recovery.

interface RawPiece {
  readonly stmt: RawStmt;
  /** Byte offset of the piece within the file. */
  readonly base: number;
  /** Byte offset where the piece ends (a statement with no length runs to here). */
  readonly end: number;
}

interface Failure {
  readonly start: number;
  readonly end: number;
  readonly message: string;
  /** Byte offset of the error in the file, when the parser gave one. */
  readonly errorAt: number | null;
}

function errorDetails(
  error: unknown,
  text: string,
  base: number,
): { message: string; errorAt: number | null } {
  const message = error instanceof Error ? error.message : String(error);
  const cursor = (error as { sqlDetails?: { cursorPosition?: number } }).sqlDetails?.cursorPosition;
  return {
    message,
    errorAt: typeof cursor === 'number' ? base + codePointToByteOffset(text, cursor) : null,
  };
}

function isComment(token: ScanToken): boolean {
  return token.tokenName === 'SQL_COMMENT' || token.tokenName === 'C_COMMENT';
}

function scanTokens(text: string): ScanToken[] | null {
  try {
    return scanSync(text).tokens;
  } catch {
    // The scanner fails on unterminated literals and comments.
    return null;
  }
}

/**
 * ADR-005 point 5: parse the whole file; if that fails, split it on top-level `;` tokens
 * (dollar-quoted bodies are single tokens) and parse each piece, so one bad statement does
 * not hide the rest of the file.
 */
function parsePieces(
  index: LineIndex,
  text: string,
  tokens: ScanToken[] | null,
): { pieces: RawPiece[]; failures: Failure[] } {
  // The parser rejects empty input ("Query cannot be empty") but accepts whitespace.
  if (text === '') return { pieces: [], failures: [] };
  try {
    const end = index.bytes.length;
    return {
      pieces: (parseSync(text).stmts ?? []).map((stmt) => ({ stmt, base: 0, end })),
      failures: [],
    };
  } catch (error) {
    if (tokens === null) {
      // Not even the scanner can split the file (an unterminated literal or comment).
      const { message, errorAt } = errorDetails(error, text, 0);
      const start = errorAt ?? 0;
      return { pieces: [], failures: [{ start, end: index.bytes.length, message, errorAt }] };
    }
  }

  const pieces: RawPiece[] = [];
  const failures: Failure[] = [];
  let group: ScanToken[] = [];
  const flush = (end: number): void => {
    const first = group.find((token) => !isComment(token));
    group = [];
    if (first === undefined) return;
    const pieceText = index.text(first.start, end);
    try {
      for (const stmt of parseSync(pieceText).stmts ?? []) {
        pieces.push({ stmt, base: first.start, end });
      }
    } catch (error) {
      failures.push({ start: first.start, end, ...errorDetails(error, pieceText, first.start) });
    }
  };
  for (const token of tokens) {
    if (token.text === ';') {
      flush(token.start);
      continue;
    }
    group.push(token);
  }
  flush(index.bytes.length);
  return { pieces, failures };
}

function commentsOf(
  tokens: ScanToken[] | null,
  text: string,
  index: LineIndex,
  file: string,
): SqlComment[] {
  if (tokens !== null) {
    return tokens.filter(isComment).map((token) => ({
      file,
      ...index.position(token.start),
      endLine: index.lineOf(Math.max(token.start, token.end - 1)),
      text: token.text,
    }));
  }
  // The scanner failed (the file is a PARSE001 anyway): fall back to whole-line `--` comments.
  const comments: SqlComment[] = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('--')) return;
    comments.push({
      file,
      line: i + 1,
      column: line.length - trimmed.length + 1,
      endLine: i + 1,
      text: trimmed.trimEnd(),
    });
  });
  return comments;
}

function parseMigration(source: string, file: string): ParsedFile {
  // A UTF-8 byte order mark is not SQL; dropping it keeps line 1 columns right.
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const index = new LineIndex(Buffer.from(text, 'utf8'));
  const tokens = scanTokens(text);
  const { pieces, failures } = parsePieces(index, text, tokens);

  const located: { start: number; statement: Statement }[] = [];
  for (const { stmt, base, end: pieceEnd } of pieces) {
    // ADR-005 point 3: an absent location is 0, an absent or zero length runs to the end.
    const start = base + (stmt.stmt_location ?? 0);
    const end = stmt.stmt_len ? start + stmt.stmt_len : pieceEnd;
    const at = { file, ...index.position(start), text: index.text(start, end).trimEnd() };
    located.push({
      start,
      statement: stmt.stmt === undefined ? unknown(at, 'RawStmt') : toStatement(stmt.stmt, at),
    });
  }
  for (const failure of failures) {
    const at = {
      file,
      ...index.position(failure.start),
      text: index.text(failure.start, failure.end).trim(),
    };
    const where = failure.errorAt === null ? null : index.position(failure.errorAt);
    const message =
      where === null
        ? failure.message
        : `${failure.message} (line ${String(where.line)}, column ${String(where.column)})`;
    located.push({ start: failure.start, statement: { kind: 'Unparseable', ...at, message } });
  }
  located.sort((a, b) => a.start - b.start);

  const { suppressions, problems } = scanSuppressions(commentsOf(tokens, text, index, file));
  return {
    file,
    statements: located.map((entry) => entry.statement),
    suppressions,
    suppressionProblems: problems,
  };
}

// ---------------------------------------------------------------------------------------------
// AST to IR.

type At = SourceLocation & { readonly text: string };

function unknown(at: At, nodeType: string, detail: string | null = null): Statement {
  return { kind: 'Unknown', ...at, nodeType, detail };
}

function nodeTypeOf(node: Node): string {
  return Object.keys(node)[0] ?? 'Node';
}

function qualified(rv: RangeVar | undefined): QualifiedName {
  return { schema: rv?.schemaname ?? null, name: rv?.relname ?? '' };
}

/** A `List` of `String` nodes (`DROP` targets), e.g. `[schema, name]` or `[schema, table, policy]`. */
function stringList(node: Node | undefined): string[] {
  if (node === undefined) return [];
  if ('List' in node) return (node.List.items ?? []).flatMap(stringList);
  if ('String' in node) return [node.String.sval ?? ''];
  return [];
}

function nameFromParts(parts: readonly string[]): QualifiedName {
  const name = parts[parts.length - 1] ?? '';
  return { schema: parts.length > 1 ? (parts[parts.length - 2] ?? null) : null, name };
}

function roleRef(spec: RoleSpec): RoleRef {
  switch (spec.roletype) {
    case 'ROLESPEC_PUBLIC':
      return { kind: 'public' };
    case 'ROLESPEC_CURRENT_USER':
      return { kind: 'current_user' };
    case 'ROLESPEC_CURRENT_ROLE':
      return { kind: 'current_role' };
    case 'ROLESPEC_SESSION_USER':
      return { kind: 'session_user' };
    default:
      return { kind: 'role', name: spec.rolename ?? '' };
  }
}

function roleRefs(nodes: Node[] | undefined): RoleRef[] {
  return (nodes ?? []).flatMap((node) => ('RoleSpec' in node ? [roleRef(node.RoleSpec)] : []));
}

function privileges(nodes: Node[] | undefined): Privilege[] {
  // An absent privilege list is `ALL [PRIVILEGES]`.
  if (nodes === undefined || nodes.length === 0) return [{ name: 'all', columns: null }];
  return nodes.flatMap((node) => {
    if (!('AccessPriv' in node)) return [];
    const priv: AccessPriv = node.AccessPriv;
    const columns = priv.cols === undefined ? null : priv.cols.flatMap(stringList);
    return [{ name: priv.priv_name ?? 'all', columns }];
  });
}

const OBJECT_KINDS: Partial<Record<ObjectType, ObjectKind>> = {
  OBJECT_TABLE: 'table',
  OBJECT_VIEW: 'view',
  OBJECT_MATVIEW: 'materialized view',
  OBJECT_FOREIGN_TABLE: 'foreign table',
  OBJECT_SEQUENCE: 'sequence',
};

const ROW_SECURITY_SUBTYPES: Partial<Record<string, RowSecurityAction>> = {
  AT_EnableRowSecurity: 'enable',
  AT_DisableRowSecurity: 'disable',
  AT_ForceRowSecurity: 'force',
  AT_NoForceRowSecurity: 'no-force',
};

/** `pg_event_trigger.evtenabled`: `ENABLE` is `O`, so anything unrecognised reads as enabled. */
function eventTriggerState(tgenabled: string | undefined): EventTriggerState {
  return tgenabled === 'R' || tgenabled === 'A' || tgenabled === 'D' ? tgenabled : 'O';
}

function serialColumns(elements: Node[] | undefined): SerialColumn[] {
  const columns: SerialColumn[] = [];
  for (const element of elements ?? []) {
    if (!('ColumnDef' in element)) continue;
    const def = element.ColumnDef;
    const names = def.typeName?.names ?? [];
    // Postgres only expands an unqualified, non-array serial type name.
    if (names.length !== 1 || def.typeName?.arrayBounds !== undefined || def.typeName?.pct_type) {
      continue;
    }
    const typeName = stringList(names[0])[0] ?? '';
    if ((SERIAL_TYPES as readonly string[]).includes(typeName)) {
      columns.push({ column: def.colname ?? '', type: typeName as SerialType });
    }
  }
  return columns;
}

const KEYWORD_PATTERNS: Record<DynamicSqlKeyword, RegExp> = {
  grant: /\bgrant\b/i,
  revoke: /\brevoke\b/i,
  'create table': /\bcreate\s+(?:(?:global|local|temp|temporary|unlogged)\s+)*table\b/i,
  'create policy': /\bcreate\s+policy\b/i,
  'default privileges': /\bdefault\s+privileges\b/i,
};

export function dynamicSqlMentions(body: string): DynamicSqlKeyword[] {
  return DYNAMIC_SQL_KEYWORDS.filter((keyword) => KEYWORD_PATTERNS[keyword].test(body));
}

const PUBLICATION_VERB = /\b(?:alter|create|drop)\s+publication\s+(?:if\s+exists\s+)?/gi;
const QUOTED_NAME = /^"((?:[^"]|"")+)"/;
const PLAIN_NAME = /^[a-z_\u0080-￿][a-z0-9_$\u0080-￿]*/i;
/** What may follow a literal name: anything else (`%`, `' ||`) means the name is built at run time. */
const NAME_END = /^(?:$|[\s;,)]|'(?!\s*\|\|))/;

/**
 * The publications a body the replay does not interpret alters, creates or drops (ADR-015): the
 * name after `ALTER | CREATE | DROP PUBLICATION [IF EXISTS]`, case-insensitive, quoted or not, and
 * a comma list after it. A name built at run time (`%I` in `format()`, `' || name`) yields `'*'`.
 */
export function publicationMentions(body: string): PublicationMention[] {
  const found = new Set<PublicationMention>();
  for (const match of body.matchAll(PUBLICATION_VERB)) {
    let rest = body.slice(match.index + match[0].length);
    for (;;) {
      const quoted = QUOTED_NAME.exec(rest);
      const plain = quoted === null ? PLAIN_NAME.exec(rest) : null;
      const written = quoted ?? plain;
      if (written === null || !NAME_END.test(rest.slice(written[0].length))) {
        found.add('*');
        break;
      }
      found.add(
        quoted === null ? written[0].toLowerCase() : (quoted[1] ?? '').replaceAll('""', '"'),
      );
      rest = rest.slice(written[0].length);
      const comma = /^\s*,\s*/.exec(rest);
      if (comma === null) break;
      rest = rest.slice(comma[0].length);
    }
  }
  return [...found];
}

/** The tables and schemas of a publication statement; row filters and column lists are dropped. */
function publicationObjects(nodes: Node[] | undefined): PublicationObjects {
  const tables: QualifiedName[] = [];
  const schemas: (string | null)[] = [];
  for (const node of nodes ?? []) {
    if (!('PublicationObjSpec' in node)) continue;
    const spec = node.PublicationObjSpec;
    switch (spec.pubobjtype) {
      case 'PUBLICATIONOBJ_TABLE':
        tables.push(qualified(spec.pubtable?.relation));
        break;
      case 'PUBLICATIONOBJ_TABLES_IN_SCHEMA':
        schemas.push(spec.name ?? '');
        break;
      case 'PUBLICATIONOBJ_TABLES_IN_CUR_SCHEMA':
        schemas.push(null);
        break;
    }
  }
  return { tables, schemas };
}

const PUBLICATION_OPS: Partial<Record<string, 'add' | 'drop' | 'set'>> = {
  AP_AddObjects: 'add',
  AP_DropObjects: 'drop',
  AP_SetObjects: 'set',
};

/** The functions a top-level `SELECT f(), g()` calls, or `null` when it is any other query. */
function selectedFunctions(stmt: SelectStmt): QualifiedName[] | null {
  const targets = stmt.targetList ?? [];
  // `VALUES` has no targets; `SELECT ... INTO` creates a table.
  if (targets.length === 0 || stmt.fromClause !== undefined || stmt.intoClause !== undefined) {
    return null;
  }
  const functions: QualifiedName[] = [];
  for (const target of targets) {
    const value = 'ResTarget' in target ? target.ResTarget.val : undefined;
    if (value === undefined || !('FuncCall' in value)) return null;
    functions.push(nameFromParts((value.FuncCall.funcname ?? []).flatMap(stringList)));
  }
  return functions;
}

function grantStatement(grant: GrantStmt, at: At): Statement {
  const objectKind =
    grant.objtype === 'OBJECT_TABLE'
      ? 'table'
      : grant.objtype === 'OBJECT_SEQUENCE'
        ? 'sequence'
        : null;
  if (objectKind === null || grant.targtype === 'ACL_TARGET_DEFAULTS') {
    return unknown(at, 'GrantStmt', `object type ${grant.objtype ?? 'unknown'}`);
  }
  const objects = grant.objects ?? [];
  const target =
    grant.targtype === 'ACL_TARGET_ALL_IN_SCHEMA'
      ? { kind: 'allInSchema' as const, schemas: objects.flatMap(stringList) }
      : {
          kind: 'objects' as const,
          objects: objects.flatMap((node) =>
            'RangeVar' in node ? [qualified(node.RangeVar)] : [],
          ),
        };
  return {
    kind: 'Grant',
    ...at,
    action: grant.is_grant === true ? 'grant' : 'revoke',
    objectKind,
    target,
    privileges: privileges(grant.privileges),
    grantees: roleRefs(grant.grantees),
    grantOption: grant.grant_option === true,
  };
}

function defaultPrivilegesStatement(stmt: AlterDefaultPrivilegesStmt, at: At): Statement {
  const action = stmt.action ?? {};
  const objectKind =
    action.objtype === 'OBJECT_TABLE'
      ? 'table'
      : action.objtype === 'OBJECT_SEQUENCE'
        ? 'sequence'
        : null;
  if (objectKind === null) {
    return unknown(at, 'AlterDefaultPrivilegesStmt', `object type ${action.objtype ?? 'unknown'}`);
  }
  let forRoles: RoleRef[] | null = null;
  let inSchemas: string[] | null = null;
  for (const option of stmt.options ?? []) {
    if (!('DefElem' in option)) continue;
    const { defname, arg } = option.DefElem;
    const items = arg !== undefined && 'List' in arg ? (arg.List.items ?? []) : [];
    if (defname === 'roles') forRoles = roleRefs(items);
    if (defname === 'schemas') inSchemas = items.flatMap(stringList);
  }
  return {
    kind: 'AlterDefaultPrivileges',
    ...at,
    action: action.is_grant === true ? 'grant' : 'revoke',
    forRoles,
    inSchemas,
    objectKind,
    privileges: privileges(action.privileges),
    grantees: roleRefs(action.grantees),
    grantOption: action.grant_option === true,
  };
}

function policyCommand(name: string | undefined): PolicyCommand {
  return name === 'select' || name === 'insert' || name === 'update' || name === 'delete'
    ? name
    : 'all';
}

function constString(node: Node | undefined): string | null {
  if (node === undefined || !('A_Const' in node)) return null;
  return node.A_Const.sval?.sval ?? null;
}

// ---------------------------------------------------------------------------------------------
// Policy expressions that admit no client: service-role-only tests (ADR-012) and the constant
// `false` (ADR-019). The parser drops parentheses already.

/** The operands of a binary `op` expression, or `null` when `node` is anything else. */
function operands(node: Node, op: string): [Node | undefined, Node | undefined] | null {
  if (!('A_Expr' in node)) return null;
  const expr = node.A_Expr;
  const name = (expr.name ?? []).flatMap(stringList);
  if (expr.kind !== 'AEXPR_OP' || name.length !== 1 || name[0] !== op) return null;
  return [expr.lexpr, expr.rexpr];
}

/** The arguments of a call to `name` (dotted), or `null` when `node` is anything else. */
function callArgs(node: Node, name: string): Node[] | null {
  if (!('FuncCall' in node)) return null;
  const call = node.FuncCall;
  if ((call.funcname ?? []).flatMap(stringList).join('.') !== name) return null;
  return call.args ?? [];
}

/** The target of `(select <expr>)` with nothing else in the select, or `null`. */
function scalarSelect(node: Node): Node | undefined | null {
  if (!('SubLink' in node) || node.SubLink.subLinkType !== 'EXPR_SUBLINK') return null;
  const select = node.SubLink.subselect;
  if (select === undefined || !('SelectStmt' in select)) return null;
  const stmt = select.SelectStmt;
  const targets = stmt.targetList ?? [];
  const bare = Object.keys(stmt).every((key) => ['targetList', 'limitOption', 'op'].includes(key));
  const target = targets[0];
  if (!bare || targets.length !== 1 || target === undefined || !('ResTarget' in target)) {
    return null;
  }
  return target.ResTarget.val;
}

/** The operand of a cast to `type` (bare or `pg_catalog.`), or `null` when `node` is not one. */
function castOperand(node: Node, type: string): Node | null {
  if (!('TypeCast' in node)) return null;
  const { arg, typeName } = node.TypeCast;
  const names = (typeName?.names ?? []).flatMap(stringList);
  const matches =
    typeName?.arrayBounds === undefined &&
    names[names.length - 1] === type &&
    (names.length === 1 || (names.length === 2 && names[0] === 'pg_catalog'));
  return matches ? (arg ?? null) : null;
}

/** Strips casts to `text` and `(select ...)` wrappers, which do not change a compared value. */
function unwrap(node: Node | undefined): Node | undefined {
  let current = node;
  while (current !== undefined) {
    const inner = castOperand(current, 'text') ?? scalarSelect(current);
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

/** `current_setting('<name>' [, missing_ok])`. */
function isSetting(node: Node, name: string): boolean {
  const args = callArgs(node, 'current_setting');
  return args !== null && args.length <= 2 && constString(unwrap(args[0])) === name;
}

const ROLE_FUNCTIONS = ['SVFOP_CURRENT_USER', 'SVFOP_CURRENT_ROLE', 'SVFOP_SESSION_USER'];

/** An expression whose value is the role of the request, per ADR-012. */
function isRequestRole(node: Node | undefined): boolean {
  if (node === undefined) return false;
  if ('SQLValueFunction' in node) return ROLE_FUNCTIONS.includes(node.SQLValueFunction.op ?? '');
  if (callArgs(node, 'auth.role')?.length === 0) return true;
  if (isSetting(node, 'request.jwt.claim.role')) return true;
  const claim = operands(node, '->>');
  if (claim === null || constString(unwrap(claim[1])) !== 'role') return false;
  const claims = unwrap(claim[0]);
  if (claims === undefined) return false;
  if (callArgs(claims, 'auth.jwt')?.length === 0) return true;
  const setting = castOperand(claims, 'jsonb');
  return setting !== null && isSetting(setting, 'request.jwt.claims');
}

/** The constant `false`, bare or cast to `bool` (ADR-019). */
function isFalse(node: Node): boolean {
  const value = castOperand(node, 'bool') ?? node;
  return (
    'A_Const' in value && value.A_Const.boolval !== undefined && !value.A_Const.boolval.boolval
  );
}

/** Classifies a policy's `USING` or `WITH CHECK` expression; `null` when it is absent. */
export function policyPredicate(node: Node | undefined): PolicyPredicate | null {
  if (node === undefined) return null;
  if (isFalse(node)) return 'false';
  const sides = operands(node, '=');
  if (sides === null) return 'other';
  const [left, right] = [unwrap(sides[0]), unwrap(sides[1])];
  const serviceRole =
    (constString(left) === 'service_role' && isRequestRole(right)) ||
    (constString(right) === 'service_role' && isRequestRole(left));
  return serviceRole ? 'service_role' : 'other';
}

/** Maps one parsed statement to the IR. Anything not in spec §6.1 becomes `Unknown`. */
export function toStatement(node: Node, at: At): Statement {
  if ('CreateStmt' in node) {
    const stmt = node.CreateStmt;
    const parent = stmt.partbound === undefined ? undefined : stmt.inhRelations?.[0];
    return {
      kind: 'CreateRelation',
      ...at,
      relation: qualified(stmt.relation),
      relationKind: 'table',
      temporary: stmt.relation?.relpersistence === 't',
      ifNotExists: stmt.if_not_exists === true,
      orReplace: false,
      partitionOf: parent !== undefined && 'RangeVar' in parent ? qualified(parent.RangeVar) : null,
      serialColumns: serialColumns(stmt.tableElts),
    };
  }
  if ('CreateTableAsStmt' in node) {
    const stmt = node.CreateTableAsStmt;
    const rel = stmt.into?.rel;
    return {
      kind: 'CreateRelation',
      ...at,
      relation: qualified(rel),
      relationKind: stmt.objtype === 'OBJECT_MATVIEW' ? 'materialized view' : 'table',
      temporary: rel?.relpersistence === 't',
      ifNotExists: stmt.if_not_exists === true,
      orReplace: false,
      partitionOf: null,
      serialColumns: [],
    };
  }
  if ('ViewStmt' in node) {
    const stmt = node.ViewStmt;
    return {
      kind: 'CreateRelation',
      ...at,
      relation: qualified(stmt.view),
      relationKind: 'view',
      temporary: stmt.view?.relpersistence === 't',
      ifNotExists: false,
      orReplace: stmt.replace === true,
      partitionOf: null,
      serialColumns: [],
    };
  }
  if ('CreateForeignTableStmt' in node) {
    const base = node.CreateForeignTableStmt.base ?? {};
    return {
      kind: 'CreateRelation',
      ...at,
      relation: qualified(base.relation),
      relationKind: 'foreign table',
      temporary: false,
      ifNotExists: base.if_not_exists === true,
      orReplace: false,
      partitionOf: null,
      serialColumns: [],
    };
  }
  if ('CreateSeqStmt' in node) {
    const stmt = node.CreateSeqStmt;
    return {
      kind: 'CreateSequence',
      ...at,
      sequence: qualified(stmt.sequence),
      temporary: stmt.sequence?.relpersistence === 't',
      ifNotExists: stmt.if_not_exists === true,
    };
  }
  if ('RenameStmt' in node) {
    const stmt = node.RenameStmt;
    if (stmt.renameType === 'OBJECT_PUBLICATION') {
      return {
        kind: 'Publication',
        ...at,
        action: 'rename',
        name: stringList(stmt.object)[0] ?? '',
        newName: stmt.newname ?? '',
      };
    }
    if (stmt.renameType === 'OBJECT_EVENT_TRIGGER') {
      return {
        kind: 'EventTrigger',
        ...at,
        action: 'rename',
        name: stringList(stmt.object)[0] ?? '',
        newName: stmt.newname ?? '',
      };
    }
    if (stmt.renameType === 'OBJECT_POLICY') {
      return {
        kind: 'RenamePolicy',
        ...at,
        name: stmt.subname ?? '',
        relation: qualified(stmt.relation),
        newName: stmt.newname ?? '',
      };
    }
    const objectKind = stmt.renameType === undefined ? undefined : OBJECT_KINDS[stmt.renameType];
    if (objectKind === undefined || stmt.relation === undefined) {
      return unknown(at, 'RenameStmt', `object type ${stmt.renameType ?? 'unknown'}`);
    }
    return {
      kind: 'RenameObject',
      ...at,
      objectKind,
      object: qualified(stmt.relation),
      newName: stmt.newname ?? '',
      ifExists: stmt.missing_ok === true,
    };
  }
  if ('AlterObjectSchemaStmt' in node) {
    const stmt = node.AlterObjectSchemaStmt;
    const objectKind = stmt.objectType === undefined ? undefined : OBJECT_KINDS[stmt.objectType];
    if (objectKind === undefined || stmt.relation === undefined) {
      return unknown(at, 'AlterObjectSchemaStmt', `object type ${stmt.objectType ?? 'unknown'}`);
    }
    return {
      kind: 'SetSchema',
      ...at,
      objectKind,
      object: qualified(stmt.relation),
      newSchema: stmt.newschema ?? '',
      ifExists: stmt.missing_ok === true,
    };
  }
  if ('DropStmt' in node) {
    const stmt = node.DropStmt;
    const ifExists = stmt.missing_ok === true;
    if (stmt.removeType === 'OBJECT_PUBLICATION') {
      return {
        kind: 'Publication',
        ...at,
        action: 'drop',
        names: (stmt.objects ?? []).flatMap(stringList),
        ifExists,
      };
    }
    if (stmt.removeType === 'OBJECT_EVENT_TRIGGER') {
      return {
        kind: 'EventTrigger',
        ...at,
        action: 'drop',
        names: (stmt.objects ?? []).flatMap(stringList),
        ifExists,
      };
    }
    if (
      stmt.removeType === 'OBJECT_FUNCTION' ||
      stmt.removeType === 'OBJECT_PROCEDURE' ||
      stmt.removeType === 'OBJECT_ROUTINE'
    ) {
      return {
        kind: 'DropFunctions',
        ...at,
        functions: (stmt.objects ?? []).map((object) =>
          nameFromParts(
            'ObjectWithArgs' in object
              ? (object.ObjectWithArgs.objname ?? []).flatMap(stringList)
              : [],
          ),
        ),
        ifExists,
        cascade: stmt.behavior === 'DROP_CASCADE',
      };
    }
    if (stmt.removeType === 'OBJECT_POLICY') {
      // `[schema.]table.policy`: one policy per DROP POLICY statement.
      const parts = stringList(stmt.objects?.[0]);
      return {
        kind: 'DropPolicy',
        ...at,
        name: parts[parts.length - 1] ?? '',
        relation: nameFromParts(parts.slice(0, -1)),
        ifExists,
      };
    }
    const objectKind = stmt.removeType === undefined ? undefined : OBJECT_KINDS[stmt.removeType];
    if (objectKind === undefined) {
      return unknown(at, 'DropStmt', `object type ${stmt.removeType ?? 'unknown'}`);
    }
    return {
      kind: 'DropObjects',
      ...at,
      objectKind,
      objects: (stmt.objects ?? []).map((object) => nameFromParts(stringList(object))),
      ifExists,
      cascade: stmt.behavior === 'DROP_CASCADE',
    };
  }
  if ('GrantStmt' in node) return grantStatement(node.GrantStmt, at);
  if ('AlterDefaultPrivilegesStmt' in node)
    return defaultPrivilegesStatement(node.AlterDefaultPrivilegesStmt, at);
  if ('CreatePolicyStmt' in node) {
    const stmt = node.CreatePolicyStmt;
    const roles = roleRefs(stmt.roles);
    return {
      kind: 'CreatePolicy',
      ...at,
      name: stmt.policy_name ?? '',
      relation: qualified(stmt.table),
      command: policyCommand(stmt.cmd_name),
      roles: roles.length === 0 ? [{ kind: 'public' }] : roles,
      // The AST omits `permissive` when it is false (`AS RESTRICTIVE`).
      permissive: stmt.permissive === true,
      using: policyPredicate(stmt.qual),
      withCheck: policyPredicate(stmt.with_check),
    };
  }
  if ('AlterPolicyStmt' in node) {
    const stmt = node.AlterPolicyStmt;
    return {
      kind: 'AlterPolicy',
      ...at,
      name: stmt.policy_name ?? '',
      relation: qualified(stmt.table),
      roles: stmt.roles === undefined ? null : roleRefs(stmt.roles),
      using: policyPredicate(stmt.qual),
      withCheck: policyPredicate(stmt.with_check),
    };
  }
  if ('VariableSetStmt' in node) {
    const stmt = node.VariableSetStmt;
    if (stmt.name !== 'role')
      return unknown(at, 'VariableSetStmt', `setting ${stmt.name ?? 'all'}`);
    const value = stmt.kind === 'VAR_SET_VALUE' ? constString(stmt.args?.[0]) : null;
    // `SET ROLE NONE` and `SET ROLE DEFAULT` behave like `RESET ROLE`.
    return {
      kind: 'SetRole',
      ...at,
      role: value === 'none' ? null : value,
      local: stmt.is_local === true,
    };
  }
  if ('AlterTableStmt' in node) {
    const stmt = node.AlterTableStmt;
    const actions = (stmt.cmds ?? []).flatMap((cmd) => {
      const subtype = 'AlterTableCmd' in cmd ? cmd.AlterTableCmd.subtype : undefined;
      const action = subtype === undefined ? undefined : ROW_SECURITY_SUBTYPES[subtype];
      return action === undefined ? [] : [action];
    });
    if (actions.length === 0) return unknown(at, 'AlterTableStmt');
    return {
      kind: 'AlterTableRowSecurity',
      ...at,
      relation: qualified(stmt.relation),
      ifExists: stmt.missing_ok === true,
      only: stmt.relation?.inh !== true,
      actions,
    };
  }
  if ('CreateEventTrigStmt' in node) {
    const stmt = node.CreateEventTrigStmt;
    const tags = (stmt.whenclause ?? []).flatMap((when) =>
      'DefElem' in when && when.DefElem.defname === 'tag' ? stringList(when.DefElem.arg) : [],
    );
    return {
      kind: 'EventTrigger',
      ...at,
      action: 'create',
      name: stmt.trigname ?? '',
      event: stmt.eventname ?? '',
      tags: stmt.whenclause === undefined ? null : tags,
      function: nameFromParts((stmt.funcname ?? []).flatMap(stringList)),
    };
  }
  if ('AlterEventTrigStmt' in node) {
    const stmt = node.AlterEventTrigStmt;
    return {
      kind: 'EventTrigger',
      ...at,
      action: 'enable',
      name: stmt.trigname ?? '',
      state: eventTriggerState(stmt.tgenabled),
    };
  }
  if ('CreateFunctionStmt' in node) {
    const stmt = node.CreateFunctionStmt;
    const returns = (stmt.returnType?.names ?? []).flatMap(stringList);
    // `AS 'body'` (or `AS 'file', 'symbol'`); a `BEGIN ATOMIC` body cannot hold DDL.
    const body = (stmt.options ?? [])
      .flatMap((option) =>
        'DefElem' in option && option.DefElem.defname === 'as'
          ? stringList(option.DefElem.arg)
          : [],
      )
      .join('\n');
    return {
      kind: 'FunctionDefinition',
      ...at,
      name: nameFromParts((stmt.funcname ?? []).flatMap(stringList)),
      returnsEventTrigger: returns[returns.length - 1] === 'event_trigger',
      publicationMentions: publicationMentions(body),
    };
  }
  if ('CreatePublicationStmt' in node) {
    const stmt = node.CreatePublicationStmt;
    return {
      kind: 'Publication',
      ...at,
      action: 'create',
      name: stmt.pubname ?? '',
      allTables: stmt.for_all_tables === true,
      ...publicationObjects(stmt.pubobjects),
    };
  }
  if ('AlterPublicationStmt' in node) {
    const stmt = node.AlterPublicationStmt;
    const op = stmt.action === undefined ? undefined : PUBLICATION_OPS[stmt.action];
    // `SET (publish = ...)` parses as an add without objects.
    if (stmt.pubobjects === undefined || op === undefined) {
      return {
        kind: 'Publication',
        ...at,
        action: 'noop',
        name: stmt.pubname ?? '',
        change: 'options',
      };
    }
    return {
      kind: 'Publication',
      ...at,
      action: 'alter',
      name: stmt.pubname ?? '',
      op,
      ...publicationObjects(stmt.pubobjects),
    };
  }
  if ('AlterOwnerStmt' in node && node.AlterOwnerStmt.objectType === 'OBJECT_PUBLICATION') {
    return {
      kind: 'Publication',
      ...at,
      action: 'noop',
      name: stringList(node.AlterOwnerStmt.object)[0] ?? '',
      change: 'owner',
    };
  }
  if ('SelectStmt' in node) {
    const functions = selectedFunctions(node.SelectStmt);
    if (functions === null) return unknown(at, 'SelectStmt');
    return { kind: 'FunctionCall', ...at, functions };
  }
  if ('CallStmt' in node) {
    const name = (node.CallStmt.funccall?.funcname ?? []).flatMap(stringList);
    return { kind: 'FunctionCall', ...at, functions: [nameFromParts(name)] };
  }
  if ('DoStmt' in node) {
    let body = '';
    let language: string | null = null;
    for (const arg of node.DoStmt.args ?? []) {
      if (!('DefElem' in arg)) continue;
      const value = stringList(arg.DefElem.arg)[0] ?? '';
      if (arg.DefElem.defname === 'as') body = value;
      if (arg.DefElem.defname === 'language') language = value;
    }
    return {
      kind: 'DynamicSql',
      ...at,
      language,
      body,
      mentions: dynamicSqlMentions(body),
      publicationMentions: publicationMentions(body),
    };
  }
  return unknown(at, nodeTypeOf(node));
}
