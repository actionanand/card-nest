import { Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import {
  LucideArrowDown,
  LucideArrowLeft,
  LucideArrowUp,
  LucideApple,
  LucideBaby,
  LucideBadgeCheck,
  LucideBanknoteArrowDown,
  LucideBanknoteArrowUp,
  LucideBell,
  LucideCalendarClock,
  LucideChartLine,
  LucideCamera,
  LucideChevronDown,
  LucideChevronRight,
  LucideCircleCheck,
  LucideCircleHelp,
  LucideCloudDownload,
  LucideCloudUpload,
  LucideClapperboard,
  LucideBriefcaseBusiness,
  LucideCreditCard,
  LucideCookie,
  LucideCopy,
  LucideDatabaseBackup,
  LucideDownload,
  LucideDynamicIcon,
  LucideEllipsisVertical,
  LucideExternalLink,
  LucideEye,
  LucideEyeOff,
  LucideFileSpreadsheet,
  LucideFileText,
  LucideFish,
  LucideFilm,
  LucideFingerprint,
  LucideFuel,
  LucideGamepad2,
  LucideGlobeCheck,
  LucideGlobeOff,
  LucideGem,
  LucideGraduationCap,
  LucideHandCoins,
  LucideHandHeart,
  LucideImages,
  LucideHouse,
  LucideLandmark,
  LucideLaptop,
  LucideMars,
  LucideMenu,
  LucideMilk,
  LucideMonitor,
  LucideMoon,
  LucidePalette,
  LucidePenLine,
  LucidePlane,
  LucidePopcorn,
  LucidePlugZap,
  LucidePlus,
  LucideReceiptText,
  LucideReceiptIndianRupee,
  LucideRepeat2,
  LucideSettings,
  LucideShirt,
  LucideSmartphone,
  LucideSplit,
  LucideSun,
  LucideSalad,
  LucideSearch,
  LucideShapes,
  LucideShieldCheck,
  LucideShieldPlus,
  LucideShoppingBag,
  LucideShoppingBasket,
  LucideShoppingCart,
  LucideTags,
  LucideTag,
  LucideTrash2,
  LucideTriangleAlert,
  LucideUtensils,
  LucideUsersRound,
  LucideVenus,
  LucideWalletCards,
  LucideX,
  LucideZap,
  type LucideIconInput,
} from '@lucide/angular';
import {
  CREDIT_CARD_EDIT,
  CREDIT_CARD_PLUS,
  FLASH_TRANSACTION,
  SHOPPING_CART_PLUS,
} from '../../imgData/svgIcon';

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
  vegetables_fruits: LucideSalad,
  kids: LucideBaby,
  fashion: LucideShirt,
  groceries: LucideShoppingBasket,
  meat_fish: LucideFish,
  milk: LucideMilk,
  pastry_snacks: LucideCookie,
  utility_bills: LucideReceiptIndianRupee,
  mobile: LucideSmartphone,
  electronics: LucideLaptop,
  electricity: LucidePlugZap,
  jewels: LucideGem,
  religion: LucideHandHeart,
  insurance: LucideShieldCheck,
  education: LucideGraduationCap,
  boy: LucideMars,
  girl: LucideVenus,
  other: LucideShapes,
  family: LucideUsersRound,
  hamburger: LucideMenu,
  apple: LucideApple,
  shopping_cart: LucideShoppingCart,
  tag: LucideTag,
  film: LucideFilm,
  popcorn: LucidePopcorn,
  landmark: LucideLandmark,
  banknote_arrow_up: LucideBanknoteArrowUp,
  banknote_arrow_down: LucideBanknoteArrowDown,
  globe_check: LucideGlobeCheck,
  globe_off: LucideGlobeOff,
  briefcase_business: LucideBriefcaseBusiness,
  gallery: LucideImages,
  camera: LucideCamera,
  overview: LucideHouse,
  cards: LucideCreditCard,
  transactions: LucideReceiptText,
  categories: LucideTags,
  reminders: LucideBell,
  reports: LucideChartLine,
  spending: LucideReceiptIndianRupee,
  benefits: LucideBadgeCheck,
  card_usage: LucideCalendarClock,
  sources: LucideLandmark,
  loans: LucideHandCoins,
  settings: LucideSettings,
  help: LucideCircleHelp,
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
  add_expense: LucideReceiptIndianRupee,
  split: LucideSplit,
  search: LucideSearch,
  backup: LucideDatabaseBackup,
  appearance: LucidePalette,
  system_theme: LucideMonitor,
  light_theme: LucideSun,
  dark_theme: LucideMoon,
  fingerprint: LucideFingerprint,
  cloud_backup: LucideCloudUpload,
  cloud_restore: LucideCloudDownload,
  duplicate: LucideCopy,
  go_to_source: LucideExternalLink,
  hide_credit: LucideEyeOff,
  show_credit: LucideEye,
  download: LucideDownload,
  file_pdf: LucideFileText,
  file_csv: LucideFileSpreadsheet,
};

const CUSTOM_ICONS: Readonly<Record<string, string>> = {
  shopping_cart_plus: SHOPPING_CART_PLUS,
  credit_card_plus: CREDIT_CARD_PLUS,
  credit_card_edit: CREDIT_CARD_EDIT,
  flash_transaction: FLASH_TRANSACTION,
};

@Component({
  selector: 'app-icon',
  imports: [LucideDynamicIcon],
  template: `
    @if (customIcon(); as svg) {
      <span class="custom-svg" [innerHTML]="svg" aria-hidden="true"></span>
    } @else {
      <svg [lucideIcon]="icon()" aria-hidden="true" focusable="false"></svg>
    }
  `,
  styles: `
    :host {
      display: inline-grid;
      width: 1.2rem;
      height: 1.2rem;
      flex: 0 0 auto;
      place-items: center;
      line-height: 0;
    }

    svg,
    .custom-svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    .custom-svg {
      color: inherit;
    }
  `,
})
export class AppIcon {
  private readonly sanitizer = inject(DomSanitizer);
  readonly name = input('category');
  readonly icon = computed(() => ICONS[this.name()] ?? ICONS['category']);
  readonly customIcon = computed(() => {
    const source = CUSTOM_ICONS[this.name()];
    if (!source) return null;
    return this.sanitizer.bypassSecurityTrustHtml(source.trim());
  });
}
