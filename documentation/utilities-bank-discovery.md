# Utilities dialogs and confirmation-only Bank Activity

The reference screenshots show white captions over bright Mobile and Cooking Gas photographs and inline profile forms. All four existing JPGs are retained. The image previously had `z-index: 1`, above the automatically layered `::after` gradient. Cards now establish their own stacking context: image 0, dark gradient 1, caption 2, with selection/focus outlines outside the card. The bottom scrim reaches 94% opacity while the upper photograph stays visible. A translucent caption surface also guarantees at least 4.5:1 white-text contrast even over a solid white photograph; a regression test checks this worst case mathematically. Typography wraps and card height can grow with the caption. Mobile navigation remains two columns and the selected green outline is retained.

## Shared profile popup

`ProfileModal` wraps a native HTML `dialog`. Mobile Add/Edit, LPG Add/Edit, and monitored-bank Add/Edit project their existing forms into it; recharge and cylinder-event workflows remain unchanged. The popup occupies the browser top layer, above floating app controls. Existing custom picker dialogs open on a higher top layer without fragile z-index competition.

The dialog includes a labelled heading, initial field focus, a Tab loop, Escape and Android Back cancellation, an outside backdrop, shared nested scroll locking, and restoration to the invoking control. Cancellation is blocked during a save. Scrollable content uses dynamic viewport height and safe-area insets, with sticky form actions. A phone uses a bottom sheet; wider layouts use a centered popup. Failed persistence keeps the form and error visible. Existing saving guards prevent repeated Save taps from creating duplicate profiles. Native dialog behaviour also makes the background inert in supported browsers/WebViews.

## Bank identities and profile creation

Standalone SMS-matchable profiles require exactly three ASCII numeric digits, preserving zeros such as `007`. Four/five-digit _new standalone entries_ are rejected. Linked saved bank sources retain their stable source ID and original three/four/five-digit suffix; the monitoring profile derives only the final three. The picker shows each saved nickname and masked three-to-five-digit suffix so accounts sharing the final three remain distinguishable. A suffix-free profile requires explicit manual-only monitoring. If a linked source lacks trustworthy digits, the user can supply three digits explicitly or choose manual-only mode.

Legacy profile suffixes of four/five digits remain readable and compare by their final three. Explicit editing normalizes the displayed value without changing history IDs. Manual-only profiles are not automatically suggested as SMS identities. Missing, contradictory or stale linked-source evidence prevents preselection and requires independent verification. Profiles remain usable for manual activity on the web or without SMS permission.

`data/bank-aliases.json` centralizes the supplied ICICI/ICICI Bank, HDFC/HDFC Bank, SBI/State Bank of India and Axis/Axis Bank aliases. Matching is deterministic and compares bank identity and originating-account suffix independently. Unknown institutions require their own exact normalized name; unrelated banks are never equated by a suffix. Counterparty digits are never substituted for originating digits.

Duplicate checks run inside the profile transaction and include archived profiles. The same stable payment-source ID cannot acquire a second monitoring profile. Same-bank suffix collisions require both explicit identity-conflict acknowledgement and a distinguishing nickname or holder name. Different banks may share a suffix. No balance or financial payment source is created or modified by profile creation.

## Confirmation-only SMS activity

The existing SMS staging pipeline still supplies parsed evidence to `BankActivityService`; there is no second parser or provider scan. The forwarder honours the existing retention cutoff and parser version. A valid financial alert always queues a pending candidate, even when one bank/profile matches exactly. It never writes activity history or changes the last qualifying date automatically.

Match states distinguish unique hints, ambiguous profiles/sources, bank mismatch, suffix mismatch, missing identity, archived profiles and new accounts. A unique hint is preselected for review. Ambiguity clears automatic selection while preserving an explicit active-account choice. Missing or conflicting selections require a separate acknowledgement of independent verification. The user then sees **Record this account activity?** and must choose **Confirm activity**. Cancel writes nothing.

Final approval rereads the candidate and active profile in a SQLite transaction, validates the date, direction, purpose and candidate identity, checks the selected account, and deduplicates by fingerprint. It inserts one activity event and resolves the candidate together. Every new SMS event uses `USER_CONFIRMED`, including an exact unique match. Signals publish only after commit; failed candidate resolution rolls back the inserted event. Old `SOURCE_MATCHED` history is retained and labelled as previously source matched.

Only Bank Activity events and candidate resolution change on approval. Purchases, split groups, source balances/snapshots, credit-card balances, transfers, reports and SMS financial review decisions remain untouched. Tests compare the actual persisted financial tables and signals before/after confirmation and after a forced rollback.

## Discovery and explicit synchronization

**Discovered bank accounts** groups unmonitored pending evidence by normalized bank plus final-three hint. Incomplete identities remain separate. This is a provisional display grouping, not a merge of accounts or evidence fingerprints: different accounts can share three digits. The group displays the most recent qualifying event date, pending event count and unconfirmed ownership. Individual event suggestions remain reviewable, including cautious matching to an existing monitored profile.

