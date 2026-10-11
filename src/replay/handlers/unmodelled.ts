/**
 * Statements the replay cannot model (spec §6.1). A `DO` block whose body mentions grants, tables,
 * policies or default privileges, or drops, alters or renames a relation (ADR-019 item 3), is
 * recorded for PARSE002; an unparseable statement for PARSE001. Both are skipped, and the replay
 * continues.
 */
import { type DynamicSql, RELATION_CHANGE_KEYWORDS, type Unparseable } from '../../parse/ir.js';
import { locate, type ReplayContext } from '../context.js';

const CHANGES: readonly string[] = RELATION_CHANGE_KEYWORDS;

export function dynamicSql(stmt: DynamicSql, ctx: ReplayContext): void {
  if (stmt.mentions.length === 0) return;
  const consequences = [
    ...(stmt.mentions.some((k) => !CHANGES.includes(k))
      ? ['any grants, tables or policies it creates are not checked']
      : []),
    ...(stmt.mentions.some((k) => CHANGES.includes(k))
      ? ['any relation it drops, alters or renames stays in the replay as it was before the block']
      : []),
  ];
  ctx.events.push({
    kind: 'skipped',
    at: locate(stmt),
    reason: 'dynamic-sql',
    message:
      `DO block not modelled; it mentions ${stmt.mentions.join(', ')}. The replay does not run ` +
      `it, so ${consequences.join(', and ')}`,
  });
}

export function unparseable(stmt: Unparseable, ctx: ReplayContext): void {
  ctx.events.push({
    kind: 'skipped',
    at: locate(stmt),
    reason: 'unparseable',
    message: stmt.message,
  });
}
