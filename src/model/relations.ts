/**
 * The catalog the replay builds and every rule reads: tracked relations, sequences, policies and
 * default privileges (spec §6.1), plus row level security, event triggers and notes, which only the
 * engine export reads. A `Catalog` is immutable; every change returns a new one. The
 * value the replay holds at the end of a file is therefore that file's snapshot: later statements
 * produce new catalogs and cannot change it.
 *
 * The catalog records state only. Which schemas are in scope, how names resolve and what a
 * statement means are the replay engine's job; what counts as a problem is the rules'.
 */
import type { AutoRlsMode } from '../config/defaults.js';
import type {
  EventTriggerState,
  PolicyCommand,
  PolicyPredicate,
  RelationKind,
  SourceLocation,
} from '../parse/ir.js';
import { Acl, type Grantee } from './acl.js';
import { DefaultPrivileges } from './defaults.js';

/** A schema-qualified name, already resolved. */
export interface RelationName {
  readonly schema: string;
  readonly name: string;
}

/** Row level security of a relation. grants-lint's rules do not read it; the engine export does. */
export interface RowSecurity {
  readonly enabled: boolean;
  readonly forced: boolean;
  /** Why `enabled` has its value: the `CREATE` default, an `ALTER TABLE`, or automatic RLS. */
  readonly source: 'default' | 'statement' | 'auto-rls';
  /** The statement, or the trigger or function that made automatic RLS apply; `null` otherwise. */
  readonly at: SourceLocation | null;
}

export const RLS_OFF: RowSecurity = Object.freeze({
  enabled: false,
  forced: false,
  source: 'default',
  at: null,
});

export interface Relation extends RelationName {
  readonly kind: RelationKind;
  readonly acl: Acl;
  /** The CREATE statement, or `null` for a relation the replay did not see created. */
  readonly created: SourceLocation | null;
  readonly rls: RowSecurity;
}

export interface EventTriggerDefinition {
  readonly name: string;
  readonly event: string;
  /** `WHEN TAG IN (...)` as written, or `null` for every tag. */
  readonly tags: readonly string[] | null;
  readonly function: RelationName;
  readonly state: EventTriggerState;
  readonly created: SourceLocation;
}

/** The function Supabase's automatic RLS template creates (and a pulled baseline keeps). */
export const AUTO_RLS_FUNCTION: RelationName = Object.freeze({
  schema: 'public',
  name: 'rls_auto_enable',
});

/**
 * Supabase's automatic RLS trigger, by Studio's own test: named `ensure_rls` or calling a function
 * named `rls_auto_enable`, on `ddl_command_end`, for every tag or for `CREATE TABLE` among them,
 * and firing in normal operation (enabled, or enabled always). Its body is not read.
 */
export function isAutoRlsTrigger(trigger: EventTriggerDefinition): boolean {
  return (
    (trigger.name === 'ensure_rls' || trigger.function.name === AUTO_RLS_FUNCTION.name) &&
    trigger.event === 'ddl_command_end' &&
    (trigger.tags === null || trigger.tags.some((tag) => tag.toUpperCase() === 'CREATE TABLE')) &&
    (trigger.state === 'O' || trigger.state === 'A')
  );
}

/** Something the replay saw but could not apply, kept for the engine export. */
export interface EngineNote {
  readonly code: string;
  readonly message: string;
  readonly at: SourceLocation;
}

export interface Sequence extends RelationName {
  readonly acl: Acl;
  readonly created: SourceLocation | null;
  /** The serial column that owns it; the sequence is dropped with its table. */
  readonly ownedBy: { readonly relation: RelationName; readonly column: string } | null;
}

/** A sequence created for a serial column. */
export interface OwnedSequence extends Sequence {
  readonly ownedBy: NonNullable<Sequence['ownedBy']>;
}

export interface Policy {
  readonly name: string;
  readonly relation: RelationName;
  readonly command: PolicyCommand;
  readonly roles: readonly Grantee[];
  readonly permissive: boolean;
  /** The current `USING` expression, or `null` when the policy has none. */
  readonly using: PolicyPredicate | null;
  /** The current `WITH CHECK` expression, or `null` when the policy has none. */
  readonly withCheck: PolicyPredicate | null;
  readonly created: SourceLocation;
  /** The latest `ALTER POLICY`, or `null` if never altered. */
  readonly altered: SourceLocation | null;
}

