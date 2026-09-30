/**
 * GL003 dead-policy (spec §6.2): an RLS policy created or altered in an enforced file for a client
 * role that, at the end of that file, holds no privilege the policy's command needs. Postgres
 * checks table privileges before RLS, so the role's requests fail with 42501 and the policy is
 * access control that never applies. A policy on a relation the replay has not seen created is
 * reported at warn level: the table was probably created outside the migrations, or by a later
 * file (then the message names it, since a replay fails at the policy). A policy that only admits
 * `service_role` (ADR-012) is not client access control and is not checked for grants.
 */
import { DML_PRIVILEGES, type Grantee, PUBLIC } from '../model/acl.js';
import { isServiceRoleOnly, type Policy } from '../model/relations.js';
import { grantSql, quoteIdent } from '../fix/sql.js';
import type { SourceLocation } from '../parse/ir.js';
import { qualified } from '../replay/context.js';
import type { FileReplay } from '../replay/engine.js';
import { isCheckedPolicyRole, rolesBehind } from './client-roles.js';
import type { Rule, RuleContext, RuleFinding } from './types.js';

/** The privileges that let a role use the policy: its command, or any DML privilege for `ALL`. */
function needed(policy: Policy): readonly string[] {
  return policy.command === 'all' ? DML_PRIVILEGES : [policy.command];
}

/** The policy statement in this file: its CREATE, or the ALTER when it was created earlier. */
function anchor(policy: Policy, file: FileReplay): SourceLocation {
  // `file.policies` holds policies created or altered in the file, so one of the two is in it.
  return policy.altered !== null && !file.sources.includes(policy.created.file)
    ? policy.altered
    : policy.created;
}

/** The first file after `file` that creates the policy's relation, if any. */
function createdLater(policy: Policy, file: FileReplay, ctx: RuleContext): string | undefined {
  const name = qualified(policy.relation);
  return ctx.files
    .slice(file.index + 1)
    .find((later) => later.created.some((relation) => qualified(relation) === name))?.file;
}

function unknownRelation(policy: Policy, file: FileReplay, ctx: RuleContext): RuleFinding {
  const name = qualified(policy.relation);
  const later = createdLater(policy, file, ctx);
  return {
    at: anchor(policy, file),
    message:
      later === undefined
        ? `Policy ${quoteIdent(policy.name)} is on ${name}, which no migration creates (it was ` +
          'probably created outside the migrations, for example in the dashboard), so its grants ' +
          'cannot be checked. Create the table in a migration, or add an ignore entry if it is ' +
          'managed elsewhere.'
        : `Policy ${quoteIdent(policy.name)} is on ${name}, which is only created later, in ` +
          `${later}: this file replays first, so replaying the migrations (supabase db reset, a ` +
          'preview branch) fails here, and its grants cannot be checked. Rename the files so the ' +
          'table is created first.',
    relation: policy.relation,
    severity: 'warn',
  };
}

function deadPolicy(policy: Policy, role: Grantee, file: FileReplay): RuleFinding {
  const all = policy.command === 'all';
  const privilege = all ? 'select, insert, update or delete' : policy.command;
  const holder =
    role === PUBLIC
      ? `PUBLIC, but neither anon nor authenticated holds any ${privilege} privilege on it`
      : `${role}, but ${role} holds no ${privilege} privilege on it`;
  const grantees = rolesBehind(role);
  return {
    at: anchor(policy, file),
    message:
      `Policy ${quoteIdent(policy.name)} on ${qualified(policy.relation)} is for ` +
      `${all ? 'every command' : policy.command} by ${holder}: Postgres checks privileges before ` +
      'RLS, so the policy never applies and those requests fail with 42501 permission denied. ' +
      `Grant ${grantees.join(' and ')} the privilege in the same migration, or drop the policy.`,
    relation: policy.relation,
    role,
    ...(all ? {} : { privilege: policy.command }),
    fix: grantSql({ privileges: needed(policy), relation: policy.relation, grantees }),
  };
}

export const GL003: Rule = {
  id: 'GL003',
  name: 'dead-policy',
  defaultSeverity: 'error',
  docs: 'An RLS policy is for a client role that lacks the privilege its command needs, so the policy never applies.',
  check(ctx) {
    return ctx.enforced.flatMap((file) =>
      file.policies.flatMap((policy): RuleFinding[] => {
        const relation = file.after.relation(policy.relation);
        if (relation === undefined) return [unknownRelation(policy, file, ctx)];
        if (ctx.isServiceOnly(relation) || isServiceRoleOnly(policy)) return [];
        return policy.roles
          .filter((role) => isCheckedPolicyRole(ctx, role))
          .filter(
            (role) =>
              !rolesBehind(role).some((r) => needed(policy).some((p) => relation.acl.holds(r, p))),
          )
          .map((role) => deadPolicy(policy, role, file));
      }),
    );
  },
};
