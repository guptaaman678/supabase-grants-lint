import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { UsageError } from '../../src/errors.js';
import {
  compareMigrations,
  discoverMigrations,
  extractVersion,
  findProjectDir,
  type MigrationFile,
  toRelPath,
} from '../../src/load/discover.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'grants-lint-discover-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function touch(...relPaths: string[]): void {
  for (const rel of relPaths) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, '-- test\n');
  }
}

function names(options: Parameters<typeof discoverMigrations>[0] = {}): string[] {
  return discoverMigrations({ cwd: root, ...options }).files.map((f) => f.relPath);
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
}

function file(name: string, relPath = `m/${name}`): MigrationFile {
  return { path: `/p/${relPath}`, relPath, name, version: extractVersion(name) };
}

describe('extractVersion', () => {
  it.each([
    ['20261002120000_add_todos.sql', '20261002120000'],
    ['001_init.sql', '001'],
    ['1_a_b.sql', '1'],
    ['20261002120000.sql', null],
    ['add_todos.sql', null],
    ['123abc_todos.sql', null],
    ['_123_todos.sql', null],
    ['seed.sql', null],
  ])('%s -> %s', (name, version) => {
    expect(extractVersion(name)).toBe(version);
  });
});

describe('discoverMigrations: directory', () => {
  it('finds supabase/migrations by default and orders files by version', () => {
    touch(
      'supabase/migrations/20261002120000_add_orders.sql',
      'supabase/migrations/20261001090000_add_todos.sql',
      'supabase/migrations/20261001100000_add_profiles.sql',
    );
    expect(names()).toEqual([
      'supabase/migrations/20261001090000_add_todos.sql',
      'supabase/migrations/20261001100000_add_profiles.sql',
      'supabase/migrations/20261002120000_add_orders.sql',
    ]);
  });

  it('returns no files and no notices for an empty directory', () => {
    mkdirSync(path.join(root, 'supabase', 'migrations'), { recursive: true });
    expect(discoverMigrations({ cwd: root })).toEqual({ files: [], notices: [] });
  });

  it('throws a usage error (exit 2) naming the path when the directory is missing', () => {
    const error = catchError(() => discoverMigrations({ cwd: root }));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(ExitCode.Usage);
    expect((error as UsageError).message).toContain(
      'Migrations directory not found: supabase/migrations',
    );
    expect((error as UsageError).message).toContain('--dir');
  });

  it('ignores non-SQL files and does not descend into subdirectories', () => {
    touch(
      'supabase/migrations/20261001090000_add_todos.sql',
      'supabase/migrations/README.md',
      'supabase/migrations/20261001100000_add_orders.sql.bak',
      'supabase/migrations/20261001110000_upper.SQL',
      'supabase/migrations/.DS_Store',
      'supabase/migrations/archive/20250101000000_old.sql',
    );
    mkdirSync(path.join(root, 'supabase', 'migrations', '20261001120000_dir.sql'));
    expect(names()).toEqual(['supabase/migrations/20261001090000_add_todos.sql']);
  });

  // Creating symlinks on Windows needs extra privileges.
  it.skipIf(process.platform === 'win32')('follows symlinks to files', () => {
    touch('shared/20261001090000_add_todos.sql');
    mkdirSync(path.join(root, 'supabase', 'migrations'), { recursive: true });
    symlinkSync(
      path.join(root, 'shared', '20261001090000_add_todos.sql'),
      path.join(root, 'supabase', 'migrations', '20261001090000_add_todos.sql'),
    );
    expect(names()).toEqual(['supabase/migrations/20261001090000_add_todos.sql']);
  });

  it('sorts files without a numeric prefix after versioned ones, by name, with PARSE001 notices', () => {
    touch(
      'supabase/migrations/seed.sql',
      'supabase/migrations/20261002120000_add_orders.sql',
      'supabase/migrations/add_audit_log.sql',
      'supabase/migrations/20261001090000.sql',
      'supabase/migrations/123abc_messages.sql',
      'supabase/migrations/20261001090000_add_todos.sql',
    );
    const result = discoverMigrations({ cwd: root });
    expect(result.files.map((f) => [f.name, f.version])).toEqual([
      ['20261001090000_add_todos.sql', '20261001090000'],
      ['20261002120000_add_orders.sql', '20261002120000'],
      ['123abc_messages.sql', null],
      ['20261001090000.sql', null],
      ['add_audit_log.sql', null],
      ['seed.sql', null],
    ]);
    expect(result.notices).toEqual([
      expect.objectContaining({
        ruleId: 'PARSE001',
        file: 'supabase/migrations/123abc_messages.sql',
      }),
      expect.objectContaining({
        ruleId: 'PARSE001',
        file: 'supabase/migrations/20261001090000.sql',
      }),
      expect.objectContaining({
        ruleId: 'PARSE001',
        file: 'supabase/migrations/add_audit_log.sql',
      }),
      expect.objectContaining({ ruleId: 'PARSE001', file: 'supabase/migrations/seed.sql' }),
    ]);
    expect(result.notices[3]?.message).toBe(
      'seed.sql has no numeric version prefix (expected <version>_<name>.sql); ' +
        'it is replayed after all versioned files, in name order',
    );
  });

  it('orders mixed-length prefixes by file name, as the Supabase CLI does', () => {
    touch(
      'db/2_b.sql',
      'db/10_c.sql',
      'db/1_a.sql',
      'db/001_z.sql',
      'db/20261001090000_add_todos.sql',
    );
    expect(names({ migrations: 'db' })).toEqual([
      'db/001_z.sql',
      'db/10_c.sql',
      'db/1_a.sql',
      'db/20261001090000_add_todos.sql',
      'db/2_b.sql',
    ]);
  });

  it('resolves entries against projectDir and reports paths relative to cwd', () => {
    touch('apps/api/supabase/migrations/20261001090000_add_todos.sql');
    const [first] = discoverMigrations({ cwd: root, projectDir: 'apps/api' }).files;
    expect(first?.relPath).toBe('apps/api/supabase/migrations/20261001090000_add_todos.sql');
    expect(first?.path).toBe(
      path.join(root, 'apps', 'api', 'supabase', 'migrations', '20261001090000_add_todos.sql'),
    );
  });

  it('reports paths outside cwd with ../ segments', () => {
    touch('project/supabase/migrations/20261001090000_add_todos.sql');
    mkdirSync(path.join(root, 'elsewhere'));
    expect(
      names({ cwd: path.join(root, 'elsewhere'), projectDir: path.join(root, 'project') }),
    ).toEqual(['../project/supabase/migrations/20261001090000_add_todos.sql']);
  });

  it('treats a projectDir holding .sql files and no supabase/migrations as the migrations folder', () => {
    touch(
      'docs/migrations/002_add_orders.sql',
      'docs/migrations/001_add_todos.sql',
      'docs/migrations/README.md',
      'docs/migrations/old/003_skipped.sql',
    );
    expect(names({ projectDir: 'docs/migrations' })).toEqual([
      'docs/migrations/001_add_todos.sql',
      'docs/migrations/002_add_orders.sql',
    ]);
  });

  it('prefers supabase/migrations inside projectDir over .sql files beside it', () => {
    touch('app/seed.sql', 'app/supabase/migrations/20261001090000_add_todos.sql');
    expect(names({ projectDir: 'app' })).toEqual([
      'app/supabase/migrations/20261001090000_add_todos.sql',
    ]);
  });

  it('treats the working directory holding .sql files as the migrations folder (T9.8)', () => {
    touch('002_add_orders.sql', '001_add_todos.sql', 'notes.txt');
    for (const options of [{}, { projectDir: '.' }, { projectDir: root }]) {
      expect(names(options)).toEqual(['001_add_todos.sql', '002_add_orders.sql']);
    }
  });

  it('never falls back to the folder when migrations is configured', () => {
    touch('db/001_add_todos.sql');
    expect((catchError(() => names({ projectDir: 'db', migrations: 'x' })) as Error).message).toBe(
      'Migrations directory not found: db/x. Run from the project root (the folder that ' +
        'contains supabase/), or pass --dir <project or migrations folder>.',
    );
  });

  it('keeps the not-found error when projectDir holds no .sql files or does not exist', () => {
    touch('app/notes.txt', 'app/folder.sql/001_inner.sql');
    expect((catchError(() => names({ projectDir: 'app' })) as Error).message).toContain(
      'Migrations directory not found: app/supabase/migrations',
    );
    expect((catchError(() => names({ projectDir: 'gone' })) as Error).message).toContain(
      'Migrations directory not found: gone/supabase/migrations',
    );
  });

  it('accepts Windows-style separators in the config value', () => {
    touch('db\u002fmigrations/20261001090000_add_todos.sql');
    expect(names({ migrations: 'db\\migrations' })).toEqual([
      'db/migrations/20261001090000_add_todos.sql',
    ]);
    expect(names({ migrations: 'db\\migrations\\*.sql' })).toEqual([
      'db/migrations/20261001090000_add_todos.sql',
    ]);
  });
});

