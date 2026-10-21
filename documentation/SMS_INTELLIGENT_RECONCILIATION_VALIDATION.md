# SMS reconciliation, meal-wallet comparison and multiple type filters

Implemented on `feature/8-android-sms-transaction-sync`, starting from local commit `5b40aba8cacc9a6e7764cea3ddd94461cc34e3cc`. No user database was opened or altered during development. Fixtures are fictional; screenshots and private SMS/identifiers were not copied into source. Signing, application IDs, version, backup encryption, Google Drive sharing and supplied corpus are unchanged.

## Confirmed code causes

Previously `existingSuggestions()` offered a three-day-window list only inside the approval form. Discovery never linked an existing ledger entry automatically, so an already-recorded purchase remained PENDING until manually reviewed. The automatic path now has stricter requirements than that suggestion list.

Pluxee `eligibleSources()` required an exact `cardDigits` match; the parser did not recognize several meal-card/wallet suffix phrasings. Pluxee/Sodexo aliases and meal-specific `wallet ending in`, `meal card number`, and masked-card patterns now extract the wallet suffix without borrowing account suffixes. When digits are absent, only one active MEAL source plus independently corroborated existing ledger evidence can qualify for an automatic link. Conflicting suffixes or multiple wallets cannot be guessed. Archived wallets remain available for explicit historical review; they are not automatically chosen without archival chronology.

Settings used `href="#section"` with the application's root base URL. Those links could resolve to the root route. Accessible buttons now focus and scroll the exact section without changing URL/history, reloading or clearing forms. Scroll margins keep sections below the fixed header.

## Financial matching and audit

`sms-matching.ts` is a pure engine returning HIGH_CONFIDENCE_EXISTING, POSSIBLE_EXISTING, AMBIGUOUS, NO_MATCH or EVIDENCE_ONLY, with target IDs, source ID and reasons. An automatic link requires:

- One trustworthy eligible source, matching type/direction and currency, exact integer minor amount, one plausible existing transaction, explicit identical local event date, and compatible time when both sides supply it.
- Independent merchant token/alias or exact verified network-reference corroboration. Distinctive names can support differing manual descriptions. MYJIO/Jiofiber aliases normalize to Jio; generic words such as purchase, payment, store and market are excluded.
- No competing pending SMS claim in the relevant date window and no existing imported/matched SMS claim on that ledger entry. Three-day proximity is only a manual suggestion window; it never establishes an automatic match.

`SmsReviewService.reevaluatePending()` serializes with other database writes, reads persisted sources/cards and a bounded ledger date-window batch, rechecks competing claims, then atomically writes MATCHED_EXISTING, the transaction ID, explanatory decision and the unique `sms_reconciliation` relationship. It does not call store financial mutators or insert, update or delete financial records. **Automatic matching changes zero existing financial rows and zero wallet balances**, proved against executable SQLite rows, not UI counters.

Each refresh/recheck considers at most 200 pending candidates and separately checks up to 200 automatic links with rotating cursors. Ledger/competition windows above 5,000 rows conservatively skip automatic matching. Claim lookup parameters are chunked to 400. Invalid automatic bindings caused by changed/deleted/reassigned transactions or changed source identity return to PENDING with an audit reason. Explicit decisions are not undone. Restored payload-free tombstones remain durable deduplication records.

Pending evidence can be safely rechecked without rescanning an inbox. A reparsed native queue item can replace its encrypted staging payload under the same fingerprint; Angular updates evidence only while the candidate remains PENDING and preserves read flags. IMPORTED, MATCHED_EXISTING, REJECTED, IGNORED and DEFERRED decisions are not reset by replay. Old raw SMS is not retained and cannot be reconstructed from a restored tombstone; improved parsing only applies when an original message is encountered again or explicitly pasted. The normal durable scan cursor is not reset.

Bank debit/credit/transfer, initiation, statement and loan notices remain evidence only. They cannot automatically create spending, income, bank accounts or payment receipt. Existing explicit payment/installment/loan reconciliation remains available. Explicit matched history warns when the linked record is missing or its current amount/type/date differs from the evidence, while retaining the user's original decision.

