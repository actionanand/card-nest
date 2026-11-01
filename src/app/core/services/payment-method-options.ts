import { SmsPaymentMethod, SmsPaymentMethodDetail } from '../models/domain';

export type SmsPaymentContext = 'CARD' | 'BANK';

export interface PaymentMethodOption {
  readonly value: SmsPaymentMethod;
  readonly label: string;
  readonly contexts: readonly SmsPaymentContext[];
}

export interface PaymentMethodDetailOption {
  readonly value: SmsPaymentMethodDetail;
  readonly label: string;
}

export interface SmsPaymentAnnotation {
  readonly paymentMethod?: SmsPaymentMethod | string;
  readonly paymentMethodDetail?: SmsPaymentMethodDetail | string;
  readonly paymentMethodCustom?: string;
  readonly smsAdditionalComment?: string;
}

export interface ValidatedSmsPaymentAnnotation {
  readonly paymentMethod: SmsPaymentMethod;
  readonly paymentMethodDetail?: SmsPaymentMethodDetail;
  readonly paymentMethodCustom?: string;
  readonly smsAdditionalComment?: string;
}

export const SMS_PAYMENT_METHODS: readonly PaymentMethodOption[] = [
  { value: 'NONE', label: 'None', contexts: ['CARD', 'BANK'] },
  { value: 'UPI', label: 'UPI', contexts: ['CARD', 'BANK'] },
  { value: 'UPI_GLOBAL', label: 'UPI Global', contexts: ['CARD', 'BANK'] },
  { value: 'CARD', label: 'Card', contexts: ['CARD', 'BANK'] },
  { value: 'CARD_TAP', label: 'Card tap', contexts: ['CARD', 'BANK'] },
  { value: 'NEFT', label: 'NEFT', contexts: ['BANK'] },
  { value: 'CHEQUE', label: 'Cheque', contexts: ['BANK'] },
  { value: 'SWIFT_WIRE', label: 'SWIFT/ WIRE', contexts: ['BANK'] },
];

export const UPI_APPS: readonly PaymentMethodDetailOption[] = [
  { value: 'BHIM_APP', label: 'BHIM App' },
  { value: 'GPAY', label: 'GPay' },
  { value: 'PHONEPE', label: 'PhonePe' },
  { value: 'KIWI', label: 'KiWi' },
  { value: 'SLICE', label: 'Slice' },
  { value: 'CRED', label: 'Cred' },
  { value: 'AMAZON', label: 'Amazon' },
  { value: 'PAYTM', label: 'PayTM' },
  { value: 'PAYZAPP', label: 'PayZapp' },
];

export const UPI_GLOBAL_COUNTRIES: readonly PaymentMethodDetailOption[] = [
  { value: 'BHUTAN', label: 'Bhutan' },
  { value: 'CAMBODIA', label: 'Cambodia' },
  { value: 'FRANCE', label: 'France' },
  { value: 'GREECE', label: 'Greece' },
  { value: 'MALDIVES', label: 'Maldives' },
  { value: 'MAURITIUS', label: 'Mauritius' },
  { value: 'NEPAL', label: 'Nepal' },
  { value: 'QATAR', label: 'Qatar' },
  { value: 'SINGAPORE', label: 'Singapore' },
  { value: 'SRI_LANKA', label: 'Sri Lanka' },
  { value: 'UAE', label: 'UAE' },
];

export const CARD_TRANSACTION_METHODS: readonly PaymentMethodDetailOption[] = [
  { value: 'MAGNETIC_STRIPE', label: 'Swipe (Magnetic Stripe)' },
  { value: 'EMV_CHIP', label: 'Insert / Dipping (EMV Chip)' },
  { value: 'KEYED_IN', label: 'Typed at POS (Keyed-In Transaction)' },
  { value: 'ONLINE', label: 'Online Transaction' },
  { value: 'ATM_WITHDRAWAL', label: 'ATM withdrawal' },
  { value: 'INTERNATIONAL', label: 'International' },
  { value: 'INTERNATIONAL_ATM', label: 'International ATM' },
  { value: 'INTERNATIONAL_ONLINE', label: 'International Online Transaction' },
];