describe('discoverMigrations: globs and lists', () => {
  it('matches a single-directory glob and drops non-SQL matches', () => {
    touch('supabase/migrations/20261001090000_add_todos.sql', 'supabase/migrations/notes.txt');
    expect(names({ migrations: 'supabase/migrations/*' })).toEqual([
      'supabase/migrations/20261001090000_add_todos.sql',
    ]);
  });

  it('matches ** across directories, skipping node_modules', () => {
    touch(
      'db/core/20261001090000_add_todos.sql',
      'db/extra/deep/20261001100000_add_orders.sql',
      'db/20261001080000_init.sql',
      'db/node_modules/pkg/20261001070000_vendored.sql',
    );
    expect(names({ migrations: 'db/**/*.sql' })).toEqual([
      'db/20261001080000_init.sql',
      'db/core/20261001090000_add_todos.sql',
      'db/extra/deep/20261001100000_add_orders.sql',
    ]);
  });

  it('matches brace alternatives and character classes', () => {
    touch('a/1_x.sql', 'b/2_y.sql', 'c/3_z.sql');
    expect(names({ migrations: '{a,b}/*.sql' })).toEqual(['a/1_x.sql', 'b/2_y.sql']);
    expect(names({ migrations: '[bc]/?_*.sql' })).toEqual(['b/2_y.sql', 'c/3_z.sql']);
    expect(names({ migrations: '[!a]/*.sql' })).toEqual(['b/2_y.sql', 'c/3_z.sql']);
  });

  it('merges a list of directories, globs and files, without duplicates', () => {
    touch(
      'supabase/migrations/20261001090000_add_todos.sql',
      'supabase/migrations/20261003090000_add_messages.sql',
      'extra/20261002090000_add_orders.sql',
    );
    expect(
      names({
        migrations: [
          'supabase/migrations',
          'supabase/migrations/*.sql',
          'extra/20261002090000_add_orders.sql',
        ],
      }),
    ).toEqual([
      'supabase/migrations/20261001090000_add_todos.sql',
      'extra/20261002090000_add_orders.sql',
      'supabase/migrations/20261003090000_add_messages.sql',
    ]);
  });

  it('accepts an absolute glob', () => {
    touch('db/20261001090000_add_todos.sql');
    const pattern = `${path.join(root, 'db').replaceAll('\\', '/')}/*.sql`;
    expect(names({ migrations: pattern })).toEqual(['db/20261001090000_add_todos.sql']);
  });

  it.each([
    [[], '"migrations" is an empty list'],
    [[''], '"migrations" contains an empty path'],
    ['missing/*.sql', 'Migrations glob "missing/*.sql": directory missing not found'],
    ['notes.txt', 'Migrations path is not a .sql file or a directory: notes.txt'],
    ['db/{a,b/*.sql', 'Invalid glob "{a,b/*.sql": unclosed "{"'],
  ])('rejects %j with a usage error', (migrations, message) => {
    touch('notes.txt', 'db/1_a.sql');
    const error = catchError(() => discoverMigrations({ cwd: root, migrations }));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain(message);
  });
});

