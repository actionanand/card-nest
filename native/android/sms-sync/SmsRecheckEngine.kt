package com.actionanand.cardnest.app.sms

/** In-memory original-message recovery; the caller owns permission and provider cursor lifetime. */
object SmsRecheckEngine {
  data class Identity(val id: String, val providerId: String, val receivedAt: Long)
  data class Original(val receivedAt: Long, val body: String)
  fun recover(requests: List<Identity>, lookup: (String) -> Original?): List<Pair<Identity, SmsTransactionParser.Result>> {
    require(requests.size <= 50)
    require(requests.all { Regex("[a-f0-9]{64}").matches(it.id) && it.receivedAt >= 0 })
    return requests.distinctBy { it.id }.mapNotNull { request ->
      if (!Regex("[0-9]{1,19}").matches(request.providerId)) return@mapNotNull null
      val original = lookup(request.providerId) ?: return@mapNotNull null
      // Provider row IDs can be reused. Receipt equality is required before reparsing a row.
      if (original.receivedAt != request.receivedAt) return@mapNotNull null
      SmsTransactionParser.parse(original.body, original.receivedAt)?.let { request to it }
    }
  }
}
