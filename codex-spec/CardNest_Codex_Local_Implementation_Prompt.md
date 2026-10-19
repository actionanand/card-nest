# Codex Local — CardNest Feature 8: Android Smart SMS Transaction Sync

> **Paste this entire prompt into Codex Local after opening the `actionanand/card-nest` repository, or point Codex to this file after copying it into your local workspace.** This is an implementation request, not a brainstorming exercise. This document is self-contained, including synthetic examples below. Do not publish real/user-supplied SMS contents.

## Role and delivery mandate

Act as a senior Android/Kotlin, Angular, Capacitor, SQLite, and financial-data-integrity engineer. Implement a **production-quality, Android-only** SMS transaction-discovery, classification, matching, review, and user-approved import system into CardNest. Read source code before editing; integrate with its established patterns rather than layering a throwaway demo on top. This feature must remain offline-first and privacy-preserving. **No external SMS data processing or cloud API.**

Repository: `https://github.com/actionanand/card-nest`

Work exclusively from **existing** branch: `feature/8-android-sms-transaction-sync`, created from `main`.

The related GitHub Issue #108 was closed; use the requirements **here**, not the issue state, as the implementation contract. Reopening it is unnecessary. Do not merge automatically, push to `main`, reset shared history, force-push, or create a replacement feature branch. Do not add real personal identifiers to public test files or commit generated artifacts containing private SMS.

First, from the local repository:

1. Run `git status --short --branch`. If there are uncommitted changes, stop and show them before any operation that could overwrite them.
2. Run `git fetch origin --prune`; switch to `feature/8-android-sms-transaction-sync` (track `origin/feature/8-android-sms-transaction-sync` if necessary). Use `git pull --ff-only` only where safe; never discard work.
3. Show `git branch --show-current`, `git rev-parse HEAD`, `git log -5 --oneline`, and `git status --short`.
4. Confirm `native/android/sms-sync/SmsTransactionParser.kt` and `native/android/sms-sync/SmsTransactionParserTest.kt` exist. These are a **preliminary unverified scaffold**, not trusted code; inspect, repair, replace, or extend them as justified by tests. The previous synthetic-fixture edit may be at or after commit `cc9228e`; check actual branch head rather than resetting to that commit.
5. Inspect `AGENTS.md`, `package.json`, `documentation/ANDROID.md`, `documentation/DATABASE_SCHEMA.md`, `documentation/APPLICATION.md`, `src/app/core/models/domain.ts`, `src/app/core/services/card-nest-store.ts`, `src/app/core/services/money.ts`, `src/app/core/data/migrations.ts`, `src/app/core/data/sqlite-database.ts`, `src/app/features/transactions/*`, `src/app/features/sources/*`, `src/app/features/settings/*`, `src/app/app.routes.ts`, `src/app/app.html`, `src/environments/*`, `.github/workflows/android-build.yml`, `scripts/patch-android.mjs`, and `scripts/patch-android-export.mjs`.
6. Write a short implementation checklist before editing, then **implement and run tests**, not merely generate a plan. Work in testable checkpoints and continue unless blocked by a real dependency or need for human approval.

## Existing architecture to respect

- Angular 22, Capacitor 8, native Android project **generated** during builds (the uncommitted `android/` folder is not the source of truth). Existing patch scripts supply Java bridge, alarms, permissions, PDF/CSV export and R8 integration. Android CI uses Java 21, Android SDK 36, AGP 9.0.1, Gradle 9.1.0 (verify actual repo values first).
- CardNest uses `@capacitor-community/sqlite` for Android and `jeep-sqlite`/IndexedDB on the web. Core `CardTransaction` types include `PURCHASE`, `CREDIT`, `CASHBACK`, `REFUND`, `PAYMENT`, `FEE`, `INTEREST`, `ADJUSTMENT`.
- Credit cards have issuer/network/nickname/last digits. AMEX stores **five** trailing digits; other networks generally four. Payment source kinds currently include `CASH`, `DEBIT`, `MEAL`. Non-credit-card sources are currently stored as preferences and their transaction JSON payloads retain IDs while the normalized card foreign key is NULL.
- The store's current `addTransaction()` and some payment-source balance updates are fire-and-forget or in-memory first. **Do not reuse them blindly for bulk imports.** Make approved-import persistence atomic, awaited, idempotent, and reflected correctly in UI only after durable commit. Avoid concurrent SQL-transaction collisions.
- Existing Pluxee implementation seeds a balance/load amount and adds a fixed monthly load around day 25 in `materializeSourceLoads()`. Replace this completely with actual dynamic top-ups and manual top-ups **without double-counting historical load amounts or altering already tracked balances during migration**.
- Existing card statement, manual payment, loan, EMI, linked transactions, category, recurrence, backup, and retention logic must continue working. Do not infer new fees, GST, or loan payments from vague SMS alone.

## Architecture — native Android only

**Native Kotlin** must own SMS reading, bounded pagination, incoming message receipt, initial normalization/classification, dedup keys, and resilient staging. Kotlin sources must live in tracked source directories (for example `native/android/sms-sync/`), be copied/compiled by reproducible scripts during `npx cap sync android`, and survive deletion/re-creation of generated `android/`. Do not embed huge Kotlin source strings inside JS patch scripts. Ensure correct Kotlin/Gradle integration with the project's AGP/Capacitor/R8 setup; do not disrupt existing Java native bridge.

