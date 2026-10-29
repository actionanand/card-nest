package com.actionanand.cardnest.app.sms

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** Entirely fictional bank/UPI alerts: names, suffixes, references and balances are synthetic. */
class SmsBankParserTest {
  private val receipt = Instant.parse("2026-10-24T12:00:00Z").toEpochMilli()
  private fun parse(text: String) = requireNotNull(SmsTransactionParser.parse(text, receipt)) { text }

  @Test fun a1UpiCreditKeepsBalanceSeparateFromAmount() {
    val r = parse("Rs. 8,100 received in slice A/c xx7316 on 22-Oct-26 from ALEX MORGAN via UPI (Ref ID: 735182094615). Avl. Bal. Rs. 74,320.50 - slice")
    assertEquals(SmsTransactionParser.Kind.BANK_CREDIT, r.kind)
    assertEquals("CREDIT", r.direction)
    assertEquals(810000L, r.amountMinor)
    assertEquals(7432050L, r.reportedBalanceMinor)
    assertEquals("Slice", r.issuer)
    assertEquals("7316", r.accountDigits)
    assertEquals("ALEX MORGAN", r.merchant)
    assertEquals("735182094615", r.reference)
    assertEquals("2026-10-22", r.eventDate)
    assertEquals("INCOMING", r.purposeHint)
  }

  @Test fun a2AndA6NeftCreditsKeepEventDateAndAvailableBalanceDistinct() {
    val a2 = parse("Dear Customer, there is an NEFT credit of INR 96,271.00 in your account 456xxxx6042 on 22/10/2026.Available Balance:INR 96,285.18 -StanChart")
    assertEquals(SmsTransactionParser.Kind.BANK_CREDIT, a2.kind)
    assertEquals("CREDIT", a2.direction)
    assertEquals(9627100L, a2.amountMinor)
    assertEquals(9628518L, a2.reportedBalanceMinor)
    assertEquals("Standard Chartered", a2.issuer)
    assertEquals("6042", a2.accountDigits)
    assertEquals("2026-10-22", a2.eventDate)
    assertNull(a2.merchant)
    val a6 = parse("Dear Customer, there is an NEFT credit of INR 98,270.00 in your account 456xxxx6042 on 24/07/2026.Available Balance:INR 98,274.00 -StanChart")
    assertEquals(9827000L, a6.amountMinor)
    assertEquals(9827400L, a6.reportedBalanceMinor)
    assertEquals("2026-07-24", a6.eventDate)
    assertFalse(a6.dateFallback)
  }

  @Test fun a3AccountDebitToAnotherAccountIsTransferEvidenceWithoutOwnershipClaim() {
    val r = parse("Your a/c XX6042 is debited for Rs. 96280.00 on 22-10-2026 10:47 and credited to a/c XX7316 (UPI Ref no 735182094616).")
    assertEquals(SmsTransactionParser.Kind.BANK_TRANSFER, r.kind)
    assertEquals("DEBIT", r.direction)
    assertEquals(9628000L, r.amountMinor)
    assertEquals("6042", r.accountDigits)
    assertEquals("7316", r.counterpartyAccountDigits)
    assertEquals("735182094616", r.reference)
    assertEquals("ACCOUNT_TRANSFER", r.purposeHint)
    assertTrue(r.eventTimeExplicit)
    assertNull(r.issuer)
  }

  @Test fun maskedPrimaryAndCounterpartyIdentifiersRemainDistinctOnTransfers() {
    val r = parse("Your a/c 432xxxxx765 is debited for Rs. 96280.00 on 22-10-2026 10:47 and credited to a/c 765xxxx007 (UPI Ref no 735182094616).")
    assertEquals(SmsTransactionParser.Kind.BANK_TRANSFER, r.kind)
    assertEquals("DEBIT", r.direction)
    assertEquals("765", r.accountDigits)
    assertEquals("432•••••765", r.accountMask)
    assertEquals("007", r.counterpartyAccountDigits)
    assertEquals("765••••007", r.counterpartyAccountMask)
    assertEquals("ACCOUNT_TRANSFER", r.purposeHint)
  }

  @Test fun a4DebitToPersonIsCustomerDebitNotInternalTransfer() {
    val r = parse("ICICI Bank Acct XX417 debited for Rs 8100.00 on 22-Oct-26; ALEX MORGAN credited. UPI:735182094615.")
    assertEquals(SmsTransactionParser.Kind.BANK_DEBIT, r.kind)
    assertEquals("DEBIT", r.direction)
    assertEquals(810000L, r.amountMinor)
    assertEquals("ICICI", r.issuer)
    assertEquals("417", r.accountDigits)
    assertEquals("ALEX MORGAN", r.merchant)
    assertEquals("735182094615", r.reference)
    assertEquals("PURCHASE", r.purposeHint)
  }

