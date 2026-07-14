import { Component, computed, input } from '@angular/core';
import {
  LucideArrowDown,
  LucideArrowLeft,
  LucideArrowUp,
  LucideBadgeCheck,
  LucideBell,
  LucideCalendarClock,
  LucideChartNoAxesColumnIncreasing,
  LucideChevronDown,
  LucideChevronRight,
  LucideCircleCheck,
  LucideClapperboard,
  LucideCreditCard,
  LucideDynamicIcon,
  LucideEllipsisVertical,
  LucideFuel,
  LucideGamepad2,
  LucideHandCoins,
  LucideHouse,
  LucideLandmark,
  LucideMenu,
  LucidePenLine,
  LucidePlane,
  LucidePlus,
  LucideReceiptText,
  LucideRepeat2,
  LucideSettings,
  LucideShapes,
  LucideShieldCheck,
  LucideShieldPlus,
  LucideShoppingBag,
  LucideShoppingBasket,
  LucideTags,
  LucideTrash2,
  LucideTriangleAlert,
  LucideUtensils,
  LucideWalletCards,
  LucideX,
  LucideZap,
  type LucideIconInput,
} from '@lucide/angular';

const ICONS: Readonly<Record<string, LucideIconInput>> = {
  category: LucideShapes,
  shopping_basket: LucideShoppingBasket,
  restaurant: LucideUtensils,
  local_gas_station: LucideFuel,
  shopping_bag: LucideShoppingBag,
  flight: LucidePlane,
  bolt: LucideZap,
  health_and_safety: LucideShieldPlus,
  subscriptions: LucideClapperboard,
  payments: LucideWalletCards,
  home: LucideHouse,
  entertainment: LucideGamepad2,
  overview: LucideHouse,
  cards: LucideCreditCard,
  transactions: LucideReceiptText,
  categories: LucideTags,
  reminders: LucideBell,
  reports: LucideChartNoAxesColumnIncreasing,
  sources: LucideLandmark,
  loans: LucideHandCoins,
  settings: LucideSettings,
  privacy: LucideShieldCheck,
  menu: LucideMenu,
  close: LucideX,
  plus: LucidePlus,
  back: LucideArrowLeft,
  chevron_down: LucideChevronDown,
  chevron_right: LucideChevronRight,
  more: LucideEllipsisVertical,
  edit: LucidePenLine,
  delete: LucideTrash2,
  incoming: LucideArrowDown,
  outgoing: LucideArrowUp,
  repeat: LucideRepeat2,
  success: LucideCircleCheck,
  warning: LucideTriangleAlert,
  schedule: LucideCalendarClock,
  verified: LucideBadgeCheck,
};

@Component({
  selector: 'app-icon',
  imports: [LucideDynamicIcon],
  template: '<svg [lucideIcon]="icon()" aria-hidden="true" focusable="false"></svg>',
  styles: `
    :host {
      display: inline-grid;
      width: 1.2rem;
      height: 1.2rem;
      flex: 0 0 auto;
      place-items: center;
      line-height: 0;
    }

    svg {
      display: block;
      width: 100%;
      height: 100%;
    }
  `,
})
export class AppIcon {
  readonly name = input('category');
  readonly icon = computed(() => ICONS[this.name()] ?? ICONS['category']);
}