Use `ContentResolver` only with the necessary permission for existing inbox reads; use the Android SMS-received broadcast (not default-SMS-app-only delivery) where valid for incoming discovery. Restrict receiver exposure and inputs appropriately; offload any nontrivial work promptly to a reliable scheduled worker using Android-supported lifecycle rules. Android receivers must not require an active Angular WebView. For native queued state, use minimal **app-private, encrypted-at-rest** data if storing sensitive extracted content; do not store unrelated SMS or OTP messages. Define a crash-safe handoff from native staging to the main SQLite review database. Do not attempt unsafe concurrent access to the existing Capacitor SQLite database from two independently managed database engines.

Android `READ_SMS`/`RECEIVE_SMS` are restricted permissions under Google Play policy. Implement clear opt-in, runtime permission/state checking, denial/revocation handling, and a safe fallback for shared/pasted SMS text if inbox access is unavailable. Never imply Play approval is automatic or try to circumvent OS/Play restrictions. Do not prompt automatically at every app launch. Request only after the user explicitly chooses to enable scanning, and request again only if no longer granted and the user takes an explicit action. Keep background work permission-aware and respectful of app force-stop/battery limitations.

**Android-only delivery:** Native SMS engine, permission, manifests, receivers, storage and related Gradle dependencies exist only in Android builds. Create an Android-only Angular SMS Sync page and navigation entry, with guard against browser use. Configure platform-specific Angular production builds or equivalent so web production output has **no SMS Sync route/UI/bundle or SMS-specific permission prompts**; verify this rather than assuming a runtime `Capacitor.getPlatform()` check alone prevents bundling. The existing web app must continue to build and function.

## Dedicated SMS Sync UI / UX

Expose a new Android-only route such as `/sms-sync`, reachable through Android Transactions and Settings. Provide:

- Clear opt-in and current permission status (`not requested`, `granted`, `denied`, `revoked/unavailable`), enabled/disabled setting, manual Scan now action, last completed scan, and last successful cursor.
- First-time history range (last 30 days default; last 90 days; all available with safeguards). **200 messages per database page is the starting value**, configurable in existing `src/environments/environment.ts` + development config. A page of 200 is not a lifetime maximum; continue bounded pages until date/cursor boundary. Pass validated batch settings to Kotlin rather than maintaining conflicting hard-coded constants.
- Real loading and progress: pages checked, SMS scanned, financial items found, duplicate/ignored counts, ability to cancel, background catch-up status, resumable retry. Never block the UI with thousands of SMS or allocate the full inbox into memory at once.
- Pending review inbox with clearly distinguishable Purchases, Card Payments, Payment Initiated, Cashback, Refunds, Loan/EMI, Transfers/Bank Information, Pluxee, FASTag, Statements/Reminders, Unmatched, Duplicates, Ignored/Rejected. Search/filter by source/type/status, count and sort by event time. Detailed view of sanitized/extracted fields and why a suggestion is uncertain. Avoid displaying private data on lock-screen notifications.
- Per-item actions: **Add**, **Edit & Add**, **Match Existing**, **Confirm Payment/EMI**, **Choose Source**, **Reject**, **Review Later**; batch add/reject only where safe. Ambiguous matching must require source selection, not silent guessing. Rejected records never reappear simply because scan reran; user may intentionally revisit rejected history.
- Native automatic SMS discovery should stage suggestions, never automatically post entries into spending or balances. When app is locked, defer sensitive review UI until after unlock. Background notifications, if enabled, should be generic (e.g. "New transactions ready for review"), without merchant, amount, or full card data.
- Accessible light/dark UI following existing CardNest styles (WCAG AA, keyboard focus, screen reader labels, Android back handling, dialog cancellation, and appropriate empty/error states).

## Parsing — strict financial semantics

Implement a deterministic rule-based parser and source matcher with well-tested, modular issuer/message templates. No cloud AI is required. Input may be multiline, have mixed casing/spacing/punctuation, incomplete card details, UPI VPA addresses, malformed seconds (`22:52:3`), or Indian/ISO date formats (`18-Oct-26`, `17 October 2026`, `07/08/26`, `yyyy-MM-dd`, weekday + month name). Preserve raw **receivedAt** separately from parsed financial **eventAt**, carefully handling IST, local time-zone, DST, 2-digit years and date-only messages. Use receipt date only when an event date is absent, and disclose any fallback in the review UI. Avoid parsing dates from links/reference numbers.

Extract and keep distinct: sender alias (if needed and minimized), event date/time, amount in integer paise, currency, event direction/type, issuer, account vs credit card vs wallet source, masked last 3/4/5 digits, card network where known, merchant/payee, UTR/RRN/UPI reference, reported wallet balance, available credit limit, statement total/minimum/due, vehicle plate if toll-related, and confidence/evidence. Reject overflow, negative invalid values, multiple conflicting amounts, OTPs and marketing. **Never use the first currency number blindly:** for example due, interest, penalty, wallet balance, available credit limit, and purchase amount may coexist.

Types and policies:

