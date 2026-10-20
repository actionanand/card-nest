# Android Smart SMS Transaction Sync

Manual ledger inserts, edits and deletions now persist their wallet deltas in the same serialized SQLite transaction as the ledger row. Source metadata edits merge only changed fields into durable preferences, and wallet creation reads the latest durable source list. This prevents a stale manual preference or concurrent SMS approval from overwriting a balance. Startup source migration persists only after saved preferences have loaded. The public manual-entry API retains its existing optimistic UI behavior.

The provider query baseline was checked against the [AOSP SMS provider implementation](https://android.googlesource.com/platform/packages/providers/TelephonyProvider/+/master/src/com/android/providers/telephony/SmsProvider.java). OEM provider behavior still requires physical-device validation.

See [SMS_SYNC_VALIDATION.md](./SMS_SYNC_VALIDATION.md) for the original acceptance audit and [SMS_REVIEW_VALIDATION.md](./SMS_REVIEW_VALIDATION.md) for the mobile review, matching and approval fixes and their executed checks. The Capacitor pre-sync hook rejects a normal web bundle when preparing Android, preventing an APK that requests SMS permission without providing its review screen.

Feature branch: `feature/8-android-sms-transaction-sync`. SMS discovery never posts money automatically. Treat device validation and the delivery gates below as release requirements.

## Architecture and regeneration

Tracked Kotlin sources live in `native/android/sms-sync`. `scripts/patch-android-sms.mjs` copies production Kotlin and JVM tests separately, copies the supplied synthetic corpus into test resources, registers the Capacitor plugin, and installs manifest/Gradle configuration. The existing Java bridge remains in place. AGP 9.0.1 supplies Kotlin; a second Kotlin Android plugin is deliberately not applied. Java 21, SDK 36, Gradle 9.1.0 and core-library desugaring support API 24 devices.

`npm run build:android` uses `production,android` Angular configurations. File replacements install Android routes, navigation links and native data-cleanup hooks. The default production graph imports empty platform extensions. `npm run test:web-isolation` inspects every built JavaScript file for SMS route/UI/plugin/permission leakage. Never package the default web build as the SMS-enabled Android frontend.

`npm run android:sync` builds the Android frontend, syncs Capacitor and reapplies patches. The `capacitor:sync:after` package hook also patches Android when `npx cap sync android` is invoked directly. Recreating the ignored `android/` directory does not remove tracked Kotlin sources. Patches are idempotent; tests belong in `src/test`, never production sources.

## Discovery, permissions and privacy

The user chooses a 30-day, 90-day or all-history range. The accessible **SMS sync** switch enables discovery only when both `READ_SMS` and `RECEIVE_SMS` are granted and synchronization is opted in. Switching off cancels discovery and scheduling while retaining review items, ledger data and scan progress; it does not revoke Android permissions. A deliberate tap on **SMS Review** in Transactions checks native access and requests it once only when never previously requested. Angular's transient navigation `info` prevents refresh/history restoration from replaying that action. Ordinary app launch and settings/foreground refresh never prompt. Denial or bridge failure keeps synchronization off; retry requires the explicit switch or app settings. Only confirmed access initializes the first scan; re-enabling and Scan/retry preserve the saved cursor. Denied requests cannot initialize pending scans or reset progress. See [SMS_PERMISSION_DIAGNOSIS.md](./SMS_PERMISSION_DIAGNOSIS.md) for live permission states, app-settings navigation, installer restrictions and physical-device diagnostic commands, and [SMS_UI_POLISH_VALIDATION.md](./SMS_UI_POLISH_VALIDATION.md) for the switch and responsive UI audit. The page size comes from both environment files (default 200), is passed to native code and validated between 1 and 500. It is not a lifetime inbox limit.

Kotlin queries the SMS inbox using ascending `(date, _id)` keyset pages. Each financial result is durably staged before that record's cursor advances. Query/staging failures leave unread records eligible for retry. Completed scans replay a two-day overlap. A streaming engine bounds allocations; tests cover 0/1/199/200/201/400/1001 records, cancellation, backpressure and crash replay. Queue capacity is 5,000 outstanding suggestions: reaching capacity stops cursor advancement until the app drains the queue. There is no inbox-wide in-memory list.

The protected `SMS_RECEIVED` receiver only schedules a persisted Android JobScheduler job. It accepts broadcasts protected by `BROADCAST_SMS`; it does not trust arbitrary intent bodies or need a WebView. A separate non-exported restart receiver handles boot, app replacement and unlock. Work checks opt-in and permissions, processes at most ten pages per invocation, and reschedules remaining work. Force-stop and OEM battery restrictions can defer discovery until Android permits the app to run again. A foreground scan interrupted by app locking/backgrounding schedules catch-up; explicit cancellation does not.

The separate app-private `sms-discovery.db` stores only SHA-256 identities and AES-GCM encrypted extracted JSON. Keys are non-exportable Android Keystore AES keys; each encryption uses a fresh IV. Raw bodies, senders, OTPs and marketing are not stored. The queue never opens Capacitor's ledger database. Android OS backup is disabled to prevent restoring encrypted queues without their keys; CardNest's explicit encrypted financial backups remain available. No SMS notification feature is enabled, so no financial SMS details appear on the lock screen.

Paste fallback invokes the same bounded native parser without inbox permission. Pasted raw text is cleared after successful parsing and whenever the review screen locks/backgrounds. Review DOM content and mutations are gated by application lock and foreground state.

## Parser and evidence

Rules distinguish purchases, issuer-confirmed card repayments, payment initiation, actual cashback credits, refunds, meal-wallet credits/purchases, FASTag tolls/recharges, bank debit/credit/transfers, loan debits, statements and reminders. Bank transfers, initiation, loan debits and reminders cannot create spending/income entries. Bank and aggregator notices do not prove issuer receipt. Due dates, minimums, totals, available limits and wallet balances remain separate evidence.

Integer paise is checked for precision and overflow; conflicting event amounts fail closed. Financial event date/time, original receipt time, local clock time, timezone and fallback disclosure are separate. Indian templates default to Asia/Kolkata; an explicit IST marker overrides a supplied zone. Strict date parsing uses 2000–2099 for two-digit years, supports malformed one-digit seconds, and rejects invalid explicit dates. Unknown date formats remain a limitation: verify the disclosed fallback before approving. Dates in URLs/security instructions are excluded. Cashback uses credit-event/receipt date and can retain `earnedForPeriod=previous month` as evidence.

Card suffixes require card context and cannot come from block commands, phone numbers, CODE tags or UPI references. Issuer aliases are normalized; a missing issuer permits suffix-only suggestions while an explicit conflicting issuer excludes a card. AMEX four/five-digit variants may suggest the same source. Exactly one reliable match is preselected, and every import still requires explicit user approval. Ambiguous suffixes require selection. FASTag plate equality narrows eligible wallets but does not prove ownership. Archived sources remain available for historical review; auto-suggestions require a recorded archive date after the event.

The EXTRA-06 annotation erratum corrects its expected kind to BANK_DEBIT_REVIEW and its ledger policy to explicit reconciliation. Its INFT wording has no ECS/loan evidence, just like BASE-41; amounts and security trailers cannot establish a loan. The SMS text remains unchanged. Corpus tests now use the corrected annotation directly, without a fixture-ID exception. Additional tests vary amounts/trailers and require actual ECS/loan/mandate markers for loan-debit evidence. Even explicit ECS evidence requires user matching; it never proves a particular loan was paid. The provenance validator projects only this declared annotation correction back to the original reviewed checksum, preserving the integrity check for every SMS and identifier.

## Review and atomic import

The Android-only `/sms-sync` route is reachable from Transactions and Settings. Review is paginated, searchable and filterable by type, state and source text/suffix/vehicle. Each item exposes extracted evidence, timestamp confidence, source selection, amount/date/category/merchant edits, existing-entry matching, rejection and deferral. Refunds can explicitly associate with an original purchase on the same source. There is no unsafe batch financial approval.

Migration 7 adds indexed `sms_candidates`, `sms_reconciliation` and `sms_sync_state`. Candidate identities are unique and review decisions survive scan replay. Native-to-Angular handoff follows: read encrypted queue → atomic INSERT OR IGNORE in Capacitor SQLite → native acknowledgement. Crashes after the first commit safely repeat staging. Rejected/imported tombstones are never reset by rediscovery.

`SqliteDatabase.atomic()` shares the existing write queue. Approval rechecks persisted candidate state and existing transactions inside one transaction, inserts/repairs the ledger row, updates an applicable wallet preference, binds evidence and records the decision. UI/cache state changes only after commit. Repeated taps or retry after commit cannot insert a second ledger row. Shared-reference receipts already bound to the same source cannot create another payment. Approximate manual duplicates require matching or explicit confirmation of a separate event; amount/merchant alone is never a processing identity.

Bank/aggregator evidence can link an existing card payment. Loan-debit evidence can confirm an existing unpaid EMI installment of the same amount or record a dated link to an existing loan commitment. Loan commitments currently have no separate paid-installment ledger; confirming a commitment records reconciliation evidence without inventing a schedule or expense. Unknown loans remain pending. Matching alone never upgrades an aggregator notice to issuer confirmation.

Issuer-confirmed repayments retain their actual amount, including partial or overpayments. The user may leave reconciliation pending or explicitly settle a chosen statement date and original due amount. Only that statement is marked settled; overall outstanding stays ledger-derived. Editing/deleting/moving its bound payment invalidates the settlement override. No fee is fabricated to explain a mismatch.

## Meal wallets and FASTag

Legacy meal balances can contain simulated monthly credits. Migration preserves the exact existing balance, records a cutover snapshot and disables scheduled loading. New default wallets start at zero. Historical SMS entries preceding that snapshot require explicit retain-balance approval, and their later edits/deletions do not replay those already-included amounts. There is no hardcoded top-up amount or monthly load day.

Actual top-ups are CREDIT rows with the actual event amount/date. Users can repair a selected existing top-up, retain calculated balances, or explicitly create a documented ADJUSTMENT linked to the imported event. Adjustment is blocked when the reported snapshot predates a balance cutover or same/later tracked activity. Manual balance corrections create a new snapshot boundary. Negative calculated balances remain visible; there is no silent clamp. Multiple manually created FASTag wallets retain separate IDs, plates, providers and histories.

## Backup, restore, retention and deletion

Portable backups preserve approved ledger data, processing tombstones, review states, reconciliation decisions and retention settings. Candidate extracted payloads and native encrypted queue contents are excluded. After restore, evidence-only tombstones cannot reconstruct a pending message, but continue preventing accidental repeated imports. Restore requires an explicit new permission/scan choice and preserves manual financial data. Older pre-feature backups have no SMS tombstones: reviewers must use existing-entry matching after such a restore.

Exports, writes, deletion, retention and restore share the database write queue. Delete-all clears native discovery settings/queue, disables discovery and clears all new tables. Restore validates structure before clearing native discovery. Retention removes old extracted payloads while retaining minimal dedup tombstones, prunes old native suggestions and remembers a cutoff so rescans cannot repopulate retained-away message details. No raw SMS enters standard backups or reports.

## Automated verification

```sh
npm test -- --watch=false
npm run lint
npm run build -- --configuration production
npm run test:web-isolation
npm run test:sms:fixtures
npm run build:android
npm run android:sync
npm run test:android-isolation
cd android
./gradlew testDebugUnitTest compileDebugKotlin assembleDebug
./gradlew assembleRelease bundleRelease lintDebug
```

JVM tests consume all 70 JSON fixtures, plus original parser tests, additional strict-field/date/privacy cases and streaming recovery boundaries. The fixture validator pins the reviewed synthetic corpus checksum and fictional vehicle allowlist, checks IDs/counts and flags potential full financial identifiers. These are heuristics and provenance checks, not proof that an arbitrary new message is synthetic. Changes to the corpus require human review before updating its checksum.

Angular import tests use actual in-memory SQLite constraints and transactions. They cover double approval, rollback, rejected replay, informational non-import, manual matching, exact overpayment, wallet cutover, multiple vehicles and explicit discrepancy decisions. Compilation/tests do not prove Android permission behavior.

## Release gates and manual Android QA

The delivery report records actual executed results. Do not treat unexecuted checks as passes.

- Build the Android-specific frontend and verify the guarded route, links and pasted-message flow in a real WebView. Package that frontend before producing an installable feature APK.
- Run AXE on light/dark review, empty/error states and expanded editors; verify contrast, TalkBack labels, focus return, keyboard navigation and Android Back. Template/type compilation and lint alone are not an AXE pass.
- On a physical Android device, test first opt-in, denial, permanent denial, revoked READ/RECEIVE access, disabled discovery and permission-free paste. No prompt may appear merely at launch.
- Test incoming/multipart SMS with the WebView absent, locked device, reboot, app update, Doze, force-stop and restart. Verify only generic/no SMS notifications and no private recent-app previews.
- Inject more than 200 financial/nonfinancial messages, cancel at page boundaries, fail the provider, fill staging capacity, and restart between queue commit, ledger commit and native ack. Check no loss or duplicate money.
- Restore old/new backups, delete all data and apply retention while discovery is pending. Verify manual entries, linked refunds, card statements, loans, EMI plans and existing balances.
- Review Google Play eligibility for restricted SMS permissions before Play distribution. An OS grant or working sideload does not establish Play policy approval. If ineligible, distribute an allowed variant or use paste/manual entry; do not bypass restrictions.

Known remaining product limitations: cross-message relations without a shared reference need explicit reviewer matching; no user-defined sender/category rule editor is provided; no optional background notification setting is exposed. These conveniences must never bypass review. Full release readiness additionally requires the frontend/device/accessibility gates above.
