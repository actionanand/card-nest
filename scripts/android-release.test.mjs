import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { isApplicationChange, planRelease, shouldIncrementVersion } from './android-release.mjs';
import { verifyPackages } from './verify-android-release.mjs';

const releaseRef = 'refs/heads/main-android';
const workflow = readFileSync('.github/workflows/android-build.yml', 'utf8');
const bumpScript = resolve('scripts/bump-android-version.js');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cardnest-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function releasePlan(
  t,
  { files = ['src/app/app.ts'], remoteSha = 'source', baseline = 'released' } = {},
) {
  const root = fixture(t);
  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ before: 'previous' }));
  const calls = [];
  const plan = planRelease(
    {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: releaseRef,
      GITHUB_SHA: 'source',
      GITHUB_EVENT_PATH: eventPath,
    },
    (...args) => {
      calls.push(args);
      switch (args[0]) {
        case 'ls-remote':
          return `${remoteSha}\t${releaseRef}`;
        case 'log':
          return baseline;
        case 'diff':
          return files.join('\n');
        case 'show':
          return JSON.stringify({ versionCode: 48, versionName: '1.1.9' });
        default:
          throw new Error(`Unexpected git command: ${args.join(' ')}`);
      }
    },
  );
  return { plan, calls };
}

test('only application pushes to main-android qualify for an increment', () => {
  assert.equal(shouldIncrementVersion('push', releaseRef, ['src/app/app.ts']), true);
  for (const ref of [
    'refs/heads/feature/sms',
    'refs/heads/main',
    'refs/heads/main-github',
    'refs/tags/v1.1.9',
  ]) {
    assert.equal(shouldIncrementVersion('push', ref, ['src/app/app.ts']), false, ref);
  }
  for (const event of ['workflow_dispatch', 'pull_request']) {
    assert.equal(shouldIncrementVersion(event, releaseRef, ['src/app/app.ts']), false, event);
  }
});

test('generated metadata/artifacts and non-application changes never request a release', () => {
  for (const file of [
    'android-version.json',
    'src/app/core/app-version.ts',
    'releases/card-nest-release-1-1-9.apk',
    'releases/card-nest-release-1-1-9.aab',
    'README.md',
    '.github/workflows/android-build.yml',
    'scripts/android-release.test.mjs',
    'src/app/app.spec.ts',
  ]) {
    assert.equal(isApplicationChange(file), false, file);
    assert.equal(shouldIncrementVersion('push', releaseRef, [file]), false, file);
  }
  for (const file of [
    'public/card-nest.png',
    'native/android/Plugin.kt',
    'package-lock.json',
    'scripts/patch-android.mjs',
    'scripts/capacitor-sync-after.mjs',
    'angular.json',
  ]) {
    assert.equal(isApplicationChange(file), true, file);
  }
});

test('release plan uses the persisted release baseline, including across coalesced pushes', (t) => {
  const { plan, calls } = releasePlan(t);
  assert.deepEqual(plan, { build: true, previousVersionCode: 48 });
  assert.ok(calls.some((args) => args.join(' ') === 'diff --name-only released source'));
  assert.ok(calls.some((args) => args.includes('--first-parent')));
  assert.ok(calls.some((args) => args.includes('--author=github-actions[bot]')));
});

test('generated release pushes do not rebuild or bump', (t) => {
  assert.equal(releasePlan(t, { files: [] }).plan.build, false);
});

test('outdated pushes and reruns after persistence stop before bumping or building', (t) => {
  const { plan, calls } = releasePlan(t, { remoteSha: 'newer-or-generated-commit' });
  assert.equal(plan.build, false);
  assert.equal(calls.length, 1);
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
  mkdirSync(join(source, 'src/app'), { recursive: true });
  mkdirSync(join(source, 'releases'));
  writeFileSync(join(source, 'src/app/app.ts'), 'previously released source');
  writeFileSync(
    join(source, 'android-version.json'),
    JSON.stringify({ versionCode: 48, versionName: '1.1.9' }),
  );
  writeFileSync(join(source, 'releases/old.aab'), 'previous release fixture');
  git(source, 'add', '.');
  git(
    source,
    'commit',
    '--author=github-actions[bot] <github-actions[bot]@users.noreply.github.com>',
    '-m',
    'build: add CardNest Android 1.1.9 (48) [skip ci]',
  );
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', 'origin', 'HEAD:refs/heads/main-android');
  writeFileSync(join(source, 'src/app/app.ts'), 'source used for the build');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'Application source');
  git(source, 'push', 'origin', 'HEAD:refs/heads/main-android');
  git(root, 'clone', '--branch', 'main-android', remote, builder);

  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ before: git(builder, 'rev-parse', 'HEAD^') }));
  const env = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: releaseRef,
    GITHUB_SHA: git(builder, 'rev-parse', 'HEAD'),
    GITHUB_EVENT_PATH: eventPath,
  };
  assert.deepEqual(
    planRelease(env, (...args) => git(builder, ...args)),
    {
      build: true,
      previousVersionCode: 48,
    },
  );

  writeFileSync(join(builder, 'artifact.txt'), 'built from the old source');
  git(builder, 'add', 'artifact.txt');
  git(builder, 'commit', '-m', 'Generated artifacts');

  // Race after the builder's SHA check but before its final push.
  writeFileSync(join(source, 'src/app/app.ts'), 'new application source');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'New application source');
  git(source, 'push', 'origin', 'HEAD:refs/heads/main-android');
  const latest = git(source, 'rev-parse', 'HEAD');
  assert.equal(planRelease(env, (...args) => git(builder, ...args)).build, false);
  assert.throws(() => git(builder, 'push', 'origin', 'HEAD:refs/heads/main-android'));
  assert.equal(git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/main-android'), latest);
});