1. **Card purchase:** `PURCHASE` only when an actual card charge is evidenced; includes RuPay **credit card** linked to merchant UPI (UPI does not automatically mean bank debit). Do not mistake `SMS BLOCK...` trailing digits, phone number, `CODE`, UPI RRN, card product branding, or a long merchant ID as a card suffix. AMEX `** 52137` and `ending 2137` can refer to same account if issuer/context agrees; never collapse recurring purchases of same merchant/amount across different dates.
2. **Card repayment:** distinguish bank/UPI/CRED/CheQ/NPCI "sent", "debited" and "processed" from issuer-confirmed "payment received/credited". One real payment can generate multiple SMS; group as one logical payment based on reference, amount, target, time and source evidence. Never treat aggregator/bank debit as final card issuer confirmation. Before import, match existing manual card payments to avoid duplicates.
3. **Payment/statement mismatch:** if issuer confirms ₹4,317 while CardNest statement total due is ₹4,307, **record actual ₹4,317**. Offer user choices to mark this statement fully paid, leave it reconciliation-pending, or link/repair an existing payment. Do not silently trim to due amount, invent a ₹10 fee, or conflate statement settlement with overall current card outstanding/unbilled activity. Reconcile partial and overpayments. Statement SMS includes minimum due, total due, statement date and payment date; treat as **informational**, not as a purchase or payment event.
4. **Cashback:** only actual monetary cashback _credited_ to the credit card; create `CASHBACK` with category `contra-expenses` on **credit receipt date** (not spending-period date), optionally tag `earnedForPeriod=previous month`. Ignore merely earned points, promotions, offers, or reward redemptions.
5. **Refund/reversal:** actual credited reversal/refund becomes `REFUND` or an appropriate existing adjustment (if truly distinct), with original purchase association when evidence supports it. Exact duplicate SMS must not duplicate refunds; keep multiple legitimate partial refunds distinct. Keep both debit and refund with correct ledger effects.
6. **Pluxee/Sodexo:** dynamic credited amount and event date; **no hardcoded ₹8,800, monthly day 25, or employer assumptions**. Recognize `Rs.6240 credited towards Meal Wallet`, purchases with or without `card no.xx####`, and separate `current Meal Wallet balance` or `Avl bal` from monetary event amount. Preserve manual top-up/edit and balance corrections. If SMS balance conflicts with calculated balance, offer explicit reconciliation options including updating an existing load, applying a documented adjustment, or retaining calculated balance. Do not blindly overwrite a later balance using an older snapshot. Remove legacy scheduled loads safely, accounting for past simulated loads already baked into balances.
7. **FASTag:** add source kind for vehicle-linked wallets with arbitrary **fictional in tests** vehicle registration, provider, reference, balance, toll purchases, recharges, and manual adjustments. Auto-detect plate only when present; also allow manual creation/link. Multiple vehicles must never share balance or transaction history; a vehicle plate by itself is not proof of ownership. Do not include any real user's vehicle number anywhere in committed docs/tests/code.
8. **Bank/UPI:** actual bank debits, bank credits and account-to-account transfers may be used as _evidence_ for payments/loans but **do not yet update tracked bank balances or create automatic income/expenses**. Hold unmatched bank notifications for review. A transfer with send and receive confirmations and a shared UPI reference is not both spending and income. If source is unidentifiable, show a generic pending item. Keep future bank-account accounting extensible.
9. **EMI/loans:** distinguish upcoming installment reminder from actual bank ECS/mandate/AutoPay debit and from lender-confirmed receipt. Match to existing CardNest loan commitments and installments only with confidence and explicit user approval; unknown ECS debit is not proof of a specific loan. Existing loan schedules and credit-card EMI plans must not be duplicated.
10. **Non-events:** card inactivity, OTP, promotional offers, due reminders, and statement generation must never be imported as new spending. Mark as ignored/informational if useful.

## Card/source matching and confidence

Use explicit source type, issuer/bank/product branding, last 3/4/5 digits, possible card network, sender and other contextual evidence. Exact unique card suffix + issuer can be high confidence; matching only issuer/sender is medium/low; ambiguous identical suffixes MUST ask the user. Do not infer a card suffix from security block commands, OTP, account reference or phone numbers. Support archived historical cards when appropriate. A missing suffix becomes generic/unmatched; never hide the SMS. Add optional user-overridable sender→source and merchant→category rules only after confirmed user choices; no opaque self-learning that bypasses review.

## Database, migration, balance and recovery integrity

Implement additive migrations beyond current latest version, indexed candidate/reconciliation/sync state tables with unique processing identities. Suggested conceptual fields: message provider identity and timestamp, normalized hash/fingerprint, parsed evidence in minimized/encrypted form where relevant, provider/source candidate, state (`PENDING`, `REJECTED`, `IGNORED`, `IMPORTED`, `MATCHED_EXISTING`, `DEFERRED`, `ERROR`), optional bound `transactionId`, review/update timestamps, last scan position, last attempt/error, and review decisions. Native queue and Angular review DB have a crash-safe handoff. Include backup/export/restore/delete-all-data/retention migrations and behavior for new tables. SMS raw text and OTPs should never enter standard backup, analytics, debug logs, or notification payloads.

On approval, one awaited atomic SQLite transaction must save the CardNest ledger entry, SMS import binding/decision, and any carefully applicable source balance or statement/EMI update, then update Angular state after durable success. If the app crashes after DB commit but before native queue ack, subsequent retry MUST be safe. Idempotency must rely on unique keys and transactional guards rather than amount/merchant alone. Duplicates may originate from repeated identical messages, issuer vs payment aggregator confirmations, manual records, historical sync overlap and native receive race. Maintain an overlap window while scanning; advance cursor only after results durably staged; track date + provider ID consistently. Bound native storage memory and work. Never lose unread financial SMS just because more than 200 arrive between syncs.