describe('ordering', () => {
  const ordered = [
    file('20261001090000_add_todos.sql'),
    file('20261001090000_add_todos.sql', 'n/20261001090000_add_todos.sql'),
    file('20261001100000_add_orders.sql'),
    file('add_audit_log.sql'),
    file('seed.sql'),
  ];

  it('is a total order that does not depend on input order', () => {
    const seeds = [
      [4, 3, 2, 1, 0],
      [2, 0, 4, 1, 3],
      [1, 4, 0, 3, 2],
      [3, 1, 2, 0, 4],
    ];
    for (const seed of seeds) {
      const shuffled = seed.map((i) => ordered[i] as MigrationFile);
      expect(shuffled.sort(compareMigrations)).toEqual(ordered);
    }
  });

  it('compares a versioned file before any unversioned one', () => {
    expect(compareMigrations(file('9_z.sql'), file('0.sql'))).toBe(-1);
    expect(compareMigrations(file('0.sql'), file('9_z.sql'))).toBe(1);
    expect(compareMigrations(file('1_a.sql'), file('1_a.sql'))).toBe(0);
  });
});

describe('findProjectDir (T9.8)', () => {
  const at = (rel: string) => path.join(root, ...rel.split('/'));

  it('keeps a folder that has supabase/migrations, a config or a package.json', () => {
    touch('app/supabase/migrations/001_a.sql', 'cfg/grants-lint.config.json', 'pkg/package.json');
    for (const dir of ['app', 'cfg', 'pkg']) expect(findProjectDir(at(dir))).toBe(at(dir));
  });

  it('goes up from supabase/migrations and supabase/ to the folder that contains supabase/', () => {
    touch('app/supabase/migrations/001_a.sql', 'app/supabase/seed.sql');
    expect(findProjectDir(at('app/supabase/migrations'))).toBe(at('app'));
    expect(findProjectDir(at('app/supabase'))).toBe(at('app'));
  });

  it('goes up from an empty supabase/migrations too', () => {
    mkdirSync(at('app/supabase/migrations'), { recursive: true });
    expect(findProjectDir(at('app/supabase/migrations'))).toBe(at('app'));
  });

  it('stays in a supabase/ folder without migrations, a migrations folder elsewhere, or any other folder', () => {
    touch('a/supabase/seed.sql', 'b/db/migrations/001_a.sql', 'c/x.sql');
    expect(findProjectDir(at('a/supabase'))).toBe(at('a/supabase'));
    expect(findProjectDir(at('b/db/migrations'))).toBe(at('b/db/migrations'));
    expect(findProjectDir(at('c'))).toBe(at('c'));
  });

  it('stays when supabase/migrations itself holds a config', () => {
    touch('app/supabase/migrations/001_a.sql', 'app/supabase/migrations/grants-lint.config.json');
    expect(findProjectDir(at('app/supabase/migrations'))).toBe(at('app/supabase/migrations'));
  });
});

describe('toRelPath', () => {
  it('uses / separators for Windows paths', () => {
    expect(
      toRelPath(
        'C:\\work\\app',
        'C:\\work\\app\\supabase\\migrations\\20261001090000_add_todos.sql',
        path.win32,
      ),
    ).toBe('supabase/migrations/20261001090000_add_todos.sql');
    expect(toRelPath('C:\\work\\app', 'C:\\work\\other\\1_a.sql', path.win32)).toBe(
      '../other/1_a.sql',
    );
  });

  it('keeps POSIX paths as they are', () => {
    expect(toRelPath('/work/app', '/work/app/supabase/migrations/1_a.sql', path.posix)).toBe(
      'supabase/migrations/1_a.sql',
    );
  });
});
