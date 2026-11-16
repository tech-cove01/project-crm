/** Launch one purpose-built CRM-026 process using its hash-bound private environment. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT } from './crm024-fixtures.mjs';
import { confirmFullWorker, loadMemoryEnvironment } from './crm026-memory-environment.mjs';

const platformNames = new Set(['path', 'systemroot', 'systemdrive', 'windir', 'userprofile', 'localappdata', 'appdata',
  'temp', 'tmp', 'comspec', 'pathext', 'processor_architecture', 'number_of_processors', 'home', 'https_proxy', 'http_proxy', 'no_proxy']);

async function main([type, phase, fixtureHash, profilesHash, ...extra]) {
  assert(!extra.length && ['web', 'worker'].includes(type) && ['memory', 'generalization'].includes(phase), 'crm026_launch_arguments');
  let c;
  if (phase === 'memory') {
    c = await loadMemoryEnvironment(fixtureHash, { profilesHash });
    if (type === 'worker') await confirmFullWorker(c);
  } else {
    const { loadGeneralizationEnvironment, confirmGeneralizationWorker } = await import('./crm026-generalization-environment.mjs');
    c = await loadGeneralizationEnvironment(fixtureHash, { profilesHash });
    if (type === 'worker') await confirmGeneralizationWorker(c);
  }
  assert(new URL(c.env.SUPABASE_DB_URL).port === '55532' && new URL(c.env.NEXT_PUBLIC_SUPABASE_URL).port === '55531' &&
    c.env.INTERNAL_AGENT_RUN_STUB === 'false' && c.env.HEALTH_HOST === '127.0.0.1' && c.env.SENTRY_DSN === 'off',
  'crm026_launch_environment_scope');
  const args = type === 'web'
    ? ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3415']
    : ['node_modules/tsx/dist/cli.mjs', 'workers/agent-worker/main.ts'];
  const platform = Object.fromEntries(Object.entries(process.env).filter(([name]) => platformNames.has(name.toLowerCase())));
  const env = { ...platform, ...c.env, ...(type === 'web' ? { __NEXT_PROCESSED_ENV: 'true' } : {}) };
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
  child.on('spawn', () => console.info(JSON.stringify({ phase, type, pid: child.pid })));
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  console.error(/^[a-z0-9_]{1,110}$/.test(error?.message ?? '') ? error.message : 'crm026_launch_failed');
  process.exitCode = 1;
});