  @Test fun a5IncomingUpiCredit() {
    val r = parse("Dear Customer, Acct XX417 is credited with Rs 7700.00 on 12-Oct-26 from JAMIE RIVERS. UPI:735182094617-ICICI Bank")
    assertEquals(SmsTransactionParser.Kind.BANK_CREDIT, r.kind)
    assertEquals("CREDIT", r.direction)
    assertEquals(770000L, r.amountMinor)
    assertEquals("ICICI", r.issuer)
    assertEquals("JAMIE RIVERS", r.merchant)
    assertEquals("735182094617", r.reference)
  }

  @Test fun a7PrimaryCreditIsNotTheSendersDebit() {
    val r = parse("Your a/c no. XXXXXXX6042 is credited for Rs. 3000.00 on 31-08-2026 06:46 and debited from a/c no. XXXXXXXXXXXXX9081 (UPI Ref no 735182094618)")
    assertEquals("CREDIT", r.direction)
    assertEquals("6042", r.accountDigits)
    assertEquals("9081", r.counterpartyAccountDigits)
    assertEquals(300000L, r.amountMinor)
    assertEquals("2026-08-31", r.eventDate)
    assertNull(r.merchant)
    assertNotEquals("PURCHASE", r.purposeHint)
  }

  @Test fun b1ToB7RecipientCreditedDoesNotBecomeIncome() {
    val cases = listOf(
      Triple("21-Oct-26", "450.00", "HILL FARM MEATS") to Pair(45000L, "735182094619"),
      Triple("18-Oct-26", "217.00", "FRESH MART MARKET") to Pair(21700L, "735182094620"),
      Triple("07-Oct-26", "1290.00", "HOME RENT PORTAL") to Pair(129000L, "735182094621"),
      Triple("04-Oct-26", "150.00", "LOCAL SHOPKEEPER") to Pair(15000L, "735182094622"),
      Triple("04-Oct-26", "60.00", "COFFEE STALL") to Pair(6000L, "735182094623"),
      Triple("30-Sep-26", "503.00", "ONLINE WALLET SERVICES") to Pair(50300L, "735182094624"),
      Triple("27-Sep-26", "285.00", "MERCHANT ALIAS") to Pair(28500L, "735182094625"),
    )
    val dates = listOf("2026-10-21", "2026-10-18", "2026-10-07", "2026-10-04", "2026-10-04", "2026-09-30", "2026-09-27")
    cases.forEachIndexed { index, (input, expected) ->
      val (date, amount, merchant) = input
      val r = parse("ICICI Bank Acct XX417 debited for Rs $amount on $date; $merchant credited. UPI:${expected.second}.")
      assertEquals(SmsTransactionParser.Kind.BANK_DEBIT, r.kind)
      assertEquals("DEBIT", r.direction)
      assertEquals(expected.first, r.amountMinor)
      assertEquals(dates[index], r.eventDate)
      assertEquals(merchant, r.merchant)
      assertEquals(expected.second, r.reference)
      assertEquals("ICICI", r.issuer)
      assertEquals("417", r.accountDigits)
      assertEquals("PURCHASE", r.purposeHint)
      assertFalse(r.eventTimeExplicit)
      assertTrue(r.requiresReview)
    }
  }

  @Test fun caseSpacingGroupingAndMaskVariants() {
    val lower = parse("icici bank acct xx417 debited for rs 1,00,290.00 on 07-oct-26;   home rent portal credited. upi:735182094621.")
    assertEquals(SmsTransactionParser.Kind.BANK_DEBIT, lower.kind)
    assertEquals(10029000L, lower.amountMinor)
    assertEquals("home rent portal", lower.merchant)
    assertEquals("2026-10-07", lower.eventDate)
    for ((mask, suffix) in listOf("XX417" to "417", "XX6042" to "6042", "**12345" to "12345", "123xxxx6042" to "6042")) {
      val r = parse("Bank Acct $mask debited for INR 60.00 on 04/10/2026; COFFEE STA credited.")
      assertEquals(suffix, r.accountDigits)
      assertEquals("COFFEE STA", r.merchant)
    }
  }