/**
 * A policy whose every `USING` / `WITH CHECK` expression only tests for `service_role` (ADR-012)
 * or is the constant `false` (ADR-019) never admits a client role, and `service_role` bypasses
 * RLS, so it is not client access control.
 */
export function admitsNoClient(policy: Pick<Policy, 'using' | 'withCheck'>): boolean {
  const predicates = [policy.using, policy.withCheck].filter((p) => p !== null);
  return predicates.length > 0 && predicates.every((p) => p === 'service_role' || p === 'false');
}

function key({ schema, name }: RelationName): string {
  return JSON.stringify([schema, name]);
}

function sameName(a: RelationName, b: RelationName): boolean {
  return a.schema === b.schema && a.name === b.name;
}

interface State {
  readonly defaults: DefaultPrivileges;
  readonly relations: ReadonlyMap<string, Relation>;
  readonly sequences: ReadonlyMap<string, Sequence>;
  /** Keyed by relation, then policy name. Policies may exist on relations the catalog does not track. */
  readonly policies: ReadonlyMap<string, ReadonlyMap<string, Policy>>;
  readonly eventTriggers: ReadonlyMap<string, EventTriggerDefinition>;
  readonly autoRlsMode: AutoRlsMode;
  /** Where `public.rls_auto_enable()` returning `event_trigger` was defined, while it exists. */
  readonly autoRlsFunction: SourceLocation | null;
  readonly notes: readonly EngineNote[];
}

export class Catalog {
  readonly #state: State;

  private constructor(state: State) {
    this.#state = state;
  }

  static create(
    defaults: DefaultPrivileges = DefaultPrivileges.EMPTY,
    autoRlsMode: AutoRlsMode = 'auto',
  ): Catalog {
    return new Catalog({
      defaults,
      relations: new Map(),
      sequences: new Map(),
      policies: new Map(),
      eventTriggers: new Map(),
      autoRlsMode,
      autoRlsFunction: null,
      notes: [],
    });
  }

  get defaults(): DefaultPrivileges {
    return this.#state.defaults;
  }

  get autoRlsMode(): AutoRlsMode {
    return this.#state.autoRlsMode;
  }

  get autoRlsFunction(): SourceLocation | null {
    return this.#state.autoRlsFunction;
  }

  /**
   * Whether a table created now in `public` starts with RLS on, and why: `'start'` under
   * `autoRls: "on"`; else (unless `"off"`) the first enabled automatic RLS trigger; else, under
   * `"auto"`, the `rls_auto_enable` function; `null` when it does not apply.
   */
  autoRls(): SourceLocation | 'start' | null {
    switch (this.#state.autoRlsMode) {
      case 'off':
        return null;
      case 'on':
        return 'start';
      case 'auto':
        return this.eventTriggers().find(isAutoRlsTrigger)?.created ?? this.#state.autoRlsFunction;
    }
  }

  eventTrigger(name: string): EventTriggerDefinition | undefined {
    return this.#state.eventTriggers.get(name);
  }

