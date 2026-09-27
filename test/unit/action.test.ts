import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const actionYml = readFileSync(new URL('../../action.yml', import.meta.url), 'utf8');

// The top-level description, written as one quoted line so its length is exactly what
// GitHub Marketplace sees (a folded `>-` block would need a YAML parser to measure).
function topLevelDescription(): string {
  const quoted = /^description: '((?:[^']|'')*)'$/m.exec(actionYml)?.[1];
  if (quoted === undefined) {
    throw new Error('action.yml needs a single-line quoted top-level description');
  }
  return quoted.replaceAll("''", "'");
}

describe('action.yml', () => {
  it('keeps the description within the GitHub Marketplace limit of 125 characters', () => {
    const description = topLevelDescription();
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(125);
  });

  it('says it is not affiliated with Supabase and uses no em dash', () => {
    const description = topLevelDescription();
    expect(description).toContain('Not affiliated with Supabase');
    expect(description).not.toContain(String.fromCharCode(0x2014));
  });

  it('pins every action it uses to a full commit SHA', () => {
    const uses = [...actionYml.matchAll(/^\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/@[0-9a-f]{40}$/);
  });
});