  @Test fun repaymentsFailedAndAmbiguousEventsStayProtected() {
    val card = parse("Bank account XX4321 debited INR 300 towards credit card payment on 18/10/26")
    assertEquals(SmsTransactionParser.Kind.BANK_DEBIT, card.kind)
    assertEquals("CARD_REPAYMENT", card.purposeHint)
    val loan = parse("ICICI Bank Acc XX444 debited Rs. 17,277.00 on 10-Oct-26 towards Auto Loan.Avl Bal Rs. 14,852.37.")
    assertEquals(SmsTransactionParser.Kind.LOAN_DEBIT, loan.kind)
    assertEquals("LOAN_REPAYMENT", loan.purposeHint)
    assertNull(SmsTransactionParser.parse("ICICI Bank Acct XX417 debit of Rs 450.00 on 21-Oct-26 to HILL FARM MEATS failed. UPI:735182094619.", receipt))
    val unknown = parse("Acct XX999 debited for Rs 99.00 on 21-Oct-26; FICTIONAL PAYEE credited.")
    assertNull(unknown.issuer)
    assertEquals("SOURCE_SELECTION_REQUIRED", unknown.confidence)
    val atm = parse("Rs 2000.00 withdrawn from A/c XX417 at ATM on 21-Oct-26")
    assertEquals("DEBIT", atm.direction)
    assertEquals("CASH_WITHDRAWAL", atm.purposeHint)
  }

  @Test fun hsbcPaymentToCredIsRepaymentIntentEvidenceNotASale() {
    val r = parse("INR 6520.66 is paid from HSBC account XXXXXX2006 to CRED Club on 26-Oct-26 with ref 735182094701. If this is not done by you, call 18005550123 to report.")
    assertEquals(SmsTransactionParser.Kind.PAYMENT_INITIATED, r.kind)
    assertEquals("HSBC", r.issuer)
    assertEquals("2006", r.accountDigits)
    assertEquals(652066L, r.amountMinor)
    assertEquals("DEBIT", r.direction)
    assertEquals("CRED Club", r.merchant)
    assertEquals("735182094701", r.reference)
    assertEquals("2026-10-26", r.eventDate)
    assertEquals("CARD_REPAYMENT", r.purposeHint)
    assertFalse(r.dateFallback)
    assertFalse(r.eventTimeExplicit)
    val queued = SmsQueue.json(r, "synthetic-provider")
    assertEquals("PAYMENT_INITIATED", queued.getString("kind"))
    assertEquals("HSBC", queued.getString("issuer"))
    assertEquals("2006", queued.getString("accountDigits"))
    assertEquals("CRED Club", queued.getString("merchant"))
    assertEquals(652066L, queued.getLong("amountMinor"))
  }

  @Test fun hsbcCardUseExtractsPrimaryPurchaseAndKeepsLimitAndDueInformational() {
    val r = parse("HSBC Credit Card xx0379 used at FLIPKART for INR 1018.00 on 26/10/26. Avl limit INR 63.34; due INR 10486.66. Call +910000000000 to report fraud.")
    assertEquals(SmsTransactionParser.Kind.PURCHASE, r.kind)
    assertEquals("HSBC", r.issuer)
    assertEquals("0379", r.cardDigits)
    assertEquals("FLIPKART", r.merchant)
    assertEquals(101800L, r.amountMinor)
    assertEquals(6334L, r.availableLimitMinor)
    assertEquals(1048666L, r.amountDueMinor)
    assertEquals("2026-10-26", r.eventDate)
    assertFalse(r.dateFallback)
    assertFalse(r.eventTimeExplicit)
    val queued = SmsQueue.json(r, "synthetic-provider")
    assertEquals("PURCHASE", queued.getString("kind"))
    assertEquals("0379", queued.getString("cardDigits"))
    assertEquals(101800L, queued.getLong("amountMinor"))
    assertEquals(6334L, queued.getLong("availableLimitMinor"))
    assertEquals(1048666L, queued.getLong("amountDueMinor"))

    val equivalent = parse("Your HSBC credit card xx0379 has been used at AMAZON for Rs 999.00 on 26/10/26.")
    assertEquals(SmsTransactionParser.Kind.PURCHASE, equivalent.kind)
    assertEquals("HSBC", equivalent.issuer)
    assertEquals("0379", equivalent.cardDigits)
    assertEquals("AMAZON", equivalent.merchant)
    assertEquals(99900L, equivalent.amountMinor)
  }