export const CARD_TAP_METHODS: readonly PaymentMethodDetailOption[] = [
  { value: 'TAP_CARD', label: 'Tap(NFC) by Card' },
  { value: 'TAP_WATCH', label: 'Tap by watch' },
  { value: 'TAP_GPAY', label: 'Tap (GPay)' },
  { value: 'TAP_APPLE', label: 'Tap (Apple)' },
  { value: 'TAP_SAMSUNG', label: 'Tap (Samsung pay)' },
  { value: 'TAP_PAYTM', label: 'Tap (PayTM)' },
  { value: 'TAP_CRED', label: 'Tap (Cred)' },
  { value: 'TAP_IMOBILE', label: 'Tap (iMobile)' },
  { value: 'TAP_PAYZAPP', label: 'Tap (PayZapp)' },
  { value: 'TAP_RING', label: 'Tap (Ring)' },
];

export const SMS_PAYMENT_METHOD_DETAILS: Partial<
  Record<
    SmsPaymentMethod,
    { readonly label: string; readonly options: readonly PaymentMethodDetailOption[] }
  >
> = {
  UPI: { label: 'UPI App', options: UPI_APPS },
  UPI_GLOBAL: { label: 'Country', options: UPI_GLOBAL_COUNTRIES },
  CARD: { label: 'Card transaction method', options: CARD_TRANSACTION_METHODS },
  CARD_TAP: { label: 'Tap method', options: CARD_TAP_METHODS },
};

const methodByValue = new Map(SMS_PAYMENT_METHODS.map((option) => [option.value, option]));
const detailByMethod = new Map(
  Object.entries(SMS_PAYMENT_METHOD_DETAILS).map(([method, config]) => [
    method as SmsPaymentMethod,
    new Map(config.options.map((option) => [option.value, option])),
  ]),
);

export function paymentMethodsFor(context: SmsPaymentContext): readonly PaymentMethodOption[] {
  return SMS_PAYMENT_METHODS.filter((option) => option.contexts.includes(context));
}

export function paymentMethodDetailConfig(
  method: string,
): { readonly label: string; readonly options: readonly PaymentMethodDetailOption[] } | undefined {
  return SMS_PAYMENT_METHOD_DETAILS[method as SmsPaymentMethod];
}

export function requiresPaymentMethodDetail(method: string): boolean {
  return !!SMS_PAYMENT_METHOD_DETAILS[method as SmsPaymentMethod];
}

export function validateSmsPaymentAnnotation(
  value: SmsPaymentAnnotation,
  context: SmsPaymentContext,
): ValidatedSmsPaymentAnnotation {
  const methodValue = value.paymentMethod ?? 'NONE';
  const method =
    typeof methodValue === 'string'
      ? methodByValue.get(methodValue as SmsPaymentMethod)
      : undefined;
  if (!method || !method.contexts.includes(context))
    throw new Error('Choose a valid payment method for this SMS review.');

  if (value.smsAdditionalComment !== undefined && typeof value.smsAdditionalComment !== 'string')
    throw new Error('Enter a valid additional comment.');
  const comment =
    typeof value.smsAdditionalComment === 'string'
      ? value.smsAdditionalComment.trim() || undefined
      : undefined;
  if (comment && comment.length > 500)
    throw new Error('Additional comments are limited to 500 characters.');

  if (value.paymentMethodCustom !== undefined && typeof value.paymentMethodCustom !== 'string')
    throw new Error('Enter a valid custom UPI app name.');
  const custom =
    typeof value.paymentMethodCustom === 'string'
      ? value.paymentMethodCustom.trim() || undefined
      : undefined;
  if (custom && (custom.length > 80 || /[\r\n\0]/.test(custom)))
    throw new Error('Custom UPI app names must be a single line of at most 80 characters.');
  if (method.value === 'UPI' && custom) {
    if (
      value.paymentMethodDetail &&
      !detailByMethod.get('UPI')?.has(value.paymentMethodDetail as SmsPaymentMethodDetail)
    )
      throw new Error('Choose a valid UPI app or enter a custom app name.');
    return {
      paymentMethod: 'UPI',
      paymentMethodCustom: custom,
      smsAdditionalComment: comment,
    };
  }
  if (custom) throw new Error('A custom app name is only valid for UPI.');

  const detailValue = value.paymentMethodDetail;
  const detailMap = detailByMethod.get(method.value);
  if (!detailMap) {
    if (detailValue !== undefined && detailValue !== '' && detailValue !== null)
      throw new Error('This payment method does not have a secondary choice.');
    return { paymentMethod: method.value, smsAdditionalComment: comment };
  }
  if (typeof detailValue !== 'string' || !detailMap.has(detailValue as SmsPaymentMethodDetail))
    throw new Error(
      `Choose a valid ${SMS_PAYMENT_METHOD_DETAILS[method.value]!.label.toLowerCase()}.`,
    );
  return {
    paymentMethod: method.value,
    paymentMethodDetail: detailValue as SmsPaymentMethodDetail,
    smsAdditionalComment: comment,
  };
}

