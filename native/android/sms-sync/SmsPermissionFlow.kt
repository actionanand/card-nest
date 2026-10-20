package com.actionanand.cardnest.app.sms

/** Pure permission coordinator. Android remains the authority for each grant. */
class SmsPermissionFlow(
  private val observe: () -> Access,
  private val history: () -> History,
  private val recordOutcome: (Boolean) -> Unit,
  private val activate: (Bounds) -> Unit,
) {
  data class Grant(val granted: Boolean, val declared: Boolean = true,
    val rationale: Boolean = false, val policyBlocked: Boolean = false)
  data class Access(val read: Grant, val receive: Grant, val supported: Boolean = true) {
    val granted get() = read.granted && receive.granted
  }
  data class History(val wasGranted: Boolean = false, val deniedCallback: Boolean = false)
  data class Bounds(val since: Long, val batch: Int)
  data class Status(val permission: String, val canRequest: Boolean, val settingsRecommended: Boolean,
    val readGranted: Boolean, val receiveGranted: Boolean, val message: String)
  enum class Start { REQUEST, COMPLETE, UNAVAILABLE }
  @Volatile private var pending: Bounds? = null
  val requesting get() = pending != null

  fun status(): Status {
    val access = observe()
    val past = history()
    val missing = listOf(access.read, access.receive).filterNot { it.granted }
    val unsupported = !access.supported || missing.any { !it.declared || it.policyBlocked }
    // false rationale alone cannot distinguish a first request from a blocked prompt.
    val noPrompt = past.deniedCallback && missing.any { !it.rationale }
    val state = when {
      requesting -> "requesting"
      access.granted -> "granted"
      past.wasGranted -> "revoked"
      unsupported || noPrompt -> "unavailable"
      past.deniedCallback || missing.any { it.rationale } -> "denied"
      else -> "not requested"
    }
    val message = when (state) {
      "requesting" -> "Waiting for Android's SMS permission response."
      "granted" -> "Both SMS permissions are granted. Discovery still requires your opt-in."
      "revoked" -> "SMS access was revoked. Scanning is paused; saved progress and suggestions are preserved."
      "unavailable" -> "Android did not make SMS access available. A previous denial, device policy or installer restriction may prevent another prompt. Check CardNest app settings or paste a message."
      "denied" -> "Android has not granted both SMS permissions. You can try again or paste a message."
      else -> "Enable SMS access to ask Android for inbox and incoming-message permission."
    }
    // A no-rationale callback may also be a dismissed dialog. Recommend settings
    // without pretending we can read USER_FIXED; an explicit retry remains allowed.
    return Status(state, !requesting && !unsupported, !access.granted && (unsupported || noPrompt || past.wasGranted),
      access.read.granted, access.receive.granted, message)
  }
  @Synchronized fun begin(bounds: Bounds): Start {
    check(!requesting) { "An SMS permission request is already in progress." }
    require(bounds.since >= 0 && bounds.batch in 1..500)
    if (observe().granted) { activate(bounds); return Start.COMPLETE }
    if (!status().canRequest) return Start.UNAVAILABLE
    pending = bounds
    return Start.REQUEST
  }
  @Synchronized fun complete() {
    val bounds = pending ?: return // a failed/expired request must never enable later
    try {
      val granted = observe().granted
      recordOutcome(granted)
      if (granted) activate(bounds)
    } finally { pending = null }
  }
  @Synchronized fun failed() { pending = null }
}