  @Test fun hsbcStatementIssuedAndAvailableRemainRecognized() {
    val issued = parse("Your HSBC credit card statement was issued on 26-Oct-26. Statement total INR 10,486.66; minimum due INR 1,000.00.")
    assertEquals(SmsTransactionParser.Kind.STATEMENT, issued.kind)
    assertEquals(1048666L, issued.amountMinor)
    assertEquals(100000L, issued.minimumDueMinor)
    assertEquals("2026-10-26", issued.eventDate)
    assertEquals("2026-10-26", issued.statementDate)
    assertFalse(issued.dateFallback)
    assertNull(issued.dueDate)

    val available = parse("Your HSBC Credit Card statement is available on 26-Oct-26. Total amount due INR 10,486.66; minimum amount due INR 1,000.00.")
    assertEquals(SmsTransactionParser.Kind.STATEMENT, available.kind)
    assertEquals(1048666L, available.amountMinor)
    assertEquals(100000L, available.minimumDueMinor)
    assertEquals("2026-10-26", available.eventDate)
    assertEquals("2026-10-26", available.statementDate)
    assertFalse(available.dateFallback)
    assertNull(available.dueDate)
  }

  @Test fun statementDatesStaySeparateFromPaymentDeadlines() {
    for (wording in listOf("was issued on", "is available on", "dated", "date:")) {
      for (deadlineFirst in listOf(false, true)) {
        val statement = "Your HSBC credit card statement $wording 26-Oct-26. Statement total INR 10,486.66."
        val deadline = "Payment due by 10-Nov-26."
        val r = parse(if (deadlineFirst) "$deadline $statement" else "$statement $deadline")
        assertEquals(SmsTransactionParser.Kind.STATEMENT, r.kind)
        assertEquals("2026-10-26", r.eventDate)
        assertEquals("2026-10-26", r.statementDate)
        assertEquals("2026-11-10", r.dueDate)
        assertFalse(r.dateFallback)
      }
    }
    val dated = parse("Your HSBC credit card statement was issued on 26-Oct-26. Statement dated 20-Oct-26. Statement total INR 10,486.66; due by 10-Nov-26.")
    assertEquals("2026-10-20", dated.eventDate)
    assertEquals("2026-10-20", dated.statementDate)
    assertEquals("2026-11-10", dated.dueDate)
    val ordinal = parse("Your HSBC credit card statement dated 26th October 2026 is available. Statement total INR 10,486.66.")
    assertEquals("2026-10-26", ordinal.eventDate)
    assertEquals("2026-10-26", ordinal.statementDate)
  }

  @Test fun undatedStatementsNeverBorrowLaterDatesAndInvalidDatesAreRejected() {
    for (wording in listOf("was issued", "is available", "was issued on request", "is available on request", "dated", "date:")) {
      val r = parse("Your HSBC credit card statement $wording. Statement total INR 10,486.66; due by 10-Nov-26.")
      assertEquals(SmsTransactionParser.Kind.STATEMENT, r.kind)
      assertEquals("2026-10-24", r.eventDate)
      assertNull(r.statementDate)
      assertEquals("2026-11-10", r.dueDate)
      assertTrue(r.dateFallback)
    }
    for (wording in listOf("was issued on", "is available on", "dated", "date:")) {
      assertNull(SmsTransactionParser.parse("Your HSBC credit card statement $wording 31-Feb-26. Statement total INR 10,486.66; due by 10-Nov-26.", receipt))
    }
  }

  @Test fun strictPrimaryAndOptionalMoneyParsingAcceptsValidGroupingsButRejectsMalformedTokens() {
    val grouped = parse("HSBC Credit Card xx0379 used at FLIPKART for INR 1,23,456.78 on 26/10/26. Avl limit INR 63.34; due INR 10,486.66.")
    assertEquals(12345678L, grouped.amountMinor)
    assertEquals(6334L, grouped.availableLimitMinor)
    assertEquals(1048666L, grouped.amountDueMinor)

    val validPrimaryWithMalformedOptional = parse("HSBC Credit Card xx0379 used at FLIPKART for INR 1018.00 on 26/10/26. Avl limit INR 3,0.88; due INR 3,38.")
    assertEquals(101800L, validPrimaryWithMalformedOptional.amountMinor)
    assertNull(validPrimaryWithMalformedOptional.availableLimitMinor)
    assertNull(validPrimaryWithMalformedOptional.amountDueMinor)

    assertNull(SmsTransactionParser.parse("HSBC Credit Card xx0379 used at FLIPKART for INR 3,38 on 26/10/26.", receipt))
    assertNull(SmsTransactionParser.parse("HSBC Credit Card xx0379 used at FLIPKART for INR 3,0.88 on 26/10/26.", receipt))
    assertNull(SmsTransactionParser.parse("HSBC Credit Card xx0379 statement balance is INR 10,486.66; available limit INR 63.34.", receipt))
  }

