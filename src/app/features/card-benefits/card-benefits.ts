import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardNetwork } from '../../core/models/domain';
import { CardNestStore } from '../../core/services/card-nest-store';
import { AppIcon } from '../../shared/app-icon';
import { CardNetworkLogo } from '../../shared/card-network-logo';

@Component({
  selector: 'app-card-benefits-page',
  imports: [RouterLink, AppIcon, CardNetworkLogo],
  templateUrl: './card-benefits.html',
  styleUrl: './card-benefits.scss',
})
export class CardBenefitsPage {
  readonly store = inject(CardNestStore);
  readonly search = signal('');
  readonly benefitGroups = computed(() => {
    const term = this.search().trim().toLocaleLowerCase();
    const groups = new Map<
      string,
      {
        name: string;
        cards: { cardId: string; nickname: string; network: CardNetwork; note?: string }[];
      }
    >();
    for (const card of this.store.activeCards()) {
      for (const benefit of card.benefits ?? []) {
        const key = benefit.name.trim().toLocaleLowerCase();
        const group = groups.get(key) ?? { name: benefit.name.trim(), cards: [] };
        group.cards.push({
          cardId: card.id,
          nickname: card.nickname,
          network: card.network,
          note: benefit.note,
        });
        groups.set(key, group);
      }
    }
    return [...groups.values()]
      .filter(
        (group) =>
          !term ||
          group.name.toLocaleLowerCase().includes(term) ||
          group.cards.some(
            (card) =>
              card.nickname.toLocaleLowerCase().includes(term) ||
              card.note?.toLocaleLowerCase().includes(term),
          ),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  updateSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }
}
