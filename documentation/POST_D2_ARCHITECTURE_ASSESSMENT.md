# Post-D2 Architecture Assessment

Baseline: `b1411f3d7ca523f988d5c773db05229759390181`; branch `feature/11-split-payment-redesign-extra-attention`.

## Existing Data Flow

- Money Sources are serialized in `app_preferences.payment_sources`. `PaymentSource.id` is the stable source identifier used by transactions through `CardTransaction.cardId`; source balances, cutovers, masks, and wallet metadata are part of that JSON payload.
- Bank Activity identity profiles and activity events use `bank_activity_profiles` and `bank_activity_events`. SMS evidence remains in `sms_candidates`; unresolved discovery evidence is separately retained in `bank_activity_candidates`. Identity resolution and financial approval are distinct operations.
- Bank/Cash tracking currently has one combined `bank_cash_tracking` JSON setting. Confirmed baselines are stored on each source; changes create rows in `source_balance_adjustments`. Transaction balance effects are stored on transaction payloads. Transfers are stored in `source_transfers` with per-source effects.
- Utility profiles/recharges/events use `utility_profiles`, `mobile_recharges`, and `lpg_events`; child rows use cascading foreign keys. These are unrelated to the requested bank/Cash setting split.
- The current schema is migration 14. Portable backups export the SQLite state and encrypt it through the existing backup service; no backup format change is needed for additive JSON properties or the proposed new audit table.
- Categories are defined by `default-categories.json`, `category-matching-rules.json`, and the versioned registry in `src/app/core/data/category-definitions.ts`. Catalog reconciliation stores canonical-to-user row mappings and deletion state in `category_catalog_state`; category reference remapping also updates recurring rules and saved SMS review drafts.

## Constraints and Planned Persistence

- Add bank-account metadata as optional fields in the existing source JSON, retaining IDs and all historic transaction links. Keep only the final-three suffix, a safe mask, optional IFSC, and a one-way normalized-account fingerprint; never persist or log the complete account number.
- Keep primary-bank selection as a stable source ID in `app_preferences`; initialize from the first eligible real owned bank and retire the generic placeholder from active choices without deleting it or rewriting its historical transaction links.
- Split tracking flags in the existing setting JSON with backward-compatible parsing of legacy `enabled` as both flags. Reuse existing baseline and adjustment tables; add a small audit discriminator only if existing adjustment reasons cannot represent additive balance operations correctly. No source transaction is created for a baseline/correction.
- Derive latest confirmed bank activity from approved source-linked transactions and transfers, while preserving manual/SMS activity provenance. Do not write activity for pending SMS or balance-only corrections. Keep the 18-hour matcher and transaction approvals unchanged.
- No migration is planned for JSON-only settings/source fields. If a distinct persistent audit/projection table is proven necessary, add only the next migration after verifying backup import/export and older-version restore behavior.

## Explicitly Preserved Areas

Existing split-payment relationships, card ledgers, loans/EMIs, recurring transactions, FASTag, Pluxee, SMS permissions and review decisions, Bank Activity ownership rules, LPG calculations, Android version/signing, and encrypted portable-backup format are outside account/source/category changes unless a specific requirement above requires a narrow integration.