  @Test fun counterpartyAccountMentionedBeforeCustomerAccount() {
    val r = parse("Rs 500.00 debited from a/c XX9081 has been credited to your a/c XX6042 on 12-10-2026. UPI Ref 735182094630")
    assertEquals("CREDIT", r.direction)
    assertEquals("6042", r.accountDigits)
    assertEquals("9081", r.counterpartyAccountDigits)
    assertEquals(50000L, r.amountMinor)
    assertNotEquals("PURCHASE", r.purposeHint)
    assertTrue(r.requiresReview)
  }

  @Test fun receivingAccountCreditedWhileSenderDebited() {
    val r = parse("Dear Customer, a/c XX9081 debited and your a/c XX6042 credited for INR 1,200.00 on 03-10-2026. IMPS Ref 735182094631")
    assertEquals(SmsTransactionParser.Kind.BANK_CREDIT, r.kind)
    assertEquals("CREDIT", r.direction)
    assertEquals("6042", r.accountDigits)
    assertEquals("9081", r.counterpartyAccountDigits)
    assertEquals(120000L, r.amountMinor)
    assertEquals("ACCOUNT_TRANSFER", r.purposeHint)
  }

  @Test fun merchantCreditedWhileCustomerDebited() {
    val r = parse("FRESH MART MARKET credited with Rs 217.00 on 18-Oct-26; your A/c XX417 debited. UPI:735182094632")
    assertEquals(SmsTransactionParser.Kind.BANK_DEBIT, r.kind)
    assertEquals("DEBIT", r.direction)
    assertEquals("417", r.accountDigits)
    assertEquals(21700L, r.amountMinor)
    assertEquals("PURCHASE", r.purposeHint)
  }

  @Test fun reversedCreditedDebitedOrderFollowsCustomerAccount() {
    val debit = parse("Payee a/c XX9081 credited with Rs 650.00 on 05-10-2026; your a/c XX6042 debited. UPI Ref 735182094633")
    assertEquals("DEBIT", debit.direction)
    assertEquals("6042", debit.accountDigits)
    assertEquals("9081", debit.counterpartyAccountDigits)
    assertEquals("ACCOUNT_TRANSFER", debit.purposeHint)
    val credit = parse("Credited INR 650.00 to your A/c XX6042 on 05-10-2026; debited from a/c XX9081. UPI Ref 735182094634")
    assertEquals("CREDIT", credit.direction)
    assertEquals("6042", credit.accountDigits)
    val sent = parse("Rs.650.00 sent to A/c XX9081 from A/c XX6042 on 05-10-2026. UPI Ref 735182094636")
    assertEquals("DEBIT", sent.direction)
    assertEquals("6042", sent.accountDigits)
    assertEquals("9081", sent.counterpartyAccountDigits)
  }

  @Test fun balanceOnlyAlertIsNotATransaction() {
    assertNull(SmsTransactionParser.parse("Balance in your A/c XX6042 as on 05-10-2026 is INR 12,500.00 after the last credited salary.", receipt))
    assertNull(SmsTransactionParser.parse("Avl Bal in A/c XX6042 is INR 12,500.00 on 05-10-2026.", receipt))
  }

  @Test fun cardAndLoanRepaymentsAreNeverPurchases() {
    val card = parse("Credit card bill payment of Rs 4,500.00 for card XX1234: your A/c XX6042 debited on 08-10-2026.")
    assertEquals(SmsTransactionParser.Kind.BANK_DEBIT, card.kind)
    assertEquals("DEBIT", card.direction)
    assertEquals("CARD_REPAYMENT", card.purposeHint)
    val loan = parse("Home Loan account XX7788 credited with EMI Rs 9,800.00 on 09-10-2026; your A/c XX6042 debited.")
    assertEquals(SmsTransactionParser.Kind.LOAN_DEBIT, loan.kind)
    assertEquals("DEBIT", loan.direction)
    assertEquals("6042", loan.accountDigits)
    assertEquals("LOAN_REPAYMENT", loan.purposeHint)
  }

  @Test fun conflictingVerbsOnCustomerAccountStayInManualReview() {
    val r = parse("Rs 300.00 credited to your A/c XX6042 debited on 06-10-2026. UPI Ref 735182094635")
    assertEquals(SmsTransactionParser.Kind.BANK_TRANSFER, r.kind)
    assertNull(r.direction)
    assertNull(r.purposeHint)
    assertTrue(r.requiresReview)
  }
}
