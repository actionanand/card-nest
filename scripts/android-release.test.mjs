import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { verifyPackages } from './verify-android-release.mjs';

const workflow = readFileSync('.github/workflows/android-build.yml', 'utf8');
const bumpScript = resolve('scripts/bump-android-version.js');
const releaseCondition =
  "if: github.event_name == 'push' && github.ref == 'refs/heads/main-android'";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cardnest-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function stepBlock(name) {
  const start = workflow.indexOf(`      - name: ${name}`);
  assert.ok(start >= 0, name);
  const next = workflow.indexOf('\n      - ', start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
}

test('bump script increments 48 to 49 once and preserves versionName and app version', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'src/app/core'), { recursive: true });
  writeFileSync(
    join(root, 'android-version.json'),
    JSON.stringify({ versionCode: 48, versionName: '1.1.9' }),
  );
  execFileSync(process.execPath, [bumpScript], { cwd: root });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'android-version.json'), 'utf8')), {
    versionCode: 49,
    versionName: '1.1.9',
  });
  assert.match(
    readFileSync(join(root, 'src/app/core/app-version.ts'), 'utf8'),
    /APP_VERSION = '1\.1\.9'/,
  );
});

test('invalid stored versionCode fails without writing version metadata', (t) => {
  const root = fixture(t);
  const metadata = '{"versionCode":"invalid","versionName":"1.1.9"}';
  writeFileSync(join(root, 'android-version.json'), metadata);
  assert.throws(() => execFileSync(process.execPath, [bumpScript], { cwd: root, stdio: 'pipe' }));
  assert.equal(readFileSync(join(root, 'android-version.json'), 'utf8'), metadata);
});

const packageOptions = {
  apk: 'release.apk',
  aab: 'release.aab',
  aapt: '/sdk/aapt',
  bundletool: '/tmp/bundletool.jar',
  version: { versionCode: 49, versionName: '1.1.9' },
};

function packageReader({ apkCode = 49, aabCode = 49, apkName = '1.1.9', aabName = '1.1.9' } = {}) {
  return (command, args) => {
    if (command === '/sdk/aapt') {
      assert.deepEqual(args, ['dump', 'badging', 'release.apk']);
      return `package: name='com.actionanand.cardnest.app' versionCode='${apkCode}' versionName='${apkName}'`;
    }
    assert.equal(command, 'java');
    assert.deepEqual(args.slice(0, 5), [
      '-jar',
      '/tmp/bundletool.jar',
      'dump',
      'manifest',
      '--bundle=release.aab',
    ]);
    return args.at(-1).endsWith(':versionCode') ? String(aabCode) : aabName;
  };
}

test('package verification reads both binary manifests, not filenames', () => {
  verifyPackages(packageOptions, packageReader());
  for (const mismatch of [
    { apkCode: 48 },
    { aabCode: 48 },
    { apkName: '1.1.8' },
    { aabName: '1.1.8' },
  ]) {
    assert.throws(() => verifyPackages(packageOptions, packageReader(mismatch)), /mismatch/);
  }
  assert.throws(() => verifyPackages(packageOptions, () => ''), /mismatch/);
});

test('every ordinary main-android push bumps exactly once, with no eligibility filtering', () => {
  assert.equal(workflow.match(/bump-android-version\.js/g)?.length, 1);
  assert.ok(stepBlock('Bump release versionCode once').includes(releaseCondition));
  assert.match(
    workflow,
    /on:\n  workflow_dispatch:\n  push:\n    branches: \[main-android\]\n    tags: \['v\*'\]/,
  );
  assert.doesNotMatch(
    workflow,
    /needs:|steps\.plan|scripts\/android-release\.mjs|release-request|eligibility/,
  );
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\njobs:')), /paths(-ignore)?:/);
  assert.equal(workflow.match(/^  [a-z-]+:\n    name:/gm)?.length, 1);
  assert.doesNotMatch(stepBlock('Bump release versionCode once'), /--(patch|minor|major)/);
});

test('bump runs before the shared APK/AAB build and persistence follows verification', () => {
  const position = (name) => workflow.indexOf(`      - name: ${name}`);
  const bump = position('Bump release versionCode once');
  const readVersion = position('Read Android version');
  const build = position('Build release APK and AAB');
  const verify = position('Verify embedded APK and AAB versions');
  const commit = position('Commit version metadata and artifacts');
  const upload = position('Upload Android artifacts');
  assert.ok(
    bump > 0 &&
      bump < readVersion &&
      readVersion < build &&
      build < verify &&
      verify < commit &&
      commit < upload,
  );
  assert.match(workflow, /assembleRelease\s+bundleRelease/);
  assert.equal(workflow.match(/"-PversionCode=\$VERSION_CODE"/g)?.length, 1);
});

test('only signed main-android push builds persist version metadata and artifacts', () => {
  const guard = stepBlock('Require signed artifacts for automatic releases');
  const commit = stepBlock('Commit version metadata and artifacts to main-android');
  assert.ok(guard.includes(releaseCondition));
  assert.ok(commit.includes(releaseCondition));
  assert.match(commit, /git add android-version\.json src\/app\/core\/app-version\.ts releases\//);
  assert.match(commit, /\[skip ci\]/);
  assert.match(commit, /if \[\[ "\$REMOTE_SHA" != "\$GITHUB_SHA" \]\]/);
  assert.match(commit, /git push origin HEAD:refs\/heads\/main-android/);
  assert.doesNotMatch(workflow, /git pull|--force|--rebase/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('a concurrent source push rejects artifact publication without rebasing', (t) => {
  const root = fixture(t);
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  const builder = join(root, 'builder');
  const git = (cwd, ...args) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Release test',
        GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
        GIT_COMMITTER_NAME: 'Release test',
        GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
      },
    }).trim();
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main-android', source);
  writeFileSync(join(source, 'README.md'), 'source used for the build');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'Source');
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', 'origin', 'HEAD:refs/heads/main-android');
  git(root, 'clone', '--branch', 'main-android', remote, builder);
  writeFileSync(join(builder, 'artifact.txt'), 'built from the old source');
  git(builder, 'add', '.');
  git(builder, 'commit', '-m', 'Generated artifacts');

  writeFileSync(join(source, 'README.md'), 'newer source');
  git(source, 'commit', '-am', 'Newer source');
  git(source, 'push', 'origin', 'HEAD:refs/heads/main-android');
  assert.throws(() => git(builder, 'push', 'origin', 'HEAD:refs/heads/main-android'));
  assert.equal(
    git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/main-android'),
    git(source, 'rev-parse', 'HEAD'),
  );
});

test('debug and non-release workflows never bump versions', () => {
  const debugWorkflow = readFileSync('.github/workflows/android-sms-test.yml', 'utf8');
  assert.doesNotMatch(debugWorkflow, /bump-android-version|git push/);
  assert.doesNotMatch(
    readFileSync('.github/workflows/gh-pages.yml', 'utf8'),
    /bump-android-version/,
  );
});
