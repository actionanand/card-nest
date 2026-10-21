package com.actionanand.cardnest.app.sms

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** Fictional values only. Receipt in October must never replace a valid July date. */
class SmsRecurringNoticeTest {
  private val receipt = Instant.parse("2026-10-21T14:00:00Z").toEpochMilli()
  private fun parse(text: String) = requireNotNull(SmsTransactionParser.parse(text, receipt))
  private val upcoming = "INR 876.54 will be charged to your Amex Card ending 4321 by Fictional Insurance on 17/07/2026. You can manage your Standing Instructions with SI Hub ID SYNTHSI12345 at www.example.com/sihub. T&Cs Apply"
  private val completed = "INR 876.54 for Fictional Insurance has been charged to your Amex Card ending 54321 on 17/07/2026 via SI Hub. You can manage your Standing Instructions with SI Hub ID SYNTHSI12345 at www.example.com/sihub. T&Cs apply."
  @Test fun separatesUpcomingAndConfirmedWithoutDateOrMerchantFabrication() {
    val a = parse(upcoming); val b = parse(completed)
    assertEquals(SmsTransactionParser.Kind.SCHEDULED_CHARGE, a.kind)
    assertEquals(SmsTransactionParser.Kind.PURCHASE, b.kind)
    for (result in listOf(a,b)) {
      assertEquals(87654L, result.amountMinor)
      assertEquals("Fictional Insurance", result.merchant)
      assertEquals("2026-07-17", result.eventDate)
      assertFalse(result.dateFallback)
      assertFalse(result.eventTimeExplicit)
      assertEquals("SYNTHSI12345", result.standingInstructionReference)
      assertEquals(3, result.parserVersion)
    }
    assertEquals("4321", a.cardDigits); assertEquals("54321", b.cardDigits)
    assertNotEquals(a.fingerprint, b.fingerprint)
    assertEquals(b.fingerprint, parse(completed).fingerprint)
  }
  @Test fun scheduledRegisteredAndFailedNoticesCannotBecomePurchases() {
    for (text in listOf(upcoming.replace("will be charged", "is scheduled to be charged"), "Standing instruction registered for INR 876.54 on your Amex Card ending 4321 by Fictional Insurance on 17/07/2026"))
      assertEquals(SmsTransactionParser.Kind.SCHEDULED_CHARGE, parse(text).kind)
    for (word in listOf("failed", "declined", "unsuccessful"))
      assertNull(SmsTransactionParser.parse("Scheduled charge of INR 876.54 on Amex card ending 4321 $word on 17/07/2026", receipt))
  }
  @Test fun executedMandateIsConfirmedAndReversalIsRefund() {
    assertEquals(SmsTransactionParser.Kind.PURCHASE, parse("Mandate successfully executed: INR 876.54 charged to Amex Card ending 4321 at Fictional Insurance on 17/07/2026").kind)
    assertEquals(SmsTransactionParser.Kind.REFUND, parse("INR 876.54 reversed to your Amex Card ending 4321 on 17/07/2026").kind)
  }
  @Test fun distinctMonthlyCyclesKeepTheirExplicitDatesAndFingerprints() {
    val july=parse(completed); val october=parse(completed.replace("17/07/2026", "17/10/2026"))
    assertEquals("2026-07-17",july.eventDate); assertEquals("2026-10-17",october.eventDate)
    assertNotEquals(july.fingerprint,october.fingerprint)
  }
}
