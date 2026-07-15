import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CreditCard } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { AppIcon } from '../../shared/app-icon';
import { CardNetworkLogo } from '../../shared/card-network-logo';

type UsageBand = 'THREE' | 'SIX' | 'YEAR' | 'OLDER' | 'NEVER';

@Component({
  selector: 'app-card-usage-page',
  imports: [RouterLink, AppIcon, CardNetworkLogo],
  templateUrl: './card-usage.html',
  styleUrl: './card-usage.scss',
})
export class CardUsagePage {
  readonly store = inject(CardNestStore);
  readonly accountGroups = computed(() => {
    const groups = new Map<string, CreditCard[]>();
    for (const card of this.store.activeCards()) {
      const key = card.relationshipGroupId?.trim() || card.id;
      groups.set(key, [...(groups.get(key) ?? []), card]);
    }
    return [...groups.entries()]
      .map(([key, cards]) => {
        const cardIds = new Set(cards.map((card) => card.id));
        const lastUsed = this.store
          .transactions()
          .filter(
            (transaction) =>
              cardIds.has(transaction.cardId) &&
              ['PURCHASE', 'FEE', 'INTEREST'].includes(transaction.type),
          )
          .map((transaction) => transaction.transactionDate)
          .sort()
          .at(-1);
        return {
          key,
          name: cards[0]?.relationshipGroupId || cards[0]?.nickname || key,
          cards,
          lastUsed,
          band: this.band(lastUsed),
          daysUnused: lastUsed
            ? Math.max(
                0,
                Math.floor((Date.now() - new Date(`${lastUsed}T12:00:00`).getTime()) / 86_400_000),
              )
            : null,
        };
      })
      .sort((a, b) => (a.lastUsed ?? '').localeCompare(b.lastUsed ?? ''));
  });
  readonly bands: readonly { id: UsageBand; title: string; description: string }[] = [
    { id: 'NEVER', title: 'Never used', description: 'No purchase is recorded for this account.' },
    {
      id: 'OLDER',
      title: 'Beyond one year',
      description: 'Use soon or review whether to keep it.',
    },
    {
      id: 'YEAR',
      title: 'Unused for 6–12 months',
      description: 'Consider a small planned purchase.',
    },
    { id: 'SIX', title: 'Unused for 3–6 months', description: 'A gentle usage reminder.' },
    { id: 'THREE', title: 'Used within 3 months', description: 'Recently active accounts.' },
  ];

  groupsFor(band: UsageBand) {
    return this.accountGroups().filter((group) => group.band === band);
  }

  private band(lastUsed: string | undefined): UsageBand {
    if (!lastUsed) return 'NEVER';
    const months =
      (Date.now() - new Date(`${lastUsed}T12:00:00`).getTime()) / (86_400_000 * 30.4375);
    if (months > 12) return 'OLDER';
    if (months > 6) return 'YEAR';
    if (months > 3) return 'SIX';
    return 'THREE';
  }
}
