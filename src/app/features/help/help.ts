import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AppIcon } from '../../shared/app-icon';
import { APP_VERSION } from '../../core/app-version';
import { Capacitor } from '@capacitor/core';

interface HelpTopic {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly tips?: readonly string[];
  readonly keywords: readonly string[];
  readonly link?: string;
  readonly linkLabel?: string;
  readonly queryParams?: Readonly<Record<string, string | boolean>>;
}

const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: 'add-transaction',
    group: 'Transactions',
    title: 'How do I record a new transaction?',
    summary:
      'Record purchases, adjustments, payments, refunds, cashback, credits, fees, and interest.',
    steps: [
      'Tap the large + button in the bottom navigation, or open Activity and choose Add transaction.',
      'Choose the transaction type and the payment source. Credit cards and other sources are grouped separately.',
      'Enter the amount, date, category, merchant or title, and any notes.',
      'Optionally add receipt images, tax information, or a monthly repeat rule, then choose Save transaction.',
    ],
    tips: [
      'Adjustment appears beside Purchase for quick access.',
      'Refund, cashback, credit, and card-payment entries are treated as credits when totals are calculated.',
    ],
    keywords: ['new', 'add', 'purchase', 'payment', 'credit', 'cashback', 'fee', 'interest'],
    link: '/transactions',
    linkLabel: 'Record a transaction',
    queryParams: { add: true },
  },
  {
    id: 'receipts-tax-repeat',
    group: 'Transactions',
    title: 'Can I attach receipts, record tax, or repeat an entry?',
    summary:
      'Transaction entry supports gallery images, camera capture, tax breakdowns, and monthly repetition.',
    steps: [
      'Use Gallery to select one or more existing receipt images, or Camera to take a new picture.',
      'Enable Tax included and enter the tax or handling-charge portion of the total. CardNest shows the percentage later.',
      'Use Repeat monthly to choose a fixed number of months or an ongoing monthly rule.',
    ],
    tips: [
      'Receipt images remain private to the device and appear in transaction details and while editing.',
      'Images larger than 1 MB are compressed before they are stored. Use the With image activity filter to find receipt-backed entries.',
    ],
    keywords: ['receipt', 'image', 'gallery', 'camera', 'tax', 'charges', 'monthly', 'recurring'],
    link: '/transactions',
    linkLabel: 'Open Activity',
  },
  {
    id: 'flash-transaction',
    group: 'Transactions',
    title: 'What is a Flash transaction?',
    summary: 'Record a purchase from any mobile page with only an amount and payment source.',
    steps: [
      'In the mobile app, tap the floating lightning transaction button above the bottom navigation.',
      'Confirm the preferred payment source, enter the amount, and optionally enter a merchant.',
      'Choose Save purchase. Today, Purchase, and the Other category are filled automatically.',
      'Set the preferred Flash payment source under Settings > General preferences.',
    ],
    keywords: ['flash', 'quick', 'fast', 'amount', 'preferred source'],
    link: '/settings',
    linkLabel: 'Choose preferred source',
  },
  {
    id: 'refund-adjustment',
    group: 'Transactions',
    title: 'How do linked refunds and adjustments work?',
    summary:
      'Link credits or corrections to the transaction that caused them so the history remains understandable.',
    steps: [
      'For a refund, the optional linked-transaction list contains purchases from the selected card during the previous three months.',
      'For an adjustment, the list contains transactions from the selected date and the previous day across all payment sources.',
      'Choose the related entry before saving. Both transactions display the relationship in their detail view.',
    ],
    keywords: ['refund', 'partial refund', 'adjustment', 'linked', 'related', 'correction'],
    link: '/transactions',
    linkLabel: 'View transactions',
  },
  {
    id: 'transaction-details',
    group: 'Transactions',
    title: 'What can I do from transaction details?',
    summary: 'Tap any transaction to see its complete information and available actions.',
    steps: [
      'Tap a transaction row to view its amount, date, type, category, source, notes, receipts, tax, links, and EMI information.',
      'Use Edit, Duplicate, Delete, or Go to payment source as needed.',
      'Eligible purchases also show Convert to EMI and Split transaction actions.',
    ],
    keywords: ['details', 'edit', 'duplicate', 'delete', 'source', 'notes', 'open'],
    link: '/transactions',
    linkLabel: 'Open Activity',
  },
  {
    id: 'split-transaction',
    group: 'Transactions',
    title: 'How do I split a transaction between payment sources?',
    summary: 'Divide one purchase into two to four records while preserving the original total.',
    steps: [
      'Open the transaction and choose Split transaction.',
      'Choose between two and four parts, select a payment source for each part, and enter each amount.',
      'The parts must add up exactly to the original transaction amount before they can be saved.',
    ],
    tips: [
      'You may use the same payment source more than once or combine cards, cash, bank/UPI, and meal cards.',
    ],
    keywords: ['split', 'multiple cards', 'pluxee', 'cash', 'upi', 'two payments'],
    link: '/transactions',
    linkLabel: 'View transactions',
  },
  {
    id: 'convert-emi',
    group: 'Transactions',
    title: 'How do I convert a purchase to EMI?',
    summary:
      'Create a traceable no-cost or standard-interest installment plan from an eligible purchase.',
    steps: [
      'Open an eligible purchase and choose Convert to EMI. The default minimum is ₹2,500 and can be changed in Settings.',
      'Choose no-cost EMI or standard EMI, the number of months, and an interest rate when required.',
      'Choose whether installments start in this statement month, next month, or a custom month.',
      'CardNest replaces the purchase in activity calculations with the applicable installments and creates a plan under Loans & EMIs.',
    ],
    tips: ['Closing an EMI plan stops all upcoming installments while retaining its history.'],
    keywords: ['emi', 'installment', 'interest', 'no cost', 'loan', 'minimum'],
    link: '/loans',
    linkLabel: 'Open Loans & EMIs',
  },
  {
    id: 'add-card',
    group: 'Cards & sources',
    title: 'How do I add and manage a credit card?',
    summary:
      'Store card identity, billing dates, limits, fees, benefits, links, and protected card details.',
    steps: [
      'Open Cards and choose Add card.',
      'Enter a nickname, issuer, card network, final digits, statement day, the bank’s allowed payment days after statement generation, and any credit limit.',
      'If the card carries a different international network, choose it under Global network. For example, some RuPay cards use JCB internationally. Leave Same as card network selected when no second logo is printed.',
      'Enable E-credit card when the issuer provides a virtual or non-physical card rather than a plastic card.',
      'Optional sections cover annual fees, waiver targets, benefits, important links, and protected full-number/CVV storage.',
      'Open a saved card to record a payment, pay due or outstanding amounts, edit it, archive it, or restore it.',
    ],
    tips: [
      'Archiving hides a card from normal choices but keeps its transactions. Deleting marks the source as deleted while historical transactions remain readable.',
      'A global network is usually printed on the back of the card. Most cards use only their primary network, so the default Same option is correct.',
      'Changing the primary card network clears the final-digit field. Enter the digits again because American Express uses the final five digits while other supported networks use the final four.',
    ],
    keywords: [
      'card',
      'add card',
      'statement',
      'due date',
      'limit',
      'fee',
      'archive',
      'delete',
      'global network',
      'jcb',
      'rupay',
      'virtual',
      'e-credit',
    ],
    link: '/cards',
    linkLabel: 'Manage cards',
  },
  {
    id: 'protected-card-validation',
    group: 'Cards & sources',
    title: 'How are full card numbers and CVVs checked and protected?',
    summary:
      'CardNest validates the optional protected fields locally before encrypting them on this device.',
    steps: [
      'A full card number is optional. American Express requires 15 digits and displays them in a 4–6–5 format; other supported networks require 16 digits and display them in a 4–4–4–4 format.',
      'CardNest removes visual separators and performs a Luhn checksum. This detects many typing mistakes, but it does not contact the issuer or prove that a card is active or belongs to the user.',
      'When the full number passes validation, CardNest automatically fills the final five digits for American Express or the final four digits for other networks.',
      'An optional CVV must contain four digits for American Express and three digits for other networks.',
      'The expiry month and year must form a valid date that has not already expired.',
      'Full numbers and CVVs are encrypted locally and hidden by default. They are never included in notifications or masked CSV/PDF exports.',
    ],
    tips: [
      'When editing, a Saved securely badge means a protected value already exists. Leave the field blank to keep it, or enter a replacement value.',
      'Changing the primary network intentionally clears the final digits so the correct four- or five-digit rule can be applied again.',
    ],
    keywords: [
      'full card number',
      'cvv',
      'luhn',
      'checksum',
      'amex',
      '15 digits',
      '16 digits',
      'last four',
      'last five',
      'expiry',
      'encrypted',
    ],
    link: '/cards',
    linkLabel: 'Manage protected card details',
  },
  {
    id: 'linked-cards',
    group: 'Cards & sources',
    title: 'What are linked cards?',
    summary:
      'Group cards that share one credit account or limit without losing their individual identities.',
    steps: [
      'Edit a card and place related cards into the same linked-card group.',
      'Cards continue to show their own nicknames and final digits.',
      'Usage and credit summaries can identify the shared account while displaying all member cards as badges.',
      'In Reminders, Linked balance shows the combined due and outstanding amounts with a per-card breakdown. A confirmed linked payment is divided across the member cards according to each card’s own balance.',
    ],
    keywords: ['linked', 'supplementary', 'add-on', 'shared limit', 'relationship', 'group'],
    link: '/cards',
    linkLabel: 'View cards',
  },
  {
    id: 'other-sources',
    group: 'Cards & sources',
    title: 'Where do I manage cash, bank/UPI, and meal cards?',
    summary: 'Non-credit-card payment sources have their own balances and usage view.',
    steps: [
      'Open Cash, Banks & Pluxee from the navigation drawer or sidebar.',
      'Choose a source to update its name, institution, balance behavior, or meal-card auto-load settings.',
      'These sources appear beside credit cards in transaction entry and activity filters.',
    ],
    keywords: ['cash', 'bank', 'upi', 'pluxee', 'meal card', 'source', 'balance'],
    link: '/sources',
    linkLabel: 'Manage payment sources',
  },
  {
    id: 'categories-budgets',
    group: 'Planning & insights',
    title: 'How do categories and spending limits work?',
    summary: 'Organize transactions and compare category spending with optional monthly limits.',
    steps: [
      'Open Categories to add, edit, archive, or choose icons and colors for categories.',
      'Set a category limit when you want progress tracking.',
      'Open Category spending to expand a category, inspect transactions, and compare usage against its limit.',
    ],
    tips: [
      'Progress colors change as spending moves through the lower, middle, warning, and over-limit ranges.',
    ],
    keywords: ['category', 'budget', 'limit', 'progress', 'spending', 'color'],
    link: '/category-spending',
    linkLabel: 'View category spending',
  },
  {
    id: 'reports-export',
    group: 'Planning & insights',
    title: 'How do I filter, review, or export activity?',
    summary: 'Search and group transactions, review charts, and create masked PDF or CSV reports.',
    steps: [
      'In Activity, expand Filters on mobile to search or narrow by transaction type, source, category, and grouping cycle.',
      'Use PDF or CSV beside the activity summary to export the currently selected report scope.',
      'Open Reports, Card usage, and Category spending for visual summaries and planning views.',
    ],
    tips: ['Exports are masked and must never contain full card numbers or CVVs.'],
    keywords: ['filter', 'search', 'pdf', 'csv', 'export', 'report', 'chart', 'activity'],
    link: '/reports',
    linkLabel: 'Open reports',
  },
  {
    id: 'reminders',
    group: 'Planning & insights',
    title: 'How do reminders and notifications work?',
    summary: 'Receive local notifications for statement payments, annual fees, and card expiry.',
    steps: [
      'Open Reminders and enable Notifications, then grant Android notification permission when prompted.',
      'Filter the reminder list by payments, grace period, annual fee, expiry, or all cards.',
      'Longest grace period ranks cards by the exact final payment date for a purchase made today. For example, 17 days (2 + 15) means the statement generates in two days and the bank then allows fifteen days to pay.',
      'Record a payment or snooze a reminder; the list updates immediately.',
      'A payment records only the latest statement amount due. CardNest asks for confirmation first.',
      'Snooze becomes available five days before the due date. Snoozed items remain in history and can be restored; the snackbar also offers Undo for ten seconds.',
    ],
    tips: [
      'Notifications contain only a nickname and masked digits. They never reveal a full card number.',
      'Grace-period comparisons appear in the Reminders page for planning; notifications are limited to statement amount due, annual fee due, and card expiry.',
    ],
    keywords: ['notification', 'reminder', 'snooze', 'payment due', 'fee', 'expiry'],
    link: '/reminders',
    linkLabel: 'Open reminders',
  },
  {
    id: 'dates-display',
    group: 'Security & data',
    title: 'How do I change the date display format?',
    summary: 'Choose one display format for transactions, statements, reminders, and other dates.',
    steps: [
      'Open Settings and find Date format under General preferences.',
      'Choose DD-MM-YYYY, DD/MM/YYYY, MM/DD/YYYY, ISO, or one of the month-name formats.',
      'The change applies to displayed dates; SQLite continues storing sortable ISO dates internally.',
    ],
    keywords: ['date', 'format', 'dd-mm', 'iso', 'display'],
    link: '/settings',
    linkLabel: 'Change date format',
  },
  {
    id: 'security',
    group: 'Security & data',
    title: 'How do PIN and biometric unlock work?',
    summary:
      'Use an application PIN as the recovery credential and Android biometrics for convenient unlocking.',
    steps: [
      'Open Settings and set a four-to-eight-digit application PIN.',
      'An application PIN is required before biometric unlock can work. It remains the fallback credential.',
      'On an Android device with an enrolled fingerprint or biometric, enable Biometric unlock.',
      'Choose whether CardNest locks whenever it enters the background.',
      'To disable or change the PIN, confirm the existing PIN first.',
    ],
    tips: [
      'Biometrics cannot be enabled until both an application PIN and an Android biometric are available.',
    ],
    keywords: ['pin', 'fingerprint', 'biometric', 'lock', 'security', 'disable pin'],
    link: '/settings',
    linkLabel: 'Open security settings',
  },
  {
    id: 'backup-restore',
    group: 'Security & data',
    title: 'How do encrypted backup and restore work?',
    summary:
      'Create a passphrase-protected .cnbak file or restore one through the system file picker.',
    steps: [
      'Open Settings, then Backup & data, and choose Create encrypted backup.',
      'Enter and confirm a passphrase of at least eight characters. If an application PIN exists, confirm it too.',
      'Choose a save location for the .cnbak file and keep the passphrase somewhere safe.',
      'To restore, choose Restore backup, select the file, enter its passphrase, and confirm replacing current CardNest data.',
    ],
    tips: [
      'The backup passphrase cannot be recovered.',
      'A .cnbak file is encrypted CardNest data, not a SQLite file that can be opened directly in a database viewer.',
      'Without the correct passphrase, the backup contents—including stored full card numbers and CVVs—cannot practically be read. CardNest derives a 256-bit AES-GCM key using PBKDF2-SHA256 with a unique salt and 310,000 iterations. Use a long, unique passphrase because weak passphrases can still be guessed offline.',
      'On Android, the system document picker can save to installed providers such as Google Drive, Dropbox, OneDrive, or ownCloud. CardNest does not receive or retain a provider password.',
    ],
    keywords: ['backup', 'restore', 'cnbak', 'passphrase', 'file', 'encrypted', 'data'],
    link: '/settings',
    linkLabel: 'Open Backup & data',
    queryParams: {},
  },
  {
    id: 'privacy-delete',
    group: 'Security & data',
    title: 'Where is my data stored, and how do I delete it?',
    summary:
      'CardNest is local-first: records stay in SQLite on this device unless you explicitly export a file.',
    steps: [
      'Android stores the database inside CardNest private application storage; web stores SQLite bytes inside browser IndexedDB.',
      'Use Keep recent history only to retain 3, 5, 7, or 10 years. CardNest carries the removed history into each card opening balance so current totals remain continuous.',
      'Use Delete all data under Settings > Backup & data to remove CardNest records after confirmation.',
      'If an application PIN exists, retention cleanup and Delete all data require that PIN or the enabled Android biometric.',
      'Create an encrypted backup first if you may need the data later.',
    ],
    keywords: ['privacy', 'sqlite', 'local', 'delete all', 'storage', 'indexeddb'],
    link: '/settings',
    linkLabel: 'Open data settings',
  },
];

@Component({
  selector: 'app-help-page',
  imports: [RouterLink, AppIcon],
  templateUrl: './help.html',
  styleUrl: './help.scss',
})
export class HelpPage {
  readonly appVersion = APP_VERSION;
  readonly showAppVersion = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  readonly copyright =
    new Date().getFullYear() > 2026 ? `2026 – ${new Date().getFullYear()}` : '2026';
  readonly search = signal('');
  readonly groups = [...new Set(HELP_TOPICS.map((topic) => topic.group))];
  readonly filteredTopics = computed(() => {
    const term = this.search().trim().toLocaleLowerCase();
    if (!term) return HELP_TOPICS;
    return HELP_TOPICS.filter((topic) =>
      [topic.title, topic.summary, ...topic.steps, ...(topic.tips ?? []), ...topic.keywords]
        .join(' ')
        .toLocaleLowerCase()
        .includes(term),
    );
  });

  updateSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  topicsFor(group: string): readonly HelpTopic[] {
    return this.filteredTopics().filter((topic) => topic.group === group);
  }
}
