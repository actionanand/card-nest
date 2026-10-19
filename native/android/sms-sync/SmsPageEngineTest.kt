package com.actionanand.cardnest.app.sms

import org.junit.Assert.*
import org.junit.Test

class SmsPageEngineTest {
  private fun messages(count: Int) = (1..count).asSequence().map {
    SmsPageEngine.Message(it.toLong(),1792411200000L + it,"Spent INR 12 on AMEX card ** 54321 on 18/10/26 UTR SYNTHREF${1000+it}")
  }
  @Test fun allBoundarySizesAreFullyProcessedWithBoundedPages() {
    for (size in listOf(0,1,199,200,201,400,1001)) {
      var cursor = 0L; var pages = 0; var scanned = 0; var more = true
      val ids = mutableSetOf<Long>()
      while (more) {
        val page = SmsPageEngine.consume(messages(size).filter { it.id > cursor },200,{false},
          { _,id -> ids.add(id); true }, { _,id -> cursor=id })
        scanned += page.scanned; pages++; more=page.more
        assertTrue(page.scanned <= 200)
      }
      assertEquals(size,scanned); assertEquals(size,ids.size)
      assertEquals(size / 200 + 1,pages)
    }
  }
  @Test fun failedStagingNeverAdvancesPastUnreadMessage() {
    var cursor=0L
    try { SmsPageEngine.consume(messages(4),200,{false},{_,id -> id != 3L},{_,id -> cursor=id}); fail() }
    catch (_: IllegalStateException) { assertEquals(2L,cursor) }
    val replay = mutableListOf<Long>()
    SmsPageEngine.consume(messages(4).filter { it.id > cursor },200,{false},{_,id -> replay.add(id); true},{_,id -> cursor=id})
    assertEquals(listOf(3L,4L),replay)
  }
  @Test fun crashBetweenQueueAndCursorReplaysOnlyTheAlreadyStagedRecord() {
    val staged=mutableSetOf<Long>(); var cursor=0L
    try { SmsPageEngine.consume(messages(4),200,{false},{_,id -> staged.add(id); true},{_,id -> if (id == 3L) error("synthetic crash") else cursor=id}) }
    catch (_: IllegalStateException) { }
    SmsPageEngine.consume(messages(4).filter { it.id > cursor },200,{false},{_,id -> staged.add(id); true},{_,id -> cursor=id})
    assertEquals(4,staged.size); assertEquals(4L,cursor)
  }
  @Test fun cancellationLeavesTheNextFinancialMessageUnread() {
    var cursor=0L
    val page=SmsPageEngine.consume(messages(201),200,{cursor == 1L},{_,_ -> true},{_,id -> cursor=id})
    assertTrue(page.cancelled); assertEquals(1L,cursor)
  }
  @Test fun ignoredOtpAdvancesCursorWithoutStagingAnySensitiveData() {
    var staged=false; var cursor=0L
    val page=SmsPageEngine.consume(sequenceOf(SmsPageEngine.Message(7,1,"OTP 123456 for card XX4321")),200,{false},{_,_-> staged=true;true},{_,id->cursor=id})
    assertFalse(staged); assertEquals(7L,cursor); assertEquals(0,page.found)
  }
}
