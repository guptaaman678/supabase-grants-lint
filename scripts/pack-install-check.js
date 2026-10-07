// Packaging check (T6.1): packs the built package with `npm pack`, installs the tarball into a
// throwaway project (not a symlink to `src/` or `dist/`), and runs the installed CLI against the
// `clean` and `errors` e2e fixtures to confirm exit codes and file allowlist, then imports
// `supabase-grants-lint/engine` from the installed copy and replays the `errors` fixture. Needs `dist/`
// (`npm run build` first). Runs on Node 22 and 24 in CI (see `.github/workflows/ci.yml`).
//
//   node scripts/pack-install-check.js
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const allowed = new Set([
  'dist/',
  'schema/',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'package.json',
]);

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'grants-lint-pack-'));
try {
  const packOut = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', tmp],
    { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } },
  );
  // `npm pack` re-runs the `prepare` lifecycle script even with --ignore-scripts, printing its
  // own build output before the JSON array; match the array by shape rather than by position.
  const jsonMatch = /\[\s*\{[\s\S]*\}\s*\]/.exec(packOut);
  if (!jsonMatch) fail(`could not find JSON array in npm pack output:\n${packOut}`);
  const [packInfo] = JSON.parse(jsonMatch[0]);
  const packedPath = path.join(tmp, packInfo.filename);
  if (!existsSync(packedPath)) fail(`tarball not found at ${packedPath}`);

  const entries = packInfo.files.map((f) => f.path);
  const extra = entries.filter(
    (p) => !allowed.has(p) && ![...allowed].some((a) => a.endsWith('/') && p.startsWith(a)),
  );
  if (extra.length > 0) fail(`tarball contains disallowed entries: ${extra.join(', ')}`);
  process.stdout.write(
    `pack: ${entries.length} entries, ${packInfo.size} bytes packed, ${packInfo.unpackedSize} bytes unpacked\n`,
  );

  execFileSync('npm', ['init', '-y'], { cwd: tmp });
  execFileSync('npm', ['--prefix', tmp, 'install', packedPath]);

  const binPath = path.join(tmp, 'node_modules', 'supabase-grants-lint', 'dist', 'cli', 'index.js');
  if (!existsSync(binPath)) fail(`installed CLI not found at ${binPath}`);

  const clean = path.join(root, 'test', 'e2e', 'projects', 'clean');
  const errors = path.join(root, 'test', 'e2e', 'projects', 'errors');

  const cleanResult = execFileSync('node', [binPath, 'check', '--dir', clean], {
    encoding: 'utf8',
  });
  if (!/0 errors, 0 warnings/.test(cleanResult))
    fail(`clean fixture: unexpected output: ${cleanResult}`);

  let errorsExit = 0;
  try {
    execFileSync('node', [binPath, 'check', '--dir', errors], { encoding: 'utf8' });
  } catch (e) {
    errorsExit = e.status;
  }
  if (errorsExit !== 1) fail(`errors fixture: expected exit 1, got ${errorsExit}`);

  // The engine export resolves through `exports["./engine"]`, with its types, and replays.
  const types = path.join(tmp, 'node_modules', 'supabase-grants-lint', 'dist', 'engine.d.ts');
  if (!existsSync(types)) fail(`engine types not found at ${types}`);
  const probe = path.join(tmp, 'engine-probe.mjs');
  writeFileSync(
    probe,
    [
      "import { replayProject, version } from 'supabase-grants-lint/engine';",
      'const snapshot = await replayProject({ projectDir: process.argv[2] });',
      'console.log(JSON.stringify({ version, snapshotVersion: snapshot.snapshotVersion,',
      '  relations: snapshot.relations.length, files: snapshot.meta.files }));',
    ].join('\n'),
  );
  const engineOut = JSON.parse(execFileSync('node', [probe, errors], { encoding: 'utf8' }));
  const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (
    engineOut.version !== pkgVersion ||
    engineOut.snapshotVersion !== 1 ||
    engineOut.relations < 1 ||
    engineOut.files < 1
  ) {
    fail(`engine export: unexpected snapshot summary ${JSON.stringify(engineOut)}`);
  }

  process.stdout.write(
    `PASS: tarball allowlisted, installed, clean fixture 0/0, errors fixture exit 1, ` +
      `engine export replayed ${engineOut.relations} relations from ${engineOut.files} files ` +
      `(node ${process.version})\n`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