export function smsPaymentMethodLine(annotation: SmsPaymentAnnotation): string | undefined {
  const method = methodByValue.get((annotation.paymentMethod ?? 'NONE') as SmsPaymentMethod);
  if (!method || method.value === 'NONE') return undefined;
  const custom =
    typeof annotation.paymentMethodCustom === 'string' ? annotation.paymentMethodCustom.trim() : '';
  const detail =
    custom ||
    detailByMethod.get(method.value)?.get(annotation.paymentMethodDetail as SmsPaymentMethodDetail)
      ?.label;
  return detail ? `${method.label} -> ${detail}` : method.label;
}

export interface SmsNotesComposition {
  readonly existingNotes?: string;
  readonly previousAnnotation?: SmsPaymentAnnotation;
  readonly annotation?: SmsPaymentAnnotation;
  readonly newlyApprovedSms: boolean;
  readonly preserveSmsMarker?: boolean;
  readonly auditInformation?: readonly string[];
}

/** Pure, idempotent composer for SMS annotations and provenance notes. */
export function composeSmsApprovalNotes(input: SmsNotesComposition): string | undefined {
  const previousMethod = input.previousAnnotation
    ? smsPaymentMethodLine(input.previousAnnotation)
    : undefined;
  const previousComment =
    typeof input.previousAnnotation?.smsAdditionalComment === 'string'
      ? input.previousAnnotation.smsAdditionalComment.trim()
      : '';
  const preserved = (input.existingNotes ?? '')
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim() &&
        line.trim() !== '(Approved SMS discovery)' &&
        line.trim() !== 'Approved SMS discovery',
    );
  const priorAnnotationLines = [
    ...(previousMethod ? [previousMethod] : []),
    ...(previousComment ? previousComment.split(/\r?\n/).map((line) => line.trim()) : []),
  ];
  if (priorAnnotationLines.length) {
    for (let start = 0; start <= preserved.length - priorAnnotationLines.length; start += 1) {
      if (priorAnnotationLines.every((line, offset) => preserved[start + offset].trim() === line)) {
        preserved.splice(start, priorAnnotationLines.length);
        break;
      }
    }
  }
  const annotation = input.annotation ?? {};
  const methodLine = smsPaymentMethodLine(annotation);
  const comment =
    typeof annotation.smsAdditionalComment === 'string'
      ? annotation.smsAdditionalComment.trim()
      : '';
  const result = [
    ...(methodLine ? [methodLine] : []),
    ...(comment
      ? comment
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : []),
    ...preserved.map((line) => line.trimEnd()),
    ...(input.auditInformation ?? []).flatMap((item) =>
      item
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  const hasMarker =
    input.newlyApprovedSms ||
    input.preserveSmsMarker ||
    (input.existingNotes ?? '')
      .split(/\r?\n/)
      .some((line) => ['(Approved SMS discovery)', 'Approved SMS discovery'].includes(line.trim()));
  if (hasMarker) result.push('(Approved SMS discovery)');
  return result.length ? result.join('\n') : undefined;
}