## Meal-wallet balance comparison

The parser records AFTER only for recognized current/available wallet-balance wording accompanying a completed meal event; older or uncertain evidence remains UNKNOWN. The comparison shows CardNest, reported, expected snapshot, resulting balance and difference, with chronology explanations. A recorded transaction contributes no second debit/top-up. A pending transaction predicts exactly one debit or credit; a cutover event is not replayed. Before-event snapshots are compared against a before-event value and cannot directly reset a post-event wallet.

No balance is changed by auto-linking. Pending approval retains the existing explicit reconciliation choices, now blocking unsafe meal snapshot adjustments. A matched event additionally offers Keep CardNest balance, Review balance difference and a separate Update balance from SMS confirmation. Adjustment rechecks persisted binding, amount/type/date, source, cutover and same-day/later activity inside the atomic write. It records a deterministic ADJUSTMENT linked to the original transaction, updates snapshot/cutover metadata and appends audit information. It does not insert another purchase/top-up or fabricate income. Repeated adjustments are prevented by cutover/chronology and deterministic identity. Unknown ordering, newer activity, stale links and ambiguous identity retain the existing balance.

## Filters and review UI

Needs review, Already added and All history shortcuts preserve financial-state and independent read/unread filters. Matched events show their audit reason and View existing transaction, which opens the existing Activity editor; no Add action can reimport them. Pending, linked, imported and unread totals remain separate. Possible-match counts are explicitly scoped to the current page.

Single uses the existing custom dropdown. Multiple uses a compact searchable checkbox picker with Select all, Clear, Done, removable OR chips and Android Back/Escape handling. The first Multiple switch defaults to Purchase, Cashback, Pluxee purchase, Pluxee top-up and Bank debit. Custom selections survive mode switches and applied preferences survive reopening. Zero selected types deliberately returns zero results with explanatory UI.

`sms_review_filters` retains the original `kind` and extends it with mode, kinds and multipleInitialized. Old single-type preferences normalize without losing their selection. Restored enums are allowlisted, duplicates removed and arrays bounded. SQL uses one parameterized IN group combined with the other independent predicates using AND. Counts, pagination and result ordering use the same WHERE clause. Existing encrypted v1/v2 backups preserve the preference through app_preferences and retain matching state/relationships while omitting SMS evidence payloads.

## Validation commands

Node commands used WSL Ubuntu-22.04 and the installed Node 24.16.0 runtime, from `/mnt/c/AR_Files/code/card-nest`:

```bash
npm test -- --watch=false
npm test -- --watch=false --include=src/app/features/sms-sync/sms-sync.spec.ts
npm run lint
npx tsc -p tsconfig.app.json --noEmit
npm run test:sms:fixtures
npm run build
npm run test:web-isolation
npm run android:sync
npm run test:android-isolation
node --test scripts/verify-backup-sharing.mjs
git diff --check
```

Test evidence includes actual SQLite constraints, atomic rollback, byte-equivalent financial rows before/after matching, merchant aliases, missing merchant/source/date evidence, exact references, duplicate purchases, competing SMS, changed financial records, claimed entries, refunds/cashback/payment receipt, missing-suffix Pluxee, multiple/conflicting wallets, replay/read preservation, explicit adjustment idempotence, OR/AND/empty filters, old/new backup preferences, real encryption/wrong-passphrase/corruption regression checks, and all five Settings focus/scroll targets. The unchanged corpus and existing safeguards continue to cover AMEX suffix variants, archival cards, bank/loan/statement evidence and wallet cutovers.

Browser validation used an ignored synthetic preview, real app components and AXE. Multi-select passed at 320/360/390/430px in LIGHT/DARK with no horizontal page overflow and 44px actions. A 320px/200% text check also had no overflow or AXE violations. All five Settings buttons retained `/settings`, focused their section and positioned it approximately 72px below the header. Visual inspection found and corrected stretching of the source input beside an expanded picker. Evidence: `tmp/final-refinement-preview/reconciliation-audit.json` and `screenshots/reconciliation-types-light-390.png`. The preview has no real inbox/database and does not prove device outcomes.

