/**
 * GL002 unreachable-new-relation (spec §6.2): a relation created in an enforced file with RLS
 * policies for a client role that, at the end of that file, holds no DML privilege on it. The
 * privilege check comes before RLS, so every Data API request as that role fails with 42501 and
 * the policies never run. Policies that only admit `service_role` (ADR-012) do not count.
 */
import { DML_PRIVILEGES, type Grantee, PUBLIC } from '../model/acl.js';
import { isServiceRoleOnly, type Policy } from '../model/relations.js';
import { grantSql } from '../fix/sql.js';
import { qualified } from '../replay/context.js';
import type { CreatedRelation } from '../replay/engine.js';
import { isCheckedPolicyRole, rolesBehind } from './client-roles.js';
import type { Rule, RuleFinding } from './types.js';

/** The privileges the policies cover, in `DML_PRIVILEGES` order (`ALL` covers all four). */
function covered(policies: readonly Policy[]): readonly string[] {
  const commands = new Set<string>(
    policies.flatMap((p) => (p.command === 'all' ? DML_PRIVILEGES : [p.command])),
  );
  return DML_PRIVILEGES.filter((p) => commands.has(p));
}

function finding(
  relation: CreatedRelation,
  role: Grantee,
  policies: readonly Policy[],
): RuleFinding {
  const name = qualified(relation);
  const grantees = rolesBehind(role);
  const message =
    role === PUBLIC
      ? `${name} has RLS policies for PUBLIC, but neither anon nor authenticated holds a select, ` +
        'insert, update or delete privilege on it: every Data API request fails with 42501 ' +
        'permission denied before any policy runs. Grant anon and authenticated the commands ' +
        'its policies cover in the same migration.'
      : `${name} has RLS policies for ${role}, but ${role} holds no select, insert, update or ` +
        `delete privilege on it: every Data API request as ${role} fails with 42501 permission ` +
        `denied before any policy runs. Grant ${role} the commands its policies cover in the ` +
        'same migration.';
  return {
    at: relation.created,
    message,
    relation,
    role,
    fix: grantSql({ privileges: covered(policies), relation, grantees }),
  };
}

export const GL002: Rule = {
  id: 'GL002',
  name: 'unreachable-new-relation',
  defaultSeverity: 'error',
  docs: 'A new table has RLS policies for a client role that holds no privilege on it, so its requests fail with 42501.',
  check(ctx) {
    return ctx.enforced.flatMap((file) =>
      file.created
        .filter((relation) => !ctx.isServiceOnly(relation))
        .flatMap((relation) => {
          const policies = file.policies.filter(
            (p) =>
              p.relation.schema === relation.schema &&
              p.relation.name === relation.name &&
              file.sources.includes(p.created.file) &&
              !isServiceRoleOnly(p),
          );
          const roles = [...new Set(policies.flatMap((p) => p.roles))].filter((role) =>
            isCheckedPolicyRole(ctx, role),
          );
          return roles
            .filter(
              (role) =>
                !rolesBehind(role).some((r) =>
                  DML_PRIVILEGES.some((p) => relation.acl.holds(r, p)),
                ),
            )
            .map((role) =>
              finding(
                relation,
                role,
                policies.filter((p) => p.roles.includes(role)),
              ),
            );
        }),
    );
  },
};
