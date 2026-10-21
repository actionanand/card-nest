import { CardTransaction, CreditCard, PaymentSource } from '../../core/models/domain';
import { eligibleSources, ledgerType, normalizedIssuer, SmsEvidence } from './sms-model';

export interface ExistingMatch {
  confidence:
    'HIGH_CONFIDENCE_EXISTING' | 'POSSIBLE_EXISTING' | 'AMBIGUOUS' | 'NO_MATCH' | 'EVIDENCE_ONLY';
  transactionIds: readonly string[];
  sourceId?: string;
  reason: string;
}

/** Shared words support a match, but never establish a source or an amount. */
export function merchantSimilarity(left: string | undefined, right: string | undefined): boolean {
  const words = (text: string | undefined) =>
    (text ?? '')
      .toLowerCase()
      .replace(/\b(?:myjio|jiofiber|jioairfiber)\b/g, 'jio')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(
        (word) =>
          word.length >= 3 &&
          ![
            'payment',
            'purchase',
            'card',
            'online',
            'transaction',
            'via',
            'using',
            'the',
            'ltd',
            'private',
            'market',
            'store',
            'grocery',
            'groceries',
            'bakery',
            'restaurant',
            'international',
            'bangalore',
            'limited',
          ].includes(word),
      );
  const a = new Set(words(left));
  const b = new Set(words(right));
  const common = [...a].filter((word) => b.has(word));
  // A single short generic word is weak evidence. Long, distinctive names can support aliases.
  return common.length >= 2 || common.some((word) => word.length >= 5 || word === 'jio');
}

export function matchExisting(
  item: SmsEvidence,
  cards: readonly CreditCard[],
  sources: readonly PaymentSource[],
  ledger: readonly CardTransaction[],
  claimed: ReadonlySet<string> = new Set(),
): ExistingMatch {
  const type = ledgerType(item);
  if (!type)
    return {
      confidence: 'EVIDENCE_ONLY',
      transactionIds: [],
      reason:
        'Scheduled charges, bank, initiation, loan and statement evidence cannot automatically create or confirm spending.',
    };
  let ids = eligibleSources(item, cards, sources);
  const missingMealDigits =
    item.kind.startsWith('PLUXEE') && !item.cardDigits && !item.accountDigits;
  if (missingMealDigits)
    ids = sources
      .filter((source) => source.kind === 'MEAL' && !source.archived)
      .map((source) => source.id);
  if (ids.length !== 1) {
    const possibleSources = ids.length
      ? ids
      : !item.cardDigits &&
          !item.accountDigits &&
          !item.kind.startsWith('PLUXEE') &&
          !item.kind.startsWith('FASTAG')
        ? cards
            .filter(
              (card) =>
                !card.deletedAt &&
                card.currencyCode === item.currency &&
                (!card.archived ||
                  (!!card.archivedAt && item.eventDate <= card.archivedAt.slice(0, 10))) &&
                (!item.issuer ||
                  normalizedIssuer(item.issuer) === normalizedIssuer(card.issuerName)),
            )
            .map((card) => card.id)
        : [];
    const suggestions = item.dateFallback
      ? []
      : ledger
          .filter(
            (entry) =>
              possibleSources.includes(entry.cardId) &&
              entry.type === type &&
              entry.currencyCode === item.currency &&
              entry.amountMinor === item.amountMinor &&
              entry.transactionDate === item.eventDate,
          )
          .sort(
            (a, b) =>
              Number(merchantSimilarity(item.merchant, b.merchant)) -
                Number(merchantSimilarity(item.merchant, a.merchant)) || a.id.localeCompare(b.id),
          )
          .slice(0, 20);
    return {
      confidence: suggestions.length ? 'POSSIBLE_EXISTING' : ids.length ? 'AMBIGUOUS' : 'NO_MATCH',
      transactionIds: suggestions.map((entry) => entry.id),
      reason: ids.length
        ? 'Multiple eligible sources; confirm the source.'
        : suggestions.length
          ? 'Possible existing transactions found. Source identity is unconfirmed; choose and verify a record before linking.'
          : 'No trustworthy saved source identity. Confirm a source before linking.',
    };
  }
  const sourceId = ids[0];
  const nearby = ledger.filter(
    (entry) =>
      entry.cardId === sourceId &&
      entry.currencyCode === item.currency &&
      entry.type === type &&
      entry.amountMinor === item.amountMinor &&
      Math.abs(Date.parse(entry.transactionDate) - Date.parse(item.eventDate)) <= 86400000 * 3,
  );
  // Nearby dates are suggestions only; they must not obscure an exact local-date occurrence.
  const exact = item.dateFallback
    ? []
    : nearby.filter((entry) => entry.transactionDate === item.eventDate);
  const plausible = exact.length ? exact : nearby;
  if (!plausible.length)
    return {
      confidence: 'NO_MATCH',
      sourceId,
      transactionIds: [],
      reason: 'No compatible existing entry within the review date window.',
    };
  const supporting = plausible.filter((entry) => {
    if (item.reference && entry.reference && item.reference !== entry.reference) return false;
    const reference = !!item.reference && !!entry.reference && item.reference === entry.reference;
    const time =
      item.eventTimeExplicit !== true ||
      !entry.transactionTime ||
      !item.eventTime ||
      entry.transactionTime.slice(0, 5) === item.eventTime.slice(0, 5);
    return (
      (!entry.recurringRuleId ||
        !entry.generatedOccurrenceDate ||
        entry.generatedOccurrenceDate === item.eventDate) &&
      entry.transactionDate === item.eventDate &&
      !item.dateFallback &&
      time &&
      (reference || merchantSimilarity(item.merchant, entry.merchant))
    );
  });
  // Multiple exact-date records still need confirmation; nearby records are only suggestions.
  const automatic =
    plausible.length === 1 && supporting.length === 1 && !claimed.has(supporting[0].id);
  return {
    confidence: automatic
      ? 'HIGH_CONFIDENCE_EXISTING'
      : plausible.length > 1
        ? 'AMBIGUOUS'
        : 'POSSIBLE_EXISTING',
    sourceId,
    transactionIds: (automatic ? supporting : plausible).map((entry) => entry.id),
    reason: automatic
      ? `Unique existing entry: trusted ${missingMealDigits ? 'single meal wallet' : 'source identity'}, exact amount and type, explicit local date, compatible recorded time.`
      : plausible.some((entry) => !!entry.recurringRuleId)
        ? 'Possible existing recurring transaction. Select and confirm the correct occurrence.'
        : claimed.has(plausible[0].id)
          ? 'An existing entry is already linked to other SMS evidence; confirm this relationship manually.'
          : plausible.length > 1
            ? 'Multiple compatible existing entries; select the correct transaction.'
            : 'Possible existing transaction. Conflicting details or a nearby date require confirmation.',
  };
}

