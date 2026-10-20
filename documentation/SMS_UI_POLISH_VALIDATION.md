# SMS UI polish validation — 20 October 2026

Implemented locally on `feature/8-android-sms-transaction-sync`, preserving baseline `e2f4ed720209f85b1321daf1649aa67101d4f0ac` and its preceding commits. No push, merge, release, production signing, application ID or version change.

## Screenshot findings and changes

The five user-supplied screenshots were inspected as visual evidence. Their personal amounts and other private content were not copied into this repository or fixtures.

| Screenshot            | Root cause and implementation                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Activity          | The platform link's inline host provided no separation from the Ledger heading. It now has a message icon, **SMS Review** label, a 44px minimum target and a block host with 20px bottom spacing. The measured gap at 320px is 20px.                                                                                                                                      |
| 2 — SMS overview      | Simplified eyebrow to **Private**. Replaced plain pagination with labeled chevrons and Page n of total; single-page navigation is hidden. Pending and other filter chips use the existing close icon and descriptive removal labels. Search occupies its own row on narrow screens.                                                                                       |
| 3 — Access disclosure | Replaced the two enable/disable buttons with a native checkbox exposed as the **SMS sync** switch. Its state requires actual granted permission AND native opt-in. Keyboard Space, focus outline, status explanation and a 48×44px input target are present.                                                                                                              |
| 4 — Scanning          | Flex children previously competed for shrinking space. The history control and paired actions now form a responsive grid. At 320px, Scan and Cancel are each 125.4×48px; history remains on its own full-width row. Busy state adds a reduced-motion-aware spinner, disables repeated Scan and keeps Cancel functional. Idle labels distinguish Scan now and Resume scan. |
| 5 — Category spending | An inline-flex button's auto margin could not create a reliable action row. Set/Edit limit now live in a dedicated padded, right-aligned flex container. Heading/description spacing is reduced; expanded and over-budget cards retain their values and progress.                                                                                                         |

The icon additions use the existing Lucide app-icon registry; no dependency was added. Candidate paging/filter SQL, transaction edits, approval, source matching and reconciliation semantics were not changed.

## Permission and switch behavior

The Transactions link passes `{ smsReviewEntry: true }` in Angular RouterLink's transient **info**, never persisted navigation state. The SMS page consumes that marker once. The service reads live native status and initiates the existing Capacitor enable flow only for `not requested` permission with request capability. Its in-session guard prevents concurrent/repeated entry requests, including a bridge failure. Persisted native permission state prevents repeat prompts after restart. Ordinary startup, direct routes, reload/history restoration, settings return and foreground refresh do not request permission.

The permission explanation appears while the native request is pending. Denied, revoked, restricted and granted-but-disabled states remain distinct. Explicitly switching ON uses the existing enable/request flow; a failed request cannot leave the input optimistically checked. Switching OFF immediately blocks Scan while native disable is pending, stops discovery through the existing native cancellation/scheduler path and preserves cursor, candidates, review decisions and imported ledger data. It does not revoke Android permissions. All financial imports still require explicit approval in the existing review dialog.

## Additional app-wide findings

- Home: intrinsic minimum grid widths clipped the credit summary at 320px. Constrained grid tracks and a stacked mobile metric layout keep complete amounts readable.
- Cards: a desktop three-column toolbar overflowed the narrow content area beside the 768px sidebar. It now stacks at the intermediate breakpoint. An inactive count badge used translucent white in dark mode; it now uses the theme surface token.
- Settings: desktop navigation/content and minimum field widths competed at tablet width. The existing stacked layout activates sooner. Invisible theme-radio inputs are bounded to 1px, preventing invisible overflow while keeping keyboard behavior.
- Transaction editor: invisible transaction-type radio inputs had the same overflow defect; their dimensions are now bounded. Entry controls and calculations are unchanged.
- Category editor: browser testing exposed focus remaining behind the popup. It now uses a native modal dialog with inert background, viewport-bounded scrolling, focus restoration after native close, and Escape/Android Back dismissal. Saving/removing limits is unchanged.
- Shared semantic colors: rendered AXE checks found insufficient muted/warning contrast in light mode and inherited light success/warning/danger colors in dark mode. Existing tokens were corrected and dark foreground overrides added. Primary button and app-bar action icon foregrounds use the contrasting theme surface. These are token corrections, not global spacing overrides.
- App bar/bottom navigation/FAB: 200% root-font simulation exposed fixed controls growing beyond their tracks. Icon targets are bounded while retaining at least 44px touch dimensions; navigation tracks can shrink and labels can wrap. SMS synchronization headings wrap at large text sizes.

