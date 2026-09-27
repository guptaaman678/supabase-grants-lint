import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { Io } from '../../src/cli/io.js';
import { run } from '../../src/cli/main.js';
import { COMMAND_USAGE, usage } from '../../src/cli/usage.js';

function fakeIo(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: process.cwd(),
    env,
    isTTY: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('diff command', () => {
  it('is listed in --help and prints its own help', async () => {
    expect(usage()).toContain(
      '  diff      compare the migrations with a live database (read-only)',
    );
    for (const flag of ['--help', '-h']) {
      const { io, stdout } = fakeIo();
      expect(await run(['diff', flag], io)).toBe(ExitCode.Ok);
      expect(stdout()).toBe(COMMAND_USAGE.diff);
    }
    expect(COMMAND_USAGE.doctor).toContain('--db-url <url>');
  });

  it.each([
    [[], {}, 'diff needs a database: pass --db-url <postgres-url> or set SUPABASE_DB_URL.'],
    [[], { SUPABASE_DB_URL: '' }, 'diff needs a database'],
    [['--db-url', 'mysql://u:hunter2@h/d'], {}, '--db-url must start with postgres://'],
    [[], { SUPABASE_DB_URL: 'hunter2' }, 'SUPABASE_DB_URL is not a valid URL'],
    [['postgres://u:hunter2@h/d'], {}, 'diff takes no arguments. Pass the database with'],
    [['--format', 'xml', '--db-url', 'postgres://h/d'], {}, 'Option --format must be one of'],
    [['--strict-parse'], {}, 'Unknown option --strict-parse for diff.'],
    [['--db-url'], {}, 'Option --db-url needs a value.'],
  ])('exits 2 for %j with env %j, never echoing a password', async (args, env, message) => {
    const { io, stdout, stderr } = fakeIo(env);
    expect(await run(['diff', ...args], io)).toBe(ExitCode.Usage);
    expect(stdout()).toBe('');
    expect(stderr()).toContain(message);
    expect(stderr()).not.toContain('hunter2');
  });

  it('checks the doctor URL the same way', async () => {
    const { io, stderr } = fakeIo({ SUPABASE_DB_URL: 'https://u:hunter2@h/' });
    expect(await run(['doctor'], io)).toBe(ExitCode.Usage);
    expect(stderr()).toContain('SUPABASE_DB_URL must start with postgres://');
    expect(stderr()).not.toContain('hunter2');
  });
});