export interface WalletComparison {
  current: number;
  reported: number;
  expected: number;
  expectedAfter: number;
  difference: number;
  canAdjust: boolean;
  explanation: string;
}
export function walletComparison(
  item: SmsEvidence,
  source: PaymentSource,
  ledger: readonly CardTransaction[],
  recordedId?: string,
): WalletComparison | null {
  if (
    !item.kind.startsWith('PLUXEE') ||
    source.kind !== 'MEAL' ||
    source.noLimit ||
    !Number.isSafeInteger(source.balanceMinor) ||
    !Number.isSafeInteger(item.reportedBalanceMinor)
  )
    return null;
  const current = source.balanceMinor!;
  const reported = item.reportedBalanceMinor!;
  const recorded = recordedId
    ? ledger.find((entry) => entry.id === recordedId && entry.cardId === source.id)
    : undefined;
  const historical =
    !!source.balanceCutoverAt && Date.parse(item.eventAt) <= Date.parse(source.balanceCutoverAt);
  const newer = ledger.some(
    (entry) =>
      entry.cardId === source.id &&
      entry.id !== recordedId &&
      entry.transactionDate >= item.eventDate,
  );
  const eventDelta = item.kind === 'PLUXEE_PURCHASE' ? -item.amountMinor : item.amountMinor;
  const expectedAfter = current + (recorded || historical ? 0 : eventDelta);
  const expected =
    item.balancePosition === 'BEFORE' && !historical ? expectedAfter - eventDelta : expectedAfter;
  const trusted =
    item.balancePosition === 'AFTER' &&
    !source.archived &&
    (!item.cardDigits || item.cardDigits === source.lastDigits) &&
    !item.accountDigits &&
    !item.dateFallback &&
    !historical &&
    !newer &&
    reported >= 0 &&
    Number.isSafeInteger(expected);
  return {
    current,
    reported,
    expected,
    expectedAfter,
    difference: reported - expected,
    canAdjust: trusted,
    explanation: historical
      ? 'This snapshot is not newer than the saved cutover. Keep the current balance.'
      : newer
        ? 'Same-day or later activity makes ordering uncertain. Keep the current balance.'
        : item.balancePosition !== 'AFTER'
          ? 'The message does not establish whether this balance is before or after the event.'
          : recorded
            ? 'The transaction is already recorded. Its amount is not applied again.'
            : 'Post-event prediction includes this purchase or top-up once after approval.',
  };
}
