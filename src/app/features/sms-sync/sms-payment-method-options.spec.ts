import {
  CARD_TAP_METHODS,
  CARD_TRANSACTION_METHODS,
  composeSmsApprovalNotes,
  paymentMethodsFor,
  smsPaymentMethodLine,
  UPI_APPS,
  UPI_GLOBAL_COUNTRIES,
  validateSmsPaymentAnnotation,
} from './sms-payment-method-options';

describe('SMS payment-method configuration and notes', () => {
  it('offers exactly five card methods and eight Bank/UPI methods', () => {
    expect(paymentMethodsFor('CARD').map((item) => item.label)).toEqual([
      'None',
      'UPI',
      'UPI Global',
      'Card',
      'Card tap',
    ]);
    expect(paymentMethodsFor('BANK').map((item) => item.label)).toEqual([
      'None',
      'UPI',
      'UPI Global',
      'Card',
      'Card tap',
      'NEFT',
      'Cheque',
      'SWIFT/ WIRE',
    ]);
    expect(UPI_APPS.map((item) => item.label)).toEqual([
      'BHIM App',
      'GPay',
      'PhonePe',
      'KiWi',
      'Slice',
      'Cred',
      'Amazon',
      'PayTM',
      'PayZapp',
    ]);
    expect(UPI_GLOBAL_COUNTRIES.map((item) => item.label)).toEqual([
      'Bhutan',
      'Cambodia',
      'France',
      'Greece',
      'Maldives',
      'Mauritius',
      'Nepal',
      'Qatar',
      'Singapore',
      'Sri Lanka',
      'UAE',
    ]);
    expect(CARD_TRANSACTION_METHODS.map((item) => item.label)).toEqual([
      'Swipe (Magnetic Stripe)',
      'Insert / Dipping (EMV Chip)',
      'Typed at POS (Keyed-In Transaction)',
      'Online Transaction',
      'ATM withdrawal',
      'International',
      'International ATM',
      'International Online Transaction',
    ]);
    expect(CARD_TAP_METHODS.map((item) => item.label)).toEqual([
      'Tap(NFC) by Card',
      'Tap by watch',
      'Tap (GPay)',
      'Tap (Apple)',
      'Tap (Samsung pay)',
      'Tap (PayTM)',
      'Tap (Cred)',
      'Tap (iMobile)',
      'Tap (PayZapp)',
      'Tap (Ring)',
    ]);
  });

  it('validates subtype requirements and uses custom UPI app instead of a preset', () => {
    expect(() => validateSmsPaymentAnnotation({ paymentMethod: 'UPI' }, 'CARD')).toThrow(
      'Choose a valid upi app',
    );
    expect(
      validateSmsPaymentAnnotation(
        {
          paymentMethod: 'UPI',
          paymentMethodDetail: 'BHIM_APP',
          paymentMethodCustom: '  Custom Wallet  ',
        },
        'CARD',
      ),
    ).toEqual({ paymentMethod: 'UPI', paymentMethodCustom: 'Custom Wallet' });
    expect(
      smsPaymentMethodLine({ paymentMethod: 'UPI', paymentMethodCustom: 'Custom Wallet' }),
    ).toBe('UPI -> Custom Wallet');
    expect(() =>
      validateSmsPaymentAnnotation(
        { paymentMethod: 'CARD', paymentMethodDetail: 'BHIM_APP' },
        'CARD',
      ),
    ).toThrow('card transaction method');
    expect(() => validateSmsPaymentAnnotation({ paymentMethod: 'NEFT' }, 'CARD')).toThrow(
      'valid payment method',
    );
    expect(() =>
      validateSmsPaymentAnnotation({ paymentMethod: 'NEFT', paymentMethodDetail: 'UAE' }, 'BANK'),
    ).toThrow('does not have a secondary choice');
    expect(validateSmsPaymentAnnotation({ paymentMethod: 'SWIFT_WIRE' }, 'BANK')).toEqual({
      paymentMethod: 'SWIFT_WIRE',
      smsAdditionalComment: undefined,
    });
    expect(validateSmsPaymentAnnotation({}, 'CARD')).toEqual({
      paymentMethod: 'NONE',
      smsAdditionalComment: undefined,
    });
  });

  it('formats method, multiline comment, audit notes and one final marker exactly', () => {
    expect(
      composeSmsApprovalNotes({
        annotation: {
          paymentMethod: 'CARD_TAP',
          paymentMethodDetail: 'TAP_GPAY',
          smsAdditionalComment: ' Used at supermarket \nPaid by phone ',
        },
        newlyApprovedSms: true,
      }),
    ).toBe('Card tap -> Tap (GPay)\nUsed at supermarket\nPaid by phone\n(Approved SMS discovery)');
    expect(
      composeSmsApprovalNotes({
        annotation: {
          paymentMethod: 'UPI_GLOBAL',
          paymentMethodDetail: 'SINGAPORE',
          smsAdditionalComment: 'Restaurant payment during travel',
        },
        newlyApprovedSms: true,
        auditInformation: ['SMS event date unavailable; received date used.'],
      }),
    ).toBe(
      'UPI Global -> Singapore\nRestaurant payment during travel\nSMS event date unavailable; received date used.\n(Approved SMS discovery)',
    );
    expect(
      composeSmsApprovalNotes({
        annotation: { paymentMethod: 'NONE', smsAdditionalComment: '  ' },
        newlyApprovedSms: true,
      }),
    ).toBe('(Approved SMS discovery)');
    expect(
      composeSmsApprovalNotes({
        existingNotes: 'Old manual note\n(Approved SMS discovery)\n(Approved SMS discovery)',
        annotation: {
          paymentMethod: 'NEFT',
          smsAdditionalComment: 'Transferred to savings account',
        },
        newlyApprovedSms: false,
        preserveSmsMarker: true,
      }),
    ).toBe('NEFT\nTransferred to savings account\nOld manual note\n(Approved SMS discovery)');
  });

  it('updates existing annotations idempotently without adding provenance to manual notes', () => {
    const oldAnnotation = {
      paymentMethod: 'UPI' as const,
      paymentMethodDetail: 'BHIM_APP' as const,
      smsAdditionalComment: 'First line\nSecond line',
    };
    const oldNotes =
      'UPI -> BHIM App\nFirst line\nSecond line\nManual audit note\n(Approved SMS discovery)';
    const next = {
      paymentMethod: 'UPI' as const,
      paymentMethodDetail: 'GPAY' as const,
      smsAdditionalComment: 'Updated comment',
    };
    const once = composeSmsApprovalNotes({
      existingNotes: oldNotes,
      previousAnnotation: oldAnnotation,
      annotation: next,
      newlyApprovedSms: false,
      preserveSmsMarker: true,
    });
    expect(once).toBe('UPI -> GPay\nUpdated comment\nManual audit note\n(Approved SMS discovery)');
    expect(
      composeSmsApprovalNotes({
        existingNotes: once,
        previousAnnotation: next,
        annotation: next,
        newlyApprovedSms: false,
      }),
    ).toBe(once);
    expect(
      composeSmsApprovalNotes({
        existingNotes: 'Keep this manual note',
        annotation: { paymentMethod: 'NONE', smsAdditionalComment: 'new note' },
        newlyApprovedSms: false,
      }),
    ).toBe('new note\nKeep this manual note');
    expect(
      composeSmsApprovalNotes({ existingNotes: 'Unrelated manual text', newlyApprovedSms: false }),
    ).toBe('Unrelated manual text');
  });
});