  /** Event triggers, in creation order. */
  eventTriggers(): readonly EventTriggerDefinition[] {
    return [...this.#state.eventTriggers.values()];
  }

  notes(): readonly EngineNote[] {
    return this.#state.notes;
  }

  relation(name: RelationName): Relation | undefined {
    return this.#state.relations.get(key(name));
  }

  /** Tracked relations, in creation order. */
  relations(): readonly Relation[] {
    return [...this.#state.relations.values()];
  }

  sequence(name: RelationName): Sequence | undefined {
    return this.#state.sequences.get(key(name));
  }

  sequences(): readonly Sequence[] {
    return [...this.#state.sequences.values()];
  }

  /** Sequences owned by serial columns of `relation`. */
  ownedSequences(relation: RelationName): readonly OwnedSequence[] {
    return this.sequences().filter(
      (s): s is OwnedSequence => s.ownedBy !== null && sameName(s.ownedBy.relation, relation),
    );
  }

  policy(relation: RelationName, name: string): Policy | undefined {
    return this.#state.policies.get(key(relation))?.get(name);
  }

  policiesOn(relation: RelationName): readonly Policy[] {
    return [...(this.#state.policies.get(key(relation))?.values() ?? [])];
  }

  /** Every policy, including those on relations the catalog does not track. */
  policies(): readonly Policy[] {
    return [...this.#state.policies.values()].flatMap((byName) => [...byName.values()]);
  }

  withDefaults(defaults: DefaultPrivileges): Catalog {
    return new Catalog({ ...this.#state, defaults });
  }

  /** Adds a relation whose ACL is `creator`'s default table privileges in its schema. */
  createRelation(
    name: RelationName,
    kind: RelationKind,
    creator: string,
    created: SourceLocation | null,
    rls: RowSecurity = RLS_OFF,
  ): Catalog {
    const k = key(name);
    if (this.#state.relations.has(k)) throw new Error(`relation ${k} is already tracked`);
    const acl = this.defaults.effective(creator, name.schema, 'table');
    const relations = new Map(this.#state.relations);
    relations.set(
      k,
      Object.freeze({ schema: name.schema, name: name.name, kind, acl, created, rls }),
    );
    return new Catalog({ ...this.#state, relations });
  }

  setRelationRls(name: RelationName, rls: RowSecurity): Catalog {
    const k = key(name);
    const relation = this.#state.relations.get(k);
    if (relation === undefined) throw new Error(`relation ${k} is not tracked`);
    const relations = new Map(this.#state.relations);
    relations.set(k, Object.freeze({ ...relation, rls: Object.freeze({ ...rls }) }));
    return new Catalog({ ...this.#state, relations });
  }

  /** Adds an event trigger, or replaces the one with the same name. */
  putEventTrigger(trigger: EventTriggerDefinition): Catalog {
    const eventTriggers = new Map(this.#state.eventTriggers);
    eventTriggers.set(trigger.name, Object.freeze({ ...trigger }));
    return new Catalog({ ...this.#state, eventTriggers });
  }

  dropEventTrigger(name: string): Catalog {
    const eventTriggers = new Map(this.#state.eventTriggers);
    eventTriggers.delete(name);
    return new Catalog({ ...this.#state, eventTriggers });
  }

  withAutoRlsFunction(at: SourceLocation | null): Catalog {
    return new Catalog({ ...this.#state, autoRlsFunction: at });
  }

  addNote(note: EngineNote): Catalog {
    return new Catalog({ ...this.#state, notes: [...this.#state.notes, Object.freeze(note)] });
  }

  /** Adds a sequence whose ACL is `creator`'s default sequence privileges in its schema. */
  createSequence(
    name: RelationName,
    creator: string,
    created: SourceLocation | null,
    ownedBy: Sequence['ownedBy'] = null,
  ): Catalog {
    const k = key(name);
    if (this.#state.sequences.has(k)) throw new Error(`sequence ${k} is already tracked`);
    const acl = this.defaults.effective(creator, name.schema, 'sequence');
    const sequences = new Map(this.#state.sequences);
    sequences.set(
      k,
      Object.freeze({ schema: name.schema, name: name.name, acl, created, ownedBy }),
    );
    return new Catalog({ ...this.#state, sequences });
  }

  setRelationAcl(name: RelationName, acl: Acl): Catalog {
    const k = key(name);
    const relation = this.#state.relations.get(k);
    if (relation === undefined) throw new Error(`relation ${k} is not tracked`);
    const relations = new Map(this.#state.relations);
    relations.set(k, Object.freeze({ ...relation, acl }));
    return new Catalog({ ...this.#state, relations });
  }

  setSequenceAcl(name: RelationName, acl: Acl): Catalog {
    const k = key(name);
    const sequence = this.#state.sequences.get(k);
    if (sequence === undefined) throw new Error(`sequence ${k} is not tracked`);
    const sequences = new Map(this.#state.sequences);
    sequences.set(k, Object.freeze({ ...sequence, acl }));
    return new Catalog({ ...this.#state, sequences });
  }

  /** Removes the relation (if tracked), its policies and the sequences its serial columns own. */
  dropRelation(name: RelationName): Catalog {
    const relations = new Map(this.#state.relations);
    relations.delete(key(name));
    const sequences = new Map(
      [...this.#state.sequences].filter(
        ([, s]) => s.ownedBy === null || !sameName(s.ownedBy.relation, name),
      ),
    );
    const policies = new Map(this.#state.policies);
    policies.delete(key(name));
    return new Catalog({ ...this.#state, relations, sequences, policies });
  }

  dropSequence(name: RelationName): Catalog {
    const sequences = new Map(this.#state.sequences);
    sequences.delete(key(name));
    return new Catalog({ ...this.#state, sequences });
  }

  /**
   * `RENAME TO` or `SET SCHEMA`: the ACL, the `created` marker and the policies move with the
   * relation. Owned sequences follow their table: they keep their name, and move with it to a new
   * schema, as Postgres does.
   */
  moveRelation(from: RelationName, to: RelationName): Catalog {
    const fromKey = key(from);
    const toKey = key(to);
    if (this.#state.relations.has(toKey)) throw new Error(`relation ${toKey} is already tracked`);
    const relations = new Map(this.#state.relations);
    const relation = relations.get(fromKey);
    if (relation !== undefined) {
      relations.delete(fromKey);
      relations.set(toKey, Object.freeze({ ...relation, schema: to.schema, name: to.name }));
    }
    const sequences = new Map<string, Sequence>();
    for (const [k, s] of this.#state.sequences) {
      if (s.ownedBy === null || !sameName(s.ownedBy.relation, from)) {
        sequences.set(k, s);
        continue;
      }
      const moved = Object.freeze({
        ...s,
        schema: to.schema,
        ownedBy: Object.freeze({ relation: Object.freeze({ ...to }), column: s.ownedBy.column }),
      });
      sequences.set(key(moved), moved);
    }
    const policies = new Map(this.#state.policies);
    const moving = policies.get(fromKey);
    if (moving !== undefined) {
      policies.delete(fromKey);
      policies.set(
        toKey,
        new Map(
          [...moving].map(([n, p]) => [
            n,
            Object.freeze({ ...p, relation: Object.freeze({ ...to }) }),
          ]),
        ),
      );
    }
    return new Catalog({ ...this.#state, relations, sequences, policies });
  }

  /** `ALTER SEQUENCE ... RENAME TO | SET SCHEMA`; ownership is kept. */
  moveSequence(from: RelationName, to: RelationName): Catalog {
    const toKey = key(to);
    if (this.#state.sequences.has(toKey)) throw new Error(`sequence ${toKey} is already tracked`);
    const sequence = this.#state.sequences.get(key(from));
    if (sequence === undefined) return this;
    const sequences = new Map(this.#state.sequences);
    sequences.delete(key(from));
    sequences.set(toKey, Object.freeze({ ...sequence, schema: to.schema, name: to.name }));
    return new Catalog({ ...this.#state, sequences });
  }

  /** Adds a policy, or replaces the one with the same name on the same relation. */
  putPolicy(policy: Policy): Catalog {
    const k = key(policy.relation);
    const policies = new Map(this.#state.policies);
    const byName = new Map(policies.get(k));
    byName.set(
      policy.name,
      Object.freeze({
        ...policy,
        relation: Object.freeze({ schema: policy.relation.schema, name: policy.relation.name }),
        roles: Object.freeze([...policy.roles]),
      }),
    );
    policies.set(k, byName);
    return new Catalog({ ...this.#state, policies });
  }

  dropPolicy(relation: RelationName, name: string): Catalog {
    const k = key(relation);
    const policies = new Map(this.#state.policies);
    const byName = new Map(policies.get(k));
    byName.delete(name);
    if (byName.size > 0) policies.set(k, byName);
    else policies.delete(k);
    return new Catalog({ ...this.#state, policies });
  }
}
