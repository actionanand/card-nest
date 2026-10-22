import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isApplicationChange(path) {
  if (path === 'src/app/core/app-version.ts' || /\.(spec|test)\.[cm]?[jt]s$/.test(path)) {
    return false;
  }
  return (
    /^(src\/|public\/|native\/|scripts\/(?:patch-android|capacitor-sync-))/.test(path) ||
    /^(?:angular\.json|capacitor\.config\.[jt]s|package(?:-lock)?\.json|tsconfig[^/]*\.json|\.nvmrc)$/.test(
      path,
    )
  );
}

export function shouldIncrementVersion(eventName, ref, changedFiles) {
  return (
    eventName === 'push' &&
    ref === 'refs/heads/main-android' &&
    changedFiles.some(isApplicationChange)
  );
}

export function planRelease(
  env = process.env,
  git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
) {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main-android') {
    return { build: true, previousVersionCode: 0 };
  }

  const remoteSha = git('ls-remote', '--exit-code', 'origin', env.GITHUB_REF).split(/\s+/)[0];
  if (remoteSha !== env.GITHUB_SHA) {
    console.log('Skipping an outdated or already persisted release push.');
    return { build: false, previousVersionCode: 0 };
  }

  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  // Compare with the last persisted artifacts, not just the last push: queued
  // application changes must survive a newer documentation-only push.
  const lastRelease = git(
    'log',
    '-1',
    '--first-parent',
    '--format=%H',
    '--fixed-strings',
    '--author=github-actions[bot]',
    '--grep=build: add CardNest Android ',
    env.GITHUB_SHA,
    '--',
    'releases/',
  );
  const baseline = lastRelease || (/^0+$/.test(event.before) ? '' : event.before);
  const changedFiles = (
    baseline
      ? git('diff', '--name-only', baseline, env.GITHUB_SHA)
      : git('ls-tree', '-r', '--name-only', env.GITHUB_SHA)
  ).split('\n');
  const previousVersionCode = baseline
    ? JSON.parse(git('show', `${baseline}:android-version.json`)).versionCode
    : 0;
  return {
    build: shouldIncrementVersion(env.GITHUB_EVENT_NAME, env.GITHUB_REF, changedFiles),
    previousVersionCode,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = planRelease();
  console.log(`Android release plan: ${JSON.stringify(plan)}`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `build=${plan.build}\nprevious-version-code=${plan.previousVersionCode}\n`,
  );
}