Respect historical migration: starting current Pluxee balances may already include old simulated monthly loads. Introduce a balance snapshot/cutover reconciliation to preserve today's balance, prevent historical import double-counts, and avoid discontinuities. Handle user edits/reversals cleanly; no silent balance clamping to zero that masks inconsistencies.

## Synthetic regression and acceptance tests

The appended test corpus contains **70 synthetic SMS cases** derived from the user's 56 patterns, plus added top-ups, duplicate refunds, loan debits, cashback, FASTag multi-vehicle, statement discrepancy, OTP/marketing. Use it as _input patterns_, not as evidence of real cards or as direct financial ledger records. Assign and assert expected parsed type, canonical amount in paise, date/time, source/suffix, merchant/reference, and reported balance. Where corpus `expectedKind` is informational, never create a ledger transaction. Ensure any additional test fixtures are fictional and that no real message or personal identifier is committed.

Crucial cross-message test cases:

- One bank received credit and one bank sent debit with the same synthetic UPI reference and same amount => one transfer relationship, not duplicate income/spend.
- Two AMEX merchant charges with equal amount but **different months** => both genuine, not duplicates.
- The same refund SMS repeated exactly => one importable refund; reject/suppress duplicate suggestion.
- Pluxee reported balances inconsistent with known purchases => flag a balance discrepancy, not a fabricated purchase.
- Pluxee holiday/early/month-start loads and different employer amounts => dynamic, not a monthly scheduled rule.
- Card issuer reports received ₹4,317 against recorded due ₹4,307 => exact ₹4,317 amount, user chooses statement reconciliation outcome.
- Distinct source suffix variants and no suffix; no matching using sender block command alone.
- Multiple FASTag vehicles and top-ups must remain separated.
- Card bill due, statement generated, loan due reminder => **no transaction**; confirmed AutoPay/ECS debit => review, not automatic loan settlement.
- `CRED`/`CheQ` and issuer SMS describing same payment => one ledger entry, multiple evidence links.
- Simultaneous receiver + inbox scan, double-tap approve, crash between commits/acks, canceled/denied permissions, SMS provider query failure, 200/201/400 message boundaries, database restore, data deletion, app force-stop/restart and UI lock => no leaks, duplicate ledger entries or data loss.
- Test graceful behavior on web: no SMS route, no native plugin errors, normal navigation and transactions unaffected.

Prefer Kotlin/JUnit parser tests and integration tests; Angular isolated tests for matching, review, DB import rules, and UI. Avoid using a mock SMS provider as proof of full on-device SMS permission behavior; explicitly state what needs real physical-device testing. Add a synthetic-fixture validator to prevent accidental insertion of realistic phone/account/vehicle data into public commits, acknowledging heuristics are not infallible.

## Quality gates and delivery

Work in phases, with progress checkpoints and reviewable commits:
A. inspect existing app; fix native parser scaffold; make 70 synthetic cases pass;
B. data model + additive migrations + safe import service and reconciliation tests;
C. Android Kotlin plugin, native staging, broadcast receiver and cursor/paging, build regeneration and Android unit tests;
D. Android-only sync/review UI + permissions, accessibility and setup;
E. Pluxee migration, FASTag, payments, cashback/refunds, loan reconciliation;
F. full lint/test/build runs; privacy/permission review; docs; PR readiness.

Run actual repo scripts after verifying package names: `npm ci`, `npm run lint`, `npm test` using correct nonwatch flags, `npm run build -- --configuration production`, native Android generate/sync/patch script, `./gradlew testDebugUnitTest assembleDebug` (or equivalent), and available connected/emulator tests. If the build needs Android SDK/JDK/Gradle network setup on the local computer, investigate and clearly explain commands without requiring secrets to be pasted into chat. Run the existing web regression suite and ensure zero changes to web functionality. Fix failing tests rather than claiming success.

If a permission, Google Play policy, Android lifecycle, existing balance/history migration or statement reconciliation requirement is infeasible, stop that unsafe subsection and report the blocker; do not ship a partial implementation that modifies money incorrectly. Do not hide build failures. Produce clear `documentation/SMS_SYNC.md` detailing architecture, field classifications, privacy, permissions and Play distribution limitation, backup/migration behavior, testing instructions and manual QA checklist.

At the end provide: branch and final commit SHA, list of changes, number of passing/failing/skipped tests (and exact commands), Android build artifact location if created, remaining device-only checks, risks, and a ready-to-review PR **targeting `main`** only when quality gates pass. **Do not merge or publish a release automatically.**

---

# Annex: synthetic SMS test corpus

Everything below is synthetic. The format resembles various real-world Indian issuer/merchant SMS templates, but identifiers, amounts, payee names, support numbers and vehicle registrations were changed. Do not reconstruct or commit the user’s original messages.

