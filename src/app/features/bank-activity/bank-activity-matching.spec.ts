import {
  activityMatch,
  finalThree,
  matchesBank,
  normalizedBank,
  selectionMatches,
} from './bank-activity-matching';
import type { BankActivityCandidate, BankActivityProfile } from './bank-activity-model';
const profile: BankActivityProfile = {
  id: 'profile',
  bankName: 'ICICI Bank',
  accountSuffix: '123',
  owner: 'OWN',
  archived: false,
  createdAt: 'before',
  updatedAt: 'before',
};
const candidate: BankActivityCandidate = {
  fingerprint: 'fiction',
  activityDate: '2026-10-27',
  direction: 'DEBIT',
  bankName: 'ICICI',
  accountSuffix: '123',
  purposeHint: 'PURCHASE',
  createdAt: 'before',
};
describe('Independent bank and masked originating-account evidence', () => {
  it('does not preselect a stale or contradictory linked source identity', () => {
    const linked = { ...profile, paymentSourceId: 'bank' };
    expect(selectionMatches(candidate, linked, [])).toBe(false);
    expect(
      selectionMatches(candidate, linked, [
        { id: 'bank', lastDigits: '456', institution: 'ICICI' },
      ]),
    ).toBe(false);
    expect(
      selectionMatches(candidate, linked, [{ id: 'bank', lastDigits: '123', institution: 'HDFC' }]),
    ).toBe(false);
    expect(
      activityMatch(
        candidate,
        [linked],
        [{ id: 'bank', kind: 'DEBIT', lastDigits: '456', institution: 'ICICI' }],
      ).suggestedId,
    ).toBeUndefined();
  });
  it.each([
    ['123', '123'],
    ['9123', '123'],
    ['45123', '123'],
    ['12007', '007'],
    ['007', '007'],
  ])('compares final three digits %s → %s without dropping zeros', (value, expected) =>
    expect(finalThree(value)).toBe(expected),
  );
  it.each(['12', '123456', 'ab123', '12 3', '', undefined])(
    'rejects untrustworthy account suffix %s',
    (value) => expect(finalThree(value)).toBeUndefined(),
  );
  it.each([
    ['ICICI', 'ICICI Bank'],
    ['HDFC Bank', 'HDFC'],
    ['HSBC', 'HSBC Bank'],
    ['SBI', 'State Bank of India'],
    ['Axis', 'Axis Bank'],
  ])('recognizes explicit bank aliases %s and %s', (left, right) =>
    expect(matchesBank(left, right)).toBe(true),
  );
  it('does not conflate unknown institutions or bank names with the same suffix', () => {
    expect(matchesBank('Fiction West', 'Fiction East')).toBe(false);
    expect(matchesBank('HSBC', 'HSBC Holdings')).toBe(false);
    expect(matchesBank('HDFC', 'ICICI')).toBe(false);
    expect(normalizedBank(undefined)).toBe('');
  });
  it('suggests a unique account while explicitly requiring confirmation', () => {
    expect(activityMatch(candidate, [profile], [])).toMatchObject({
      state: 'UNIQUE',
      suggestedId: profile.id,
    });
    expect(activityMatch(candidate, [profile], []).reason).toContain('confirmation is required');
  });
  it('suggests one account by suffix only when the bank is missing or unrecognized', () => {
    for (const bankName of [undefined, 'Unrecognized issuer']) {
      expect(activityMatch({ ...candidate, bankName }, [profile], [])).toMatchObject({
        state: 'UNIQUE',
        suggestedId: profile.id,
      });
      expect(activityMatch({ ...candidate, bankName }, [profile], []).reason).toContain(
        'does not prove bank identity',
      );
    }
    expect(activityMatch({ ...candidate, bankName: 'HDFC' }, [profile], []).state).toBe(
      'BANK_MISMATCH',
    );
  });
  it('counts archived and linked source identities when suffix-only matches are ambiguous', () => {
    const unknownBank = { ...candidate, bankName: undefined };
    const profileAmbiguity = activityMatch(
      unknownBank,
      [profile, { ...profile, id: 'archived', archived: true }],
      [],
    );
    expect(profileAmbiguity.state).toBe('AMBIGUOUS');
    expect(profileAmbiguity.suggestedId).toBeUndefined();
    const sourceAmbiguity = activityMatch(
      unknownBank,
      [profile],
      [
        { id: 'active-source', kind: 'DEBIT', institution: 'ICICI', lastDigits: '123' },
        {
          id: 'archived-source',
          kind: 'DEBIT',
          institution: 'Fictional bank',
          lastDigits: '123',
          archived: true,
        },
      ],
    );
    expect(sourceAmbiguity.state).toBe('AMBIGUOUS');
    expect(sourceAmbiguity.suggestedId).toBeUndefined();
    const sourceOnly = activityMatch(
      unknownBank,
      [],
      [{ id: 'source-only', kind: 'DEBIT', institution: 'ICICI', lastDigits: '123' }],
    );
    expect(sourceOnly).toMatchObject({ state: 'SOURCE_ONLY', sourceId: 'source-only' });
    expect(sourceOnly.suggestedId).toBeUndefined();
  });
  it('distinguishes an exact-bank source without a monitoring profile from a bank conflict', () => {
    expect(
      activityMatch(
        candidate,
        [],
        [{ id: 'existing-source', kind: 'DEBIT', institution: 'ICICI Bank', lastDigits: '45123' }],
      ),
    ).toMatchObject({ state: 'SOURCE_ONLY', sourceId: 'existing-source' });
    expect(
      activityMatch(
        candidate,
        [],
        [
          {
            id: 'archived-source',
            kind: 'DEBIT',
            institution: 'ICICI Bank',
            lastDigits: '45123',
            archived: true,
          },
        ],
      ),
    ).toMatchObject({ state: 'ARCHIVED' });
    expect(
      activityMatch(
        candidate,
        [{ ...profile, paymentSourceId: 'archived-source' }],
        [
          {
            id: 'archived-source',
            kind: 'DEBIT',
            institution: 'ICICI Bank',
            lastDigits: '45123',
            archived: true,
          },
        ],
      ),
    ).toMatchObject({ state: 'ARCHIVED' });
    expect(
      activityMatch(
        candidate,
        [],
        [
          { id: 'active-source', kind: 'DEBIT', institution: 'ICICI Bank', lastDigits: '45123' },
          {
            id: 'archived-source',
            kind: 'DEBIT',
            institution: 'ICICI Bank',
            lastDigits: '45123',
            archived: true,
          },
        ],
      ),
    ).toMatchObject({ state: 'AMBIGUOUS' });
  });
  it('does not call a standalone profile unique when a matching linked source also exists', () => {
    const competingSource = {
      id: 'unlinked-source',
      kind: 'DEBIT' as const,
      institution: 'ICICI Bank',
      lastDigits: '45123',
    };
    expect(activityMatch(candidate, [profile], [competingSource])).toMatchObject({
      state: 'AMBIGUOUS',
      profileIds: [profile.id],
    });
    const linked = { ...profile, paymentSourceId: competingSource.id };
    expect(activityMatch(candidate, [linked], [competingSource])).toMatchObject({
      state: 'UNIQUE',
      suggestedId: linked.id,
    });
    const sharedStandalone = activityMatch(candidate, [profile, { ...profile, id: 'family' }], []);
    expect(sharedStandalone.state).toBe('AMBIGUOUS');
    expect(sharedStandalone.suggestedId).toBeUndefined();
  });
  it('retains ambiguity across profiles, archived matches and multiple linked sources', () => {
    expect(
      activityMatch(
        candidate,
        [profile, { ...profile, id: 'family', owner: 'OTHERS', holderName: 'Fiction Alex' }],
        [],
      ),
    ).toMatchObject({ state: 'AMBIGUOUS', profileIds: ['profile', 'family'] });
    expect(activityMatch(candidate, [{ ...profile, archived: true }], [])).toMatchObject({
      state: 'ARCHIVED',
    });
    const sources = [
      { id: 'a', kind: 'DEBIT' as const, institution: 'ICICI', lastDigits: '45123' },
      { id: 'b', kind: 'DEBIT' as const, institution: 'ICICI', lastDigits: '9123' },
    ];
    expect(activityMatch(candidate, [profile], sources).state).toBe('AMBIGUOUS');
  });
  it('never preselects mismatched, incomplete or manual-only identities', () => {
    expect(activityMatch({ ...candidate, bankName: 'HDFC' }, [profile], []).state).toBe(
      'BANK_MISMATCH',
    );
    expect(activityMatch({ ...candidate, accountSuffix: '456' }, [profile], []).state).toBe(
      'SUFFIX_MISMATCH',
    );
    expect(activityMatch({ ...candidate, accountSuffix: undefined }, [profile], []).state).toBe(
      'MISSING',
    );
    expect(activityMatch({ ...candidate, bankName: undefined }, [profile], []).state).toBe(
      'UNIQUE',
    );
    expect(activityMatch(candidate, [], []).state).toBe('NEW');
    expect(
      activityMatch(candidate, [{ ...profile, manualOnly: true }], []).suggestedId,
    ).toBeUndefined();
    expect(selectionMatches(candidate, { ...profile, manualOnly: true }, [])).toBe(false);
  });
  it('compares legacy four/five-digit profiles and linked sources without rewriting them', () => {
    const legacy = { ...profile, accountSuffix: '45123' };
    expect(selectionMatches(candidate, legacy, [])).toBe(true);
    expect(legacy.accountSuffix).toBe('45123');
    expect(
      selectionMatches(
        candidate,
        { ...profile, accountSuffix: undefined, paymentSourceId: 'bank' },
        [{ id: 'bank', lastDigits: '9123' }],
      ),
    ).toBe(true);
  });
});