test('manual and tag builds keep their checked-in version without mutation', () => {
  const unexpectedGit = () => {
    throw new Error('Non-release build must not inspect or mutate the release branch');
  };
  assert.equal(
    planRelease({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: releaseRef }, unexpectedGit)
      .build,
    true,
  );
  assert.equal(
    planRelease({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.1.9' }, unexpectedGit).build,
    true,
  );
});

test('bump script increments 48 to 49 once and preserves versionName and app version', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'src/app/core'), { recursive: true });
  writeFileSync(
    join(root, 'android-version.json'),
    JSON.stringify({ versionCode: 48, versionName: '1.1.9' }),
  );
  execFileSync(process.execPath, [bumpScript, '--after-version-code=48'], { cwd: root });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'android-version.json'), 'utf8')), {
    versionCode: 49,
    versionName: '1.1.9',
  });
  assert.match(
    readFileSync(join(root, 'src/app/core/app-version.ts'), 'utf8'),
    /APP_VERSION = '1\.1\.9'/,
  );

  // Incoming source must not lower a version already persisted on the release branch.
  execFileSync(process.execPath, [bumpScript, '--after-version-code=52'], { cwd: root });
  assert.equal(
    JSON.parse(readFileSync(join(root, 'android-version.json'), 'utf8')).versionCode,
    53,
  );
});

test('invalid baseline fails without writing version metadata', (t) => {
  const root = fixture(t);
  const metadata = '{"versionCode":48,"versionName":"1.1.9"}';
  writeFileSync(join(root, 'android-version.json'), metadata);
  assert.throws(() =>
    execFileSync(process.execPath, [bumpScript, '--after-version-code=invalid'], {
      cwd: root,
      stdio: 'pipe',
    }),
  );
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

test('workflow increments once before the shared APK/AAB build and persists only after verification', () => {
  assert.equal(workflow.match(/node scripts\/bump-android-version\.js/g)?.length, 1);
  const bump = workflow.indexOf('      - name: Bump release versionCode once');
  const readVersion = workflow.indexOf('      - name: Read Android version');
  const build = workflow.indexOf('      - name: Build release APK and AAB');
  const verify = workflow.indexOf('      - name: Verify embedded APK and AAB versions');
  const commit = workflow.indexOf('      - name: Commit version metadata and artifacts');
  const upload = workflow.indexOf('      - name: Upload Android artifacts');
  assert.ok(
    bump > 0 &&
      bump < readVersion &&
      readVersion < build &&
      build < verify &&
      verify < commit &&
      commit < upload,
  );
  for (const start of [bump, commit]) {
    assert.match(
      workflow.slice(start, workflow.indexOf('        run:', start)),
      /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main-android'/,
    );
  }
  assert.match(workflow, /needs: prepare\n    if: needs\.prepare\.outputs\.build == 'true'/);
  assert.match(workflow, /assembleRelease\s+bundleRelease/);
  assert.match(
    workflow,
    /git add android-version\.json src\/app\/core\/app-version\.ts releases\//,
  );
  assert.match(workflow, /if \[\[ "\$REMOTE_SHA" != "\$GITHUB_SHA" \]\]/);
  assert.match(workflow, /git push origin HEAD:refs\/heads\/main-android/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /\[skip ci\]/);
  assert.doesNotMatch(workflow, /git pull|--force/);
});

test('feature debug APK workflow never calls the version bump or release helpers', () => {
  const debugWorkflow = readFileSync('.github/workflows/android-sms-test.yml', 'utf8');
  assert.doesNotMatch(debugWorkflow, /bump-android-version|scripts\/android-release\.mjs|git push/);
});