```json
{
  "fixtureVersion": 1,
  "source": "Synthetic fixtures derived from 56 patterns, plus 14 synthetic edge cases",
  "policy": "No genuine personal identifiers, phone numbers, card numbers, transaction amounts or real vehicle registrations. Never commit raw original SMS.",
  "fixtures": [
    {
      "id": "BASE-01",
      "expectedKind": "PLUXEE_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Rs. 1,165.00 spent from Pluxee  Meal wallet, card no. on 18-10-2026 13:35:52 at DEMO CAFE. Avl bal Rs.2,200.24. Not you call 97823578381",
      "notes": ""
    },
    {
      "id": "BASE-02",
      "expectedKind": "PLUXEE_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Rs. 1,102.00 spent from Pluxee  Meal wallet, card no.xx2147 on 7-10-2026 23:29:26 at DEMO GROCERY ONE . Avl bal Rs.3,354.24. Not you call 97823578381",
      "notes": ""
    },
    {
      "id": "BASE-03",
      "expectedKind": "PLUXEE_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Rs. 603.88 spent from Pluxee  Meal wallet, card no.xx2147 on 7-10-2026 22:52:3 at DEMO GROCERY TWO . Avl bal Rs.4,846.44. Not you call 97823578381",
      "notes": ""
    },
    {
      "id": "BASE-04",
      "expectedKind": "BANK_DEBIT_INFORMATION",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "ICICI Bank Acct XX444 debited for Rs 234.00 on 18-Oct-26; DEMO SUPERMARKET credited. UPI:910667248461. Call 91697063 for dispute. SMS BLOCK 444 to 9252559501.",
      "notes": ""
    },
    {
      "id": "BASE-05",
      "expectedKind": "BANK_CREDIT_INFORMATION",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Dear Customer, Acct XX444 is credited with Rs 7,717.00 on 12-Oct-26 from DEMO PERSON. UPI:926571136735-ICICI Bank.",
      "notes": "This is an intentionally duplicate-equivalent notice or historical reconciliation case."
    },
    {
      "id": "BASE-06",
      "expectedKind": "BANK_DEBIT_INFORMATION",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "ICICI Bank Acct XX444 debited for Rs 1,307.00 on 07-Oct-26; DEMO PAYEE credited. UPI:911121549053. Call 91697063 for dispute. SMS BLOCK 444 to 9252559501.",
      "notes": ""
    },
    {
      "id": "BASE-07",
      "expectedKind": "PAYMENT_INITIATED",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "ICICI Bank Acct XX444 debited for Rs 4,262.20 on 20-Sep-26; CheQ credited. UPI:953963767557. Call 91697063 for dispute. SMS BLOCK 444 to 9252559501.",
      "notes": ""
    },
    {
      "id": "BASE-08",
      "expectedKind": "BANK_DEBIT_INFORMATION",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Rs 19.00 debited from ICICI Bank Savings Account XX444 on 11-Aug-26 towards DEMO AUTOPAY MERCHANT for Autopay AutoPay Retrieval Ref No.994098391434",
      "notes": ""
    },
    {
      "id": "BASE-09",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "PNB Credit Card 3141 debited with Rs.487.82 [CODE:WL7386] at DEMO TELECOM on 18-10-2026 00:09 through UPI: 960864318957 Avl limit Rs. 42,803. -PNB",
      "notes": ""
    },
    {
      "id": "BASE-10",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "PNB Credit Card 3141 debited with Rs.430 [CODE:VY5534] at DEMO PHARMACY on 10-10-2026 18:48 through UPI: 928994255740 Avl limit Rs. 46,173.8. -PNB",
      "notes": ""
    },
    {
      "id": "BASE-11",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "PNB Credit Card 3141 debited with Rs.37 [CODE:WJ7499] at DEMO MERCHANT A on 17-10-2026 18:31 through UPI: 935212789417 Avl limit Rs. 43,980.64. -PNB",
      "notes": ""
    },
    {
      "id": "BASE-12",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "PNB Credit Card 3141 debited with Rs.42 [CODE:V16856] at DEMO MERCHANT B on 11-10-2026 18:28 through UPI: 988317120750 Avl limit Rs. 46,034.8. -PNB",
      "notes": ""
    },
    {
      "id": "BASE-13",
      "expectedKind": "STATEMENT_REMINDER",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "REMINDER: Dear Customer, your BOBCARD **4152 Statement dated 01-OCT-26 has a Minimum Due of Rs 217 and a Total Due of Rs 2,106.11, payable by 20-10-26. Pay now at bobcard.io/BILLPAY. Please ignore if already paid.",
      "notes": ""
    },
    {
      "id": "BASE-14",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Alert: You've spent INR 1,369.70 on your AMEX card ** 52137 at DEMO INSURANCE on 17 October 2026 at 02:20 PM IST. Call 95750460384 if this was not made by you.",
      "notes": ""
    },
    {
      "id": "BASE-15",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "INR 1,369.70 for DEMO INSURANCE has been charged to your Amex Card ending 2137 on 17/07/2026 via SI Hub. You can manage your Standing Instructions with SI Hub ID SYNTHREF98765 at www.americanexpress.com/in/sihub. T&Cs apply.",
      "notes": ""
    },
    {
      "id": "BASE-16",
      "expectedKind": "CARD_PAYMENT_RECEIVED",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Payment of Rs 401.00 has been received on your ICICI Bank Credit Card XX6161 through Bharat Bill Payment System on 17-OCT-26.",
      "notes": ""
    },
    {
      "id": "BASE-17",
      "expectedKind": "CARD_PAYMENT_RECEIVED",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "HDFC Bank Cardmember, Online Payment of Rs.693 vide Ref# SYNTHREF123456 was credited to your card ending 7171 On 02/OCT/2026_value Date 02/OCT/2026",
      "notes": ""
    },
    {
      "id": "BASE-18",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "A transaction of Rs. 465.00 was made using your HDFC Bank Pixel Play Credit Card at merchant.one@sampleupi via UPI 915349566827 on 01/10/26 at 01:07. Not you? Block your Card: https://example.invalid/notice or SMS BLOCKPCC 8181 to 9101451278",
      "notes": ""
    },
    {
      "id": "BASE-19",
      "expectedKind": "CASHBACK_CREDIT",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Congratulations! Cashback of INR 130 has been credited to your Axis Bank Ace Credit Card XX9191 towards your last month spends - Axis Bank",
      "notes": ""
    },
    {
      "id": "BASE-20",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Spent INR 46\nAxis Bank Card no. XX9191\n08-10-26 21:32:26 IST\nDEMO SHOP A\nAvl Limit: INR 89,875.96\nNot you? SMS BLOCK 9191 to 956058866738",
      "notes": ""
    },
    {
      "id": "BASE-21",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Spent INR 207\nAxis Bank Card no. XX9191\n02-10-26 15:34:00 IST\nDEMO SHOP B\nAvl Limit: INR 95,119.37\nNot you? SMS BLOCK 9191 to 956058866738",
      "notes": ""
    },
    {
      "id": "BASE-22",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Spent INR 14,517\nAxis Bank Card no. XX9191\n29-09-26 01:14:48 IST\nDEMO ONLINE SHOP\nAvl Limit: INR 92,565.54\nNot you? SMS BLOCK 9191 to 956058866738",
      "notes": ""
    },
    {
      "id": "BASE-23",
      "expectedKind": "STATEMENT_REMINDER",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Payment of INR 1,639.28 for Axis Bank Credit Card no. XX2020 is due on 01-08-26 with minimum amount due of INR 117. Ignore if paid.",
      "notes": ""
    },
    {
      "id": "BASE-24",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Spent INR 995.75\nAxis Bank Card no. XX2020\n27-07-26 11:33:09 IST\nDEMO FUEL STATION\nAvl Limit: INR 108,084.77\nNot you? SMS BLOCK 2020 to 956058866738",
      "notes": ""
    },
    {
      "id": "BASE-25",
      "expectedKind": "STATEMENT_GENERATED",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Your statement for Axis Bank Credit Card no. XX2020 is generated.\nDue on: 01-08-26\nTotal amt: INR  Dr. 1,639.28\nMin amt due: INR  Dr. 117.00\nPay at axis.bank.in/ccpaynow\nTo view fees & charges: axis.bank.in/kfs\nTo view/download statement: https://example.invalid/notice",
      "notes": ""
    },
    {
      "id": "BASE-26",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "A transaction of Rs. 27.00 was made using your HDFC Bank Pixel Play Credit Card at merchant.two@sampleupi via UPI 987089660905 on 26/08/26 at 19:11. Not you? Block your Card: https://example.invalid/notice or SMS BLOCKPCC 8181 to 9101451278",
      "notes": ""
    },
    {
      "id": "BASE-27",
      "expectedKind": "FASTAG_TOLL",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Toll Paid!  Rs.92.0 for KA01AB1234  At DEMO PLAZA A  On 2026-08-07 13:57:10  Wallet Bal: Rs.837.00  Not you? Visit https://example.invalid/notice  HDFC Bank",
      "notes": ""
    },
    {
      "id": "BASE-28",
      "expectedKind": "FASTAG_TOLL",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Toll Paid!  Rs.122 for KA01AB1234  At DEMO PLAZA B  On 2026-08-07 12:59:38  Wallet Bal: Rs.912.00  Not you? Visit https://example.invalid/notice  HDFC Bank",
      "notes": ""
    },
    {
      "id": "BASE-29",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "A transaction of Rs. 2,419.00 was made using your HDFC Bank Pixel Play Credit Card at merchant.three@sampleupi via UPI 981536729229 on 05/08/26 at 13:36. Not you? Block your Card: https://example.invalid/notice or SMS BLOCKPCC 8181 to 9101451278",
      "notes": ""
    },
    {
      "id": "BASE-30",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Alert: You've spent INR 292.00 on your AMEX card ** 52137 at DEMO CLINIC on 13 October 2026 at 07:28 PM IST. Call 95750460384 if this was not made by you.",
      "notes": ""
    },
    {
      "id": "BASE-31",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Alert: You've spent INR 1,369.70 on your AMEX card ** 52137 at DEMO INSURANCE on 17 September 2026 at 02:17 PM IST. Call 95750460384 if this was not made by you.",
      "notes": ""
    },
    {
      "id": "BASE-32",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Alert: You've spent INR 2,016.00 on your AMEX card ** 52137 at DEMO SUBSCRIPTION on 15 September 2026 at 10:45 PM IST. Call 95750460384 if this was not made by you.",
      "notes": ""
    },
    {
      "id": "BASE-33",
      "expectedKind": "CARD_PAYMENT_RECEIVED",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Dear Customer, a payment of INR 3,968.91 was received on your Amex Card ***52137 12/07/2026. It may take 24-48 hours for your payment to be credited. Thank you.",
      "notes": ""
    },
    {
      "id": "BASE-34",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Thank you for using StanChart Credit Card No XX3030 on 13/10/26 for INR 349.67 at DEMO FUEL STATION. Avl Limit: INR 30,931.30. Click https://example.invalid/notice if you have not done this transaction.",
      "notes": ""
    },
    {
      "id": "BASE-35",
      "expectedKind": "BANK_TRANSFER_INFORMATION",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Your a/c no. XXXXXXX4040 is credited for Rs. 38,017.00 on 04-10-2026 11:48 and debited from a/c no. XXXXXXXX5050 (UPI Ref no 972429848961)",
      "notes": ""
    },
    {
      "id": "BASE-36",
      "expectedKind": "ECS_DEBIT_REVIEW",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Your account 456xxxx4040 has been debited on 05/10/2026 by INR 37,750.00 towards ECS.Available Balance:INR 2,156.18 -StanChart",
      "notes": ""
    },
    {
      "id": "BASE-37",
      "expectedKind": "BANK_TRANSFER_INFORMATION",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Rs. 7,717 sent from a/c xx6060 on 12-Oct-26 to DEMO PERSON (UPI Ref: 926571136735). Not you? Call 91880834645 - slice",
      "notes": "This is an intentionally duplicate-equivalent notice or historical reconciliation case."
    },
    {
      "id": "BASE-38",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Rs. 77 spent on your credit card xx7070 at DEMO EATERY on 03-Sep-26 (UPI Ref: 954527936440). Not you? Call 080-4832-9999 - slice",
      "notes": ""
    },
    {
      "id": "BASE-39",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Rs. 167 spent on your credit card xx7070 at DEMO MERCHANT C on 11-Jul-26 (UPI Ref: 968342021109). Not you? Call 080-4832-9999 - slice",
      "notes": ""
    },
    {
      "id": "BASE-40",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Rs. 92 spent on your credit card xx7070 at DEMO MERCHANT B on 12-Jul-26 (UPI Ref: 945873329926). Not you? Call 080-4832-9999 - slice",
      "notes": ""
    },
    {
      "id": "BASE-41",
      "expectedKind": "BANK_DEBIT_REVIEW",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "ICICI Bank Acc XX444 debited Rs. 17,273.00 on 10-Oct-26 InfoBIL*INFT*DEMO.Avl Bal Rs. 14,852.37.To dispute call 91697063 or SMS BLOCK 444 to 9252559501",
      "notes": ""
    },
    {
      "id": "BASE-42",
      "expectedKind": "STATEMENT_REMINDER",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Pay Total Amount Due of Rs 3,315.36 or Minimum Amount Due of Rs 187.00 by 30-Aug-26 towards ICICI Bank Credit Card XX6161. Delay/Non-payment is reported to Credit Bureaus. Ignore if paid.",
      "notes": ""
    },
    {
      "id": "BASE-43",
      "expectedKind": "CARD_PAYMENT_RECEIVED",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Thank you AU Bank Credit Cardholder! Payment of INR 1,623.40 was credited to your Card xx9090 on 07/09/2026. -AU Bank",
      "notes": ""
    },
    {
      "id": "BASE-44",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "INR 216.00 spent using ICICI Bank Card XX6161 on 03-Oct-26 on DEMO ECOMMERCE. Avl Limit: INR 48,818.00. If not you, call 1800 2662/SMS BLOCK 6161 to 9252559501.",
      "notes": ""
    },
    {
      "id": "BASE-45",
      "expectedKind": "LOAN_REMINDER",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "EMI of Rs 17,273 for ICICI Bank Personal Loan XX8080 is due on 10-Aug-26. Please maintain sufficient funds in your linked Account XX5050 to avoid 5% per annum penal charges and Rs 517 bounce charges. EMI will be debited on holidays too. Access your loan related services on iMobile at icici.co/ICICIT/k/DUvOd7lne0G",
      "notes": ""
    },
    {
      "id": "BASE-46",
      "expectedKind": "STATEMENT_REMINDER",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Rs. 409.73 is due on your slice credit card by 5th Oct 2026. Pay now in the slice app - slice",
      "notes": ""
    },
    {
      "id": "BASE-47",
      "expectedKind": "LOAN_REMINDER",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "CRED cash: EMI reminder\n\nEMI of INR 5,103 towards your CRED cash EMI is due in 4 days.\n\nDelayed payment will result in late fees and may negatively affect your CIBIL score. \n\nClick here to pay now: https://example.invalid/notice - CRED",
      "notes": ""
    },
    {
      "id": "BASE-48",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Rs. 217 spent on your credit card xx7070 at DEMO PETROL on 02-Oct-26 (UPI Ref: 937878628349). Not you? Call 080-4832-9999 - slice",
      "notes": ""
    },
    {
      "id": "BASE-49",
      "expectedKind": "IGNORE_NON_TRANSACTION",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Dear Customer, your HSBC Credit Card ending with 1112 has not been used for over 3 months. Kindly transact on your card to enjoy seamless services.",
      "notes": ""
    },
    {
      "id": "BASE-50",
      "expectedKind": "REFUND_CREDIT",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Alert! Rs. 12,217 refunded by DEMO ONLINE RETAILER on 27/SEP/2026 & adjusted against HDFC Bank Credit Card 1213 View updated balance here: https://example.invalid/notice",
      "notes": ""
    },
    {
      "id": "BASE-51",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "A transaction of Rs. 301.00 was made using your HDFC Bank Pixel Play Credit Card at merchant.four@sampleupi via UPI 966158478185 on 21/07/26 at 16:53. Not you? Block your Card: https://example.invalid/notice or SMS BLOCKPCC 8181 to 9101451278",
      "notes": ""
    },
    {
      "id": "BASE-52",
      "expectedKind": "CARD_PAYMENT_RECEIVED",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Update: Payment of Rs 4,273.20 received for your BOBCARD ending 4152 on 2026-09-20. Visit bobcard app: bobcard.io/App or online card account at https://example.invalid/notice for details.",
      "notes": ""
    },
    {
      "id": "BASE-53",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "INR 1,448.00 spent at DEMO DINING on AU Bank Credit Card x9090 11-09-2026 04:27:49 PM. Not you? Call 985372137899 or SMS PBLOCK 9090 to 5676767",
      "notes": ""
    },
    {
      "id": "BASE-54",
      "expectedKind": "REFUND_CREDIT",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "Refund Successful!Rs 1,967.00 from DEMO MEDIA is credited to HDFC Bank Pixel Play credit card xx1314 on 07/08/26 12:08. Click https://example.invalid/notice to view limit.",
      "notes": ""
    },
    {
      "id": "BASE-55",
      "expectedKind": "CARD_PURCHASE",
      "expectedLedgerEffect": "REVIEW_ONLY",
      "sms": "INR 87.00 spent on your credit card ending with 1415 at 910106351458 DEMO STORE on 02-08-2026. Available limit Rs.407,909.00. Not you, call 92999059278 -Federal Bank",
      "notes": ""
    },
    {
      "id": "BASE-56",
      "expectedKind": "PAYMENT_INITIATED",
      "expectedLedgerEffect": "NONE_UNTIL_EXPLICIT_RECONCILIATION",
      "sms": "Sent Rs.919.00\nFrom HDFC Bank A/C *1516\nTo CRED CCBP UPI\nOn 31/07/26\nRef 910623164981\nNot You?\nCall 91129273026/SMS BLOCK UPI to 9331635407",
      "notes": ""
    },
    {
      "id": "EXTRA-01",
      "expectedKind": "PLUXEE_TOPUP",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Your Pluxee Card has been successfully credited with Rs.6240 towards Meal Wallet on Fri Sep 25 2026 04:29:15. Your current Meal Wallet balance is Rs.6250.25.",
      "notes": ""
    },
    {
      "id": "EXTRA-02",
      "expectedKind": "PLUXEE_TOPUP",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Your Pluxee Card has been successfully credited with Rs.9100 towards Meal Wallet on Fri Jul 24 2026 05:21:01. Your current Meal Wallet balance is Rs.9110.84.",
      "notes": ""
    },
    {
      "id": "EXTRA-03",
      "expectedKind": "REFUND_CREDIT",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Transaction of INR 19.00 is refunded to IDFC FIRST Bank Credit Card XX2323 on 11-09-2026. Please refer to your email for details.",
      "notes": ""
    },
    {
      "id": "EXTRA-04",
      "expectedKind": "REFUND_CREDIT",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Refund Successful!Rs 1,967.00 from DEMO MEDIA is credited to HDFC Bank Pixel Play credit card xx1314 on 07/08/26 12:08. Click https://example.invalid/notice to view limit.",
      "notes": "Deliberate exact duplicate of BASE-54; reject repeated import."
    },
    {
      "id": "EXTRA-05",
      "expectedKind": "ECS_DEBIT_REVIEW",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "ICICI Bank Acc XX444 debited Rs. 17,397.00 on 10-Aug-26 InfoBIL*Auto Loan.Avl Bal Rs. 19,374.07.To dispute call 9355945150.",
      "notes": ""
    },
    {
      "id": "EXTRA-06",
      "expectedKind": "ECS_DEBIT_REVIEW",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "ICICI Bank Acc XX444 debited Rs. 17,277.00 on 10-Oct-26 InfoBIL*INFT*DEMO.Avl Bal Rs. 14,852.37.",
      "notes": ""
    },
    {
      "id": "EXTRA-07",
      "expectedKind": "ECS_DEBIT_REVIEW",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Your account 123xxxx4040 has been debited on 05/10/2026 by INR 37,750.00 towards ECS.Available Balance:INR 2,156.18 -StanChart",
      "notes": ""
    },
    {
      "id": "EXTRA-08",
      "expectedKind": "ECS_DEBIT_REVIEW",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Your account has been successfully debited with INR 5,103.00 on 07-Oct-2026 towards IDFC First Bank for MerchantMandate AutoPay, RRN 941069222863 - StanChart",
      "notes": ""
    },
    {
      "id": "EXTRA-09",
      "expectedKind": "IGNORE_OTP",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Your login OTP is 129834. Never share it with anyone.",
      "notes": ""
    },
    {
      "id": "EXTRA-10",
      "expectedKind": "IGNORE_MARKETING",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Exclusive offer: earn 5% cashback when you spend INR 717 tomorrow.",
      "notes": ""
    },
    {
      "id": "EXTRA-11",
      "expectedKind": "CASHBACK_CREDIT",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Congratulations! Cashback of INR 142 has been credited to your Axis Bank Ace Credit Card XX9191 towards your last month spends.",
      "notes": ""
    },
    {
      "id": "EXTRA-12",
      "expectedKind": "CARD_PAYMENT_RECEIVED",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Payment of Rs. 4,334.00 has been received on your ICICI Bank Credit Card XX6161. Statement total due Rs. 4,324.00.",
      "notes": ""
    },
    {
      "id": "EXTRA-13",
      "expectedKind": "FASTAG_TOPUP",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "FASTag wallet for KA01AB1234 has been recharged with INR 667.00. Available balance INR 834.00. - DEMO BANK",
      "notes": ""
    },
    {
      "id": "EXTRA-14",
      "expectedKind": "FASTAG_TOLL",
      "expectedLedgerEffect": "NONE_UNTIL_APPROVED",
      "sms": "Toll Paid! Rs.92.00 for KA02CD5678 At DEMO PLAZA C On 2026-08-07 13:57:10 Wallet Bal Rs.437.00 - DEMO BANK",
      "notes": ""
    }
  ]
}
```
