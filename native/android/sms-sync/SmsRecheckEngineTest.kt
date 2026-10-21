package com.actionanand.cardnest.app.sms

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class SmsRecheckEngineTest {
  private val received = Instant.parse("2026-10-19T12:00:00Z").toEpochMilli()
  private val identity = SmsRecheckEngine.Identity("a".repeat(64), "42", received)
  private val statement = "ICICI card XX4321 Statement is sent. Total of Rs 1,234.56 or minimum of Rs 120 is due by 30-Oct-26."
  @Test fun recoversClassificationWithoutChangingSavedIdentity() {
    val result = SmsRecheckEngine.recover(listOf(identity)) { SmsRecheckEngine.Original(received, statement) }.single()
    assertEquals(identity, result.first)
    assertEquals(SmsTransactionParser.Kind.STATEMENT, result.second.kind)
    assertEquals("2026-10-19", result.second.eventDate)
    assertEquals("2026-10-30", result.second.dueDate)
  }
  @Test fun missingAndReusedProviderRowsCannotBeReclassified() {
    assertTrue(SmsRecheckEngine.recover(listOf(identity)) { null }.isEmpty())
    assertTrue(SmsRecheckEngine.recover(listOf(identity)) { SmsRecheckEngine.Original(received + 1, statement) }.isEmpty())
  }
  @Test fun pastedEvidenceDoesNotQueryProviderAndDuplicateRequestsAreBounded() {
    var calls = 0
    assertTrue(SmsRecheckEngine.recover(listOf(identity.copy(providerId = "paste"))) { calls++; null }.isEmpty())
    assertEquals(0, calls)
    assertEquals(1, SmsRecheckEngine.recover(listOf(identity, identity)) { calls++; SmsRecheckEngine.Original(received, statement) }.size)
    assertEquals(1, calls)
  }
  @Test fun unsupportedBodiesAreNotReturnedAsValidEvidence() {
    assertTrue(SmsRecheckEngine.recover(listOf(identity)) { SmsRecheckEngine.Original(received, "OTP 123456") }.isEmpty())
  }
  @Test fun invalidOrOversizedRequestsFailBeforeAnyLookup() {
    var calls = 0
    for (requests in listOf(List(51) { identity }, listOf(identity.copy(id = "invalid")))) {
      try { SmsRecheckEngine.recover(requests) { calls++; null }; fail("Expected invalid request rejection") } catch (_: IllegalArgumentException) { }
    }
    assertEquals(0, calls)
  }
}