Android toolchain commands:

```powershell
$env:JAVA_HOME=(Resolve-Path tmp/sms-tools/jdk/jdk-21.0.12.1).Path
$env:GRADLE_USER_HOME=(Resolve-Path tmp/sms-tools/gradle-cache).Path
& android/gradlew.bat -p android :app:testDebugUnitTest --rerun --offline --console=plain
& android/gradlew.bat -p android :app:assembleDebug :app:assembleRelease :app:bundleRelease :app:lintDebug --offline --console=plain
& ./tmp/verify-refinement-artifacts.ps1
& tmp/sms-tools/android-sdk/platform-tools/adb.exe devices -l
```

The final full Angular run passed **238 tests across 24 files**. The final SMS UI explanation changes were additionally rechecked with all 27 SMS UI tests passing, including available AXE rules in both themes. Strict TypeScript and Angular lint passed. All 70 corpus provenance checks passed. The normal web build and isolation passed over 26 JavaScript files. Both the seven Android integration checks and two existing backup-sharing contracts passed after regeneration. The pre-commit hook also runs formatting and Angular lint.

The JVM run passed all 124 tests, including all 70 supplied corpus cases and six fictional Pluxee/Sodexo wording combinations in the added test. No device was attached. Physical tests remain: scan and revisit pre-existing ledger cases, inspect matched history and original Activity details, verify saved multi-selection after force-stop/restart, cancel/reopen nested controls with Android Back, inspect wallet comparisons with real device timezones, exercise explicit adjustment confirmation on synthetic data, restore an encrypted test backup, and check TalkBack/keyboard/insets. No physical financial data or cloud upload was used for validation.

The final Android build completed successfully in 1m 23s: debug APK, unsigned release APK, release AAB and Android lint. Lint reported zero errors and 45 warnings; Gradle also reported deprecated features. The artifact audit verified debug identity/version/signature, compiled SMS permissions and protected entry points, release R8 registration and matching final JavaScript asset hashes across all three packages. The installable debug artifact is `android/app/build/outputs/apk/debug/card-nest-1-1-8-debug.apk` (31,096,923 bytes), SHA-256 `0D759829433A8F2538CBA4A6E091629A3754F2DBF699B46CA05D38683B33E8A3`. Release compilation is not a release or distribution-signing validation.

Build evidence: `tmp/reconciliation-gradle-final.log`, `tmp/reconciliation-artifacts.log`, `tmp/refinement-artifacts-final.json` and `android/app/build/reports/lint-results-debug.xml`. The web production build retains the existing Cards stylesheet budget warning (25.17 kB against 23 kB). The privacy audit (`node tmp/audit-sms-privacy.mjs`) passed: all 70 supplied SMS bodies are byte-identical, new vehicle fixtures use corpus-approved fictional identifiers, and no new full financial identifiers or private database/build/signing files are included.

## Changed tracked files

- Native: `native/android/sms-sync/SmsTransactionParser.kt`, `SmsQueue.kt`, `SmsEdgeCaseTest.kt`.
- Matching and persistence: `src/app/features/sms-sync/sms-matching.ts`, `sms-matching.spec.ts`, `sms-model.ts`, `sms-review-filters.ts`, `sms-review.service.ts`, `sms-review.service.spec.ts`.
- Review UI: `src/app/features/sms-sync/sms-type-picker.ts`, `sms-sync.ts`, `sms-sync.html`, `sms-sync.scss`, `sms-sync.spec.ts`.
- Settings: `src/app/features/settings/settings.ts`, `settings.html`, `settings.scss`, `settings.spec.ts`.
- Optional network reference: `src/app/core/models/domain.ts`.
- Backup regression tests: `src/app/core/data/sqlite-backup.integration.spec.ts`, `src/app/core/services/backup.service.spec.ts`.
- This acceptance audit: `documentation/SMS_INTELLIGENT_RECONCILIATION_VALIDATION.md`.