## Executed results

| Check                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Angular                                                                   | **128 passed**, 16 files; 0 failed/skipped                                                                                                                                                                                                                                                                                                                                                      |
| Angular ESLint                                                            | Passed                                                                                                                                                                                                                                                                                                                                                                                          |
| Supplied synthetic corpus provenance/identifier validation                | **70 passed**                                                                                                                                                                                                                                                                                                                                                                                   |
| Kotlin/JVM tests                                                          | **123 passed**, 0 failures/errors/skips; includes every supplied corpus case and existing edge/paging/permission cases                                                                                                                                                                                                                                                                          |
| Production web build                                                      | Passed                                                                                                                                                                                                                                                                                                                                                                                          |
| Web isolation                                                             | **27 built JS files** contain no SMS route/UI/plugin/permission functionality                                                                                                                                                                                                                                                                                                                   |
| Production Android frontend + complete Capacitor sync/patch/configuration | Passed                                                                                                                                                                                                                                                                                                                                                                                          |
| Generated Android integration                                             | **7 passed**: permissions/registration, generated-source parity, idempotent generation, Back dispatcher/themes and R8 keep rules                                                                                                                                                                                                                                                                |
| Android debug APK, unsigned release APK, release AAB                      | **BUILD SUCCESSFUL**                                                                                                                                                                                                                                                                                                                                                                            |
| Android lint                                                              | 0 errors; 46 warnings, including existing intentional synchronous preference durability writes and SDK/dependency notices; no rule was suppressed                                                                                                                                                                                                                                               |
| Packaged artifacts                                                        | Exact parity with all 30 synced JS assets in each APK/AAB; compiled permission set/receiver protections, identity/version/label, debug signature, launcher branding and R8 plugin retention passed; no test corpus packaged                                                                                                                                                                     |
| Scope and privacy                                                         | Approval/reconciliation service implementation byte-identical after newline normalization; native parser/queue, database/schema/migrations, core financial code, processing scripts and codex-spec unchanged. All 70 SMS bodies retain supplied provenance; no new private SMS, financial identifiers or vehicle plates were added. Heuristics alone cannot establish arbitrary data ownership. |

The Cards stylesheet still emits the existing warning threshold (25.17kB versus 23kB warning; below the unchanged 26kB error budget). Gradle reports existing deprecations for a future Gradle 10 upgrade. These do not fail builds. No tests, expectations, budgets or lint rules were weakened.

An early pagination test failed because it inspected the UI while the constructor's asynchronous refresh was still loading. It now waits for the actual loading state to settle and retains all navigation/boundary assertions. Final runs pass. Browser testing also caught category focus restoration occurring before native close; restoration now happens after close and passes both browser and automated checks.

## Browser validation

Used an ignored, synthetic-only preview bootstrapping the **actual app shell, routes and components**, with fake native discovery and an isolated nonpersistent database/store. No real inbox or user database was accessed. Production platform guards were not changed. The preview's Android platform stub and AXE dependency are not packaged in the app.

