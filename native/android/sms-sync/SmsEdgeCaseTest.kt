package com.actionanand.cardnest.app.sms

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class SmsEdgeCaseTest {
  private val receipt = Instant.parse("2026-10-19T12:00:00Z").toEpochMilli()
  private fun parse(s: String) = requireNotNull(SmsTransactionParser.parse(s, receipt))
  @Test fun securityBlockSuffixCannotMatchCard() {
    val r = parse("A transaction of Rs.17 was made using your HDFC Credit Card at DEMO STORE on 18/10/26. SMS BLOCKPCC 9876 to 9000000000")
    assertNull(r.cardDigits)
  }
  @Test fun preserveTimeAndExplicitIst() {
    val r = parse("Spent INR 123.45 on AMEX card ** 54321 at DEMO STORE on 17 October 2026 at 02:20 PM IST")
    assertEquals("2026-10-17T08:50:00Z", r.eventAt)
    assertFalse(r.dateFallback)
  }
  @Test fun dateOnlyUsesMidnightInSuppliedZone() {
    val r = SmsTransactionParser.parse("Spent INR 123 on AMEX card ** 54321 on 17/10/2026", receipt, ZoneId.of("America/New_York"))!!
    assertEquals("2026-10-17T04:00:00Z", r.eventAt)
  }
  @Test fun shortYearsAlwaysUse2000Century() {
    assertEquals("2099-01-01", parse("Spent INR 1 on AMEX card ** 54321 on 01/01/99").eventDate)
  }
  @Test fun fallbackIsDisclosedAndReceiptSeparate() {
    val r = parse("Cashback of INR 9 credited to Axis credit card XX4321 for last month spends")
    assertEquals("2026-10-19", r.eventDate); assertTrue(r.dateFallback); assertEquals(receipt,r.receivedAt)
  }
  @Test fun malformedSecondsBecomeValidTime() {
    assertEquals("2026-10-07T17:22:03Z", parse("Rs.3 spent from Pluxee Meal wallet on 7-10-2026 22:52:3 at DEMO").eventAt)
  }
  @Test fun amountConflictsFailClosed() {
    assertNull(SmsTransactionParser.parse("Spent INR 400 and INR 500 on AMEX card ** 54321",receipt))
    assertNull(SmsTransactionParser.parse("Spent INR -1 on AMEX card ** 54321",receipt))
    assertNull(SmsTransactionParser.parse("Spent INR 99999999999999999999 on AMEX card ** 54321",receipt))
    assertNull(SmsTransactionParser.parse("Spent INR 1.123 on AMEX card ** 54321",receipt))
  }
  @Test fun otpNeverPersistsEvenWithFinancialWords() {
    assertNull(SmsTransactionParser.parse("OTP 123456 for INR 500 to be debited from your card XX4321",receipt))
  }
  @Test fun partialRefundsWithDifferentReferencesStaySeparate() {
    val a = parse("Refund of INR 12 credited to credit card XX4321 on 18/10/26 UTR SYNTHREF1234")
    val b = parse("Refund of INR 12 credited to credit card XX4321 on 18/10/26 UTR SYNTHREF5678")
    assertNotEquals(a.fingerprint,b.fingerprint)
    assertEquals(a.amountMinor,b.amountMinor)
  }
  @Test fun duplicateCaseAndSpacingNormalizesWithoutCollapsingDifferentDates() {
    assertEquals(SmsTransactionParser.fingerprint("DEMO  SMS\n"),SmsTransactionParser.fingerprint("demo sms"))
    assertNotEquals(parse("Spent INR 12 on AMEX card ** 54321 on 18/10/26").fingerprint,parse("Spent INR 12 on AMEX card ** 54321 on 18/09/26").fingerprint)
  }
  @Test fun purchaseAndAvailableLimitAreDistinct() {
    val r = parse("Spent INR 12 on Axis credit card XX4321 on 18/10/26. Available limit INR 150000")
    assertEquals(1200L,r.amountMinor); assertEquals(15000000L,r.availableLimitMinor)
  }
  @Test fun exactDuplicateRefundHasSameIdentity() {
    val body = "Refund of INR 12 credited to credit card XX4321 on 18/10/26 UTR SYNTHREF1234"
    assertEquals(parse(body).fingerprint,parse(body).fingerprint)
  }
  @Test fun datesInsideReferencesAndLinksAreNotFinancialDates() {
    val r=parse("Spent INR 12 on AMEX card ** 54321 Ref 2026-01-01 https://example.invalid/2026-02-02")
    assertTrue(r.dateFallback);assertEquals("2026-10-19",r.eventDate)
  }
  @Test fun explicitInvalidDatesFailClosedInsteadOfBecomingReceiptDate() {
    assertNull(SmsTransactionParser.parse("Spent INR 12 on AMEX card ** 54321 on 31/02/2026",receipt))
  }
  @Test fun mentioningTargetCreditCardDoesNotTurnBankDebitIntoPurchase() {
    assertEquals(SmsTransactionParser.Kind.PAYMENT_INITIATED,parse("Bank account XX4321 debited INR 300 to CRED towards credit card bill on 18/10/26").kind)
    assertEquals(SmsTransactionParser.Kind.BANK_DEBIT,parse("Bank account XX4321 debited INR 300 towards credit card payment on 18/10/26").kind)
  }
  @Test fun aggregatorReceiptIsNotFinalIssuerConfirmation() {
    assertEquals(SmsTransactionParser.Kind.PAYMENT_INITIATED,parse("CRED payment of INR 300 received for your credit card XX5432 on 18/10/26 and processing").kind)
    assertEquals(SmsTransactionParser.Kind.LOAN_DEBIT,parse("Bank account XX4321 debited INR 300 towards CRED cash loan EMI on 18/10/26").kind)
  }
}