**Review & add account** opens the shared bank dialog with only bank name and suffix prefilled. Ownership is blank, and nickname, holder, remarks and source link are not inferred. Saving creates only a monitoring profile. Its historical suggestions still require individual review and confirmation. Cancel preserves the pending evidence. Dismiss atomically marks the group's exact fingerprints dismissed; rescanning the same evidence cannot immediately recreate it. New independent evidence can appear later.

On Android, **Find accounts from SMS** replays already-staged parsed alerts locally. It never reads the phone provider itself, requests permissions or scans on page open. The existing Android message-review link supplies the established authorization/scan workflow when more evidence is needed. Replay processes up to five 200-row batches per action and checkpoints its cursor. Repeating the action resumes after interruption; already-staged/resolved/dismissed fingerprints stay idempotent. Existing retention controls are applied. The web keeps manual monitoring fully functional and hides device discovery controls.

Qualification retains the conservative completed-bank-event policy: supported debit/credit/transfer kinds and appropriate purchase, transfer, repayment, withdrawal or incoming purposes. Fallback dates, old/uncertain parser evidence, unsupported types, statements, reminders, OTPs, failed/reversed/pending events, fees, interest, mandates, automatic debits and NACH/ECS/EMI descriptions are excluded. Incoming activity also needs the existing supporting counterparty/merchant evidence. No qualification rule is loosened to increase discovery counts.

## Storage and privacy

No SQLite schema migration is required. Existing profile/candidate JSON adds optional `manualOnly`, `kind`, `resolvedAt` and `resolvedProfileId` fields. Existing candidate rows provide dismissed/resolved fingerprint tombstones. Bank Activity stores only the fingerprint, normalized/display bank, final-three identifier, date, direction, purpose, safe optional reference and review metadata. It does not copy merchant text, raw SMS bodies, counterparty account digits, full account numbers or balances into discovery storage.

The existing encrypted backup tables include profiles, activity events, candidate tombstones and replay preferences. Pending discovery, dismissed evidence, confirmed/manual history and manual-only profiles survive restart/restore. A portable restore resets only the local replay cursor because imported SQLite rowids are rebuilt; pending evidence remains intact and replay restarts idempotently. Older records without the new optional fields remain readable. Account archival does not relink or approve candidates. Native parser sources and permissions, Android version metadata, categories and the split/duplicate accounting algorithms are unchanged.

## Verification and remaining device checks

Run the full Angular suite, lint, SMS fixtures, production web/Android builds, web SMS isolation, Capacitor sync, Android integration checks, native JUnit and `git diff --check`. Scan all Angular HTML/inline templates for native `<select>` elements. Coverage includes aliases, masked-suffix lengths, leading zeros, family/manual-only profiles, duplicate conflicts, caption layers/contrast, light/dark semantic accessibility, modal focus/Back/nested pickers, staged discovery, explicit confirmation, rollback, financial isolation and encrypted restoration. The existing 13 SMS split-continuity cases remain part of the full suite.

The local preview server started, but the available in-app browser could not reach its localhost address. No rendered viewport or Android-device visual validation is claimed. Manually check 320/360/390/412px and desktop/tablet layouts, selected/unselected cards, large WebView fonts, long labels, light/dark colours, TalkBack, virtual keyboard resizing, safe areas, sticky actions, focus restoration after errors/success, nested picker Back behaviour and interrupted discovery on a real device.

## Changed files

Local validation on 27 October 2026 passed: 612 Angular tests across 51 files, all 160 freshly rerun native JUnit tests (zero skipped), 70 SMS fixtures, 9 Android integration checks, lint, TypeScript, whitespace and the all-template native-select scan. Production web/Android builds, web SMS isolation and Capacitor sync passed. Initial-bundle and existing cards stylesheet budget warnings remain below their error limits. Optional Windows compiler-cache, jsdom scrollTo and Gradle deprecation notices are non-failing. The browser preview was unavailable as explained above. Version metadata remains 1.1.12 / 52; no permissions or release/signing workflows changed.

Implementation and regression files (this report is also new):

- `src/app/core/data/bank-cash-tracking.integration.spec.ts`
- `src/app/core/data/sqlite-backup.integration.spec.ts`
- `src/app/core/data/sqlite-database.ts`
- `src/app/features/bank-activity/bank-activity-matching.spec.ts`
- `src/app/features/bank-activity/bank-activity-matching.ts`
- `src/app/features/bank-activity/bank-activity-model.ts`
- `src/app/features/bank-activity/bank-activity-ui.spec.ts`
- `src/app/features/bank-activity/bank-activity.html`
- `src/app/features/bank-activity/bank-activity.scss`
- `src/app/features/bank-activity/bank-activity.service.spec.ts`
- `src/app/features/bank-activity/bank-activity.service.ts`
- `src/app/features/bank-activity/bank-activity.ts`
- `src/app/features/bank-activity/data/bank-aliases.json`
- `src/app/features/sms-sync/sms-review.service.ts`
- `src/app/features/utilities/utilities.html`
- `src/app/features/utilities/utilities.scss`
- `src/app/features/utilities/utilities.spec.ts`
- `src/app/features/utilities/utilities.ts`
- `src/app/shared/profile-modal.spec.ts`
- `src/app/shared/profile-modal.ts`
