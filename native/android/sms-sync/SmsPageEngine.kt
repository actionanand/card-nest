package com.actionanand.cardnest.app.sms

/** Streaming boundary shared by ContentResolver scans and JVM failure/recovery tests. */
object SmsPageEngine {
  data class Message(val id: Long, val receivedAt: Long, val body: String)
  data class Progress(val scanned: Int, val found: Int, val more: Boolean, val cancelled: Boolean)
  fun consume(messages: Sequence<Message>, batch: Int, cancelled: () -> Boolean,
    stage: (SmsTransactionParser.Result, Long) -> Boolean, commitCursor: (Long, Long) -> Unit): Progress {
    require(batch in 1..500)
    var scanned = 0
    var found = 0
    for (message in messages.take(batch)) {
      if (cancelled()) return Progress(scanned,found,false,true)
      val parsed = SmsTransactionParser.parse(message.body,message.receivedAt)
      if (parsed != null) {
        check(stage(parsed,message.id)) { "Review queue full" }
        found++
      }
      commitCursor(message.receivedAt,message.id)
      scanned++
    }
    return Progress(scanned,found,scanned == batch,false)
  }
}
