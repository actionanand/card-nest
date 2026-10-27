/** Monitoring only. Ledger, SMS financial evidence and source balances are never touched. */
export const RECONCILE_BANK_ACTIVITY_LATEST = [
  // Every formerly confirmed fingerprint survives deletion/replacement as a compact tombstone.
  `INSERT INTO bank_activity_candidates(fingerprint,payload,created_at)
   SELECT fingerprint,json_object('fingerprint',fingerprint,'dismissed',json('true'),'resolvedAt',updated_at,'resolvedProfileId',profile_id),created_at
   FROM bank_activity_events WHERE fingerprint IS NOT NULL
   ON CONFLICT(fingerprint) DO UPDATE SET payload=excluded.payload
   WHERE CASE WHEN json_valid(bank_activity_candidates.payload)
     THEN NOT COALESCE(json_extract(bank_activity_candidates.payload,'$.dismissed'),0)
       AND json_extract(bank_activity_candidates.payload,'$.resolvedAt') IS NULL
     ELSE 1 END`,
  // Date-only evidence ties are stable by ID, never by the order of a scan.
  `DELETE FROM bank_activity_events WHERE id NOT IN (
     SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY profile_id,direction ORDER BY activity_date DESC,id ASC) AS position
       FROM bank_activity_events
       WHERE activity_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
         AND date(activity_date,'+0 days')=activity_date
         AND activity_date<=date('now','+5 hours','+30 minutes')
         AND CASE WHEN json_valid(payload) THEN
           json_extract(payload,'$.id')=id
           AND json_extract(payload,'$.profileId')=profile_id
           AND json_extract(payload,'$.activityDate')=activity_date
           AND json_extract(payload,'$.direction')=direction
           ELSE 0 END
     ) WHERE position=1
   )`,
] as const;