**84 final checks:** Home, Cards, Transactions/Activity, SMS Sync, Category Spending and Settings × widths **320, 360, 375, 390, 412, 430, 768px** × **LIGHT/DARK**. Each checks rendered geometry and AXE WCAG 2 A/AA and WCAG 2.1 AA rules, including color contrast. **No measured overflow or AXE violations.** Activity is the existing Transactions route.

**12 additional checks:** native SMS review, category editor and transaction editor × 320/768px × both themes. All dialogs remain inside the viewport; rendered AXE reports zero violations. Verified category Escape focus return to Edit limit, SMS focus return to its original Review button, keyboard Space switch operation, OFF disabling Scan, busy Scan/Cancel states, and scrolling/focus containment in a 390×400px short review viewport. No approval/save was submitted in the browser fixture.

At 320px with **200% CSS root font size**, SMS and app navigation have no measured horizontal overflow or AXE violations in both themes. This is a browser simulation, not proof of Android system textZoom, TalkBack, keyboard or gesture-inset behavior.

Ignored evidence: `tmp/ui-polish-preview/final-responsive-results.json`, `modal-results.json`, `font-scale-results.json`, and screenshots in `tmp/ui-polish-preview/screenshots/`. Logs use the same ignored directory. Preview sources are `main.ts`, `tsconfig.json`, `serve.cjs`; they are intentionally not committed or bundled.

## Exact validation commands

Angular tooling uses the repository's already installed WSL Linux dependencies. The command wrapper was:

```powershell
wsl -d Ubuntu-22.04 -- bash -lc 'set -e; export PATH=/home/actionanand/.nvm/versions/node/v24.16.0/bin:/usr/bin:/bin; cd /mnt/c/AR_Files/code/card-nest; COMMAND'
```

Executed commands inside that wrapper, with logs redirected under `tmp/ui-polish-preview/`:

```sh
npx prettier --write src/app/app.scss src/app/features/cards/cards.scss src/app/features/category-spending/category-spending.html src/app/features/category-spending/category-spending.scss src/app/features/category-spending/category-spending.ts src/app/features/category-spending/category-spending.spec.ts src/app/features/dashboard/dashboard.scss src/app/features/settings/settings.scss src/app/features/sms-sync/sms-permission.service.spec.ts src/app/features/sms-sync/sms-review.service.ts src/app/features/sms-sync/sms-sync.html src/app/features/sms-sync/sms-sync.scss src/app/features/sms-sync/sms-sync.spec.ts src/app/features/sms-sync/sms-sync.ts src/app/shared/app-icon.ts src/app/shared/platform-tools.android.ts src/app/shared/platform-tools.android.spec.ts src/styles.scss
npx prettier --write src/app/features/category-spending/category-spending.ts src/app/features/category-spending/category-spending.html src/app/features/transactions/transactions.scss
npx prettier --write src/app/app.scss src/app/features/sms-sync/sms-sync.scss
npm test -- --watch=false
npm run lint
npm run test:sms:fixtures
npm run build
npm run test:web-isolation
npm run android:sync
node scripts/configure-android-sms-test.mjs
npm run test:android-isolation
node tmp/audit-sms-privacy.mjs
node tmp/ui-polish-preview/audit-scope.mjs
git diff --check
npx ng build --configuration development,android --browser tmp/ui-polish-preview/main.ts --ts-config tmp/ui-polish-preview/tsconfig.json --output-path tmp/ui-polish-preview/dist
```

`npm run android:sync` executes `npm run build:android`, `npx cap sync android` and `node scripts/patch-android.mjs`, including the documented before/after hooks. Its final log is `android-sync-final.log`; integration output is `android-isolation-final.log`. No fresh `cap add` was necessary because the existing ignored Android project was already generated. The existing test configuration script retains the established debug identity/label/version; no tracked identity, signing or naming configuration changed.

Windows commands:

