/**
 * Which policy roles GL002 and GL003 check (spec §6.2): `anon`, `authenticated` and `PUBLIC`
 * always, plus any role listed in config `clientRoles`. A `PUBLIC` policy (no `TO` clause) is used
 * by the Data API through `anon` and `authenticated`, so their privileges decide whether it applies.
 */
import { type Grantee, PUBLIC } from '../model/acl.js';
import type { RuleContext } from './types.js';

const API_ROLE_NAMES = ['anon', 'authenticated'] as const;

/** The roles PostgREST switches to for client requests. */
export const API_CLIENT_ROLES: readonly Grantee[] = API_ROLE_NAMES;

/** The client roles a rule checks by name: `anon`, `authenticated` and config `clientRoles`. */
export function checkedClientRoles(ctx: RuleContext): readonly string[] {
  return [...new Set([...API_ROLE_NAMES, ...ctx.config.clientRoles])];
}

export function isCheckedPolicyRole(ctx: RuleContext, role: Grantee): boolean {
  return role === PUBLIC || API_CLIENT_ROLES.includes(role) || ctx.isClientRole(role);
}

/** The roles whose privileges decide whether a policy for `role` can apply. */
export function rolesBehind(role: Grantee): readonly Grantee[] {
  return role === PUBLIC ? API_CLIENT_ROLES : [role];
}

/**
 * The roles a fix grants to for a policy for `role`. A `PUBLIC` policy is fixed for
 * `authenticated` only (ADR-019 item 2): either role satisfies the rules, and a missing anon grant
 * fails loudly with 42501 while an unneeded one silently opens the table to signed-out visitors.
 */
export function rolesToGrant(role: Grantee): readonly Grantee[] {
  return role === PUBLIC ? ['authenticated'] : [role];
}
