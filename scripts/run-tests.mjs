/**
 * Zero-dependency test runner.
 *
 * Compiles `tests/` + the pure `lib/` modules to CommonJS with the TypeScript
 * that is already in devDependencies, links the `@/*` path alias so the compiled
 * output resolves the same specifiers the source uses, then hands the result to
 * `node --test`. No vitest/jest download, no config drift with Next.
 *
 *   npm test              # build + run
 *   npm test -- --no-build
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.tsc-test');
const skipBuild = process.argv.includes('--no-build');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

if (!skipBuild) {
  fs.rmSync(outDir, { recursive: true, force: true });
  run('npx', ['tsc', '-p', 'tsconfig.test.json']);

  // Make `@/lib/...` resolvable from the compiled tree: node_modules/@ is a link
  // back to the compile root, so require('@/lib/llm/json') → .tsc-test/lib/llm/json.js
  const nm = path.join(outDir, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  const link = path.join(nm, '@');
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync('..', link, 'dir');
}

const testsDir = path.join(outDir, 'tests');
if (!fs.existsSync(testsDir)) {
  console.error(`No compiled tests at ${testsDir}. Drop --no-build to compile first.`);
  process.exit(1);
}

const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.posix.join('.tsc-test/tests', f));

if (!files.length) {
  console.error('No compiled tests found.');
  process.exit(1);
}

run(process.execPath, ['--test', ...files]);
