import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const moduleDirectory = fileURLToPath(new URL('../../spacetimedb/', import.meta.url));
const runner = fileURLToPath(new URL('../../spacetimedb/node_modules/vitest/vitest.mjs', import.meta.url));
if (!existsSync(runner)) {
  throw new Error('Install the server test dependencies first: npm ci --prefix ../spacetimedb');
}
const result = spawnSync(process.execPath, [runner, 'run', 'src/tests/bot-benchmark.test.ts'], {
  cwd: moduleDirectory,
  stdio: 'inherit',
  env: {
    ...process.env,
    BOT_BENCHMARK: '1',
    BOT_CAPITAL_ALLOWANCE: process.env.BOT_CAPITAL_ALLOWANCE ?? '1',
    BOT_BENCHMARK_REPORT: process.env.BOT_BENCHMARK_REPORT ?? fileURLToPath(new URL('../benchmark-results.json', import.meta.url)),
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
