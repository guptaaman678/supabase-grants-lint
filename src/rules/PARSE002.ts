/**
 * PARSE002 dynamic-sql-skipped (spec §6.1, §6.2): a `DO` block whose body mentions `grant`,
 * `revoke`, `create table`, `create policy` or `default privileges`, or (ADR-019 item 3) `drop
 * table`, `drop view`, `drop materialized view`, `alter table` or `rename`. The replay cannot run
 * it, so what it does to grants and relations is not modelled. Info; every file is checked,
 * enforced or not.
 */
import type { Rule, RuleFinding } from './types.js';

export const PARSE002: Rule = {
  id: 'PARSE002',
  name: 'dynamic-sql-skipped',
  defaultSeverity: 'info',
  docs: 'A DO block that mentions grants, tables, policies or default privileges was skipped.',
  check(ctx) {
    return ctx.files.flatMap((file) =>
      file.events.flatMap((event): RuleFinding[] =>
        event.kind === 'skipped' && event.reason === 'dynamic-sql'
          ? [
              {
                at: event.at,
                message:
                  `${event.message}. Move those statements out of the block, or suppress this ` +
                  'with a reason.',
              },
            ]
          : [],
      ),
    );
  },
};