```powershell
node tmp/ui-polish-preview/serve.cjs
& ./tmp/brand-sms-debug-icons.ps1
$env:JAVA_HOME=(Resolve-Path tmp/sms-tools/jdk/jdk-21.0.12.1).Path
$env:GRADLE_USER_HOME=(Resolve-Path tmp/sms-tools/gradle-cache).Path
& android/gradlew.bat -p android :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:bundleRelease :app:lintDebug --offline --console=plain
& ./tmp/verify-sms-review-artifacts.ps1
& tmp/sms-tools/android-sdk/platform-tools/adb.exe devices -l
```

The existing ignored artifact helper copies `app-debug.apk` to the established versioned name, runs `node scripts/verify-android-sms-permissions.mjs APK_PATH tmp/sms-tools/android-sdk/build-tools/36.0.0/aapt.exe`, `apksigner.bat verify --verbose --print-certs`, `tmp/inspect-sms-permission-apk.ps1`, `tmp/verify-sms-artifacts.ps1`, verifies JS byte parity in all three artifacts and checks the release R8 mapping. Its final log is `artifact-audit-final.log`; final Gradle output is `gradle-final.log`. XML unit reports and lint reports are under the standard `android/app/build/test-results/` and `android/app/build/reports/` locations.

WSL/socket/Gradle commands needed approved execution outside the filesystem sandbox. A sandbox WSL inspection returned `Wsl/E_ACCESSDENIED`; rerunning with escalation succeeded. Windows Git misinterprets the repository's pre-existing tracked reserved `NUL` filename, so final status/staging/commits use WSL Git and explicit file paths. `NUL` was not changed or staged.

## Final local artifacts

- Debug APK: `android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk` — 31,095,219 bytes; SHA-256 `4E843874BE29EC5D250243B1FF781FD61960D44A0755B1C1FF08B0696C0126F7`.
- Unsigned release APK: `android/app/build/outputs/apk/release/app-release-unsigned.apk`.
- Local release compilation AAB: `android/app/build/outputs/bundle/release/app-release.aab`.

The release results establish compilation/R8/package integrity only. They are not a signed distribution or publication. No production keystore was accessed or changed.

## Remaining physical-device checks

`adb devices -l` returned an empty list. No install, forced permission grant, storage clearing or inbox inspection was performed. Test the final APK on a physical test phone without uninstalling/clearing existing data: deliberate first Review tap, denial/permanent denial, settings revocation and return, switch off/on during a scan, resume across lock/process death/reboot/Doze, native permission dialogs, real soft keyboard/IME resize, system font scaling, safe/gesture insets and TalkBack. Confirm preserved pending reviews and approved Activity data after restart and a migrated/restored SQLite database through the actual plugin.

Existing reconciliation cautions remain unchanged: ambiguous suffixes/unreliable references require human matching; informational evidence cannot create money; historical wallet balances require explicit retained/repair/adjust choices. No new financial reconciliation behavior was introduced. Automated tests do not replace these device checks or establish Google Play restricted-permission eligibility.

## Changed files and local review

SMS UI/permission: `src/app/features/sms-sync/{sms-sync.ts,sms-sync.html,sms-sync.scss,sms-sync.spec.ts,sms-review.service.ts,sms-permission.service.spec.ts}` and `src/app/shared/{app-icon.ts,platform-tools.android.ts,platform-tools.android.spec.ts}`.

Category alignment/accessibility: `src/app/features/category-spending/{category-spending.ts,category-spending.html,category-spending.scss,category-spending.spec.ts}`. Other targeted audit fixes: `src/app/app.scss`, dashboard/cards/settings/transactions component SCSS and `src/styles.scss`. Documentation: `SMS_SYNC.md` and this audit.

Focused local implementation commits are `6aeab6e` (SMS controls/permissions) and `461ffbf` (app-wide audited layout/accessibility fixes). A separate documentation commit records this audit. Final commit SHA/status are reported with the handoff. Proposed eventual PR targets `main` from the existing feature branch: **Polish Android SMS review controls and responsive CardNest layouts**. No PR was created or pushed.
