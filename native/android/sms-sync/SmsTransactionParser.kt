package com.actionanand.cardnest.app.sms

import java.math.BigDecimal
import java.security.MessageDigest
import java.time.*
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.ResolverStyle
import java.time.temporal.ChronoField
import java.util.Locale

/** Offline discovery only. A result is evidence, never permission to write money. */
object SmsTransactionParser {
  enum class Kind {
    PURCHASE, BANK_DEBIT, BANK_CREDIT, BANK_TRANSFER, CARD_PAYMENT_RECEIVED, PAYMENT_INITIATED,
    CASHBACK, REFUND, PLUXEE_TOPUP, PLUXEE_PURCHASE, FASTAG_TOLL, FASTAG_TOPUP,
    LOAN_DEBIT, STATEMENT, PAYMENT_REMINDER, LOAN_REMINDER, SCHEDULED_CHARGE
  }
  data class Result(
    val kind: Kind, val amountMinor: Long?, val eventDate: String, val merchant: String?,
    val cardDigits: String?, val accountDigits: String?, val issuer: String?, val reference: String?,
    val reportedBalanceMinor: Long?, val vehicleNumber: String?, val requiresReview: Boolean = true,
    val eventAt: String, val receivedAt: Long, val dateFallback: Boolean,
    val availableLimitMinor: Long?, val statementTotalMinor: Long?, val minimumDueMinor: Long?,
    val dueDate: String?, val fingerprint: String, val currency: String = "INR",
    val evidence: String = "Verify source, event date and amount before approval.",
    val eventTime: String, val timeZone: String, val cardNetwork: String?, val confidence: String,
    val earnedForPeriod: String?, val statementDate: String?, val merchantEvidence: String? = null,
    val balancePosition: String = "UNKNOWN", val eventTimeExplicit: Boolean = false,
    val parserVersion: Int = 3, val legacyId: String? = null, val standingInstructionReference: String? = null,
    /** Movement of the customer's own (primary) account, never the counterparty's. */
    val direction: String? = null, val counterpartyAccountDigits: String? = null,
    /** Review hint only: PURCHASE, INCOMING, ACCOUNT_TRANSFER, CARD_REPAYMENT, LOAN_REPAYMENT, CASH_WITHDRAWAL. */
    val purposeHint: String? = null,
    /** Informational card balance field; never the primary transaction amount. */
    val amountDueMinor: Long? = null,
    val accountMask: String? = null,
    val counterpartyAccountMask: String? = null
  )
  private data class AccountIdentifier(val suffix: String, val mask: String)

  private fun accountIdentifier(raw: String?): AccountIdentifier? {
    if (raw.isNullOrBlank() || raw.any { !(it in '0'..'9' || it in "xX*•●× -") }) return null
    val compact = raw.filter { it in '0'..'9' || it in "xX*•●×" }
    val lastMask = compact.indexOfLast { it in "xX*•●×" }
    val trailingDigits = (if (lastMask < 0) compact else compact.substring(lastMask + 1))
      .filter { it in '0'..'9' }
    if (trailingDigits.length < 3) return null
    val suffix = trailingDigits.takeLast(3)
    val firstMask = compact.indexOfFirst { it in "xX*•●×" }
    val digits = compact.filter { it in '0'..'9' }
    val prefix = when {
      firstMask >= 0 -> compact.substring(0, firstMask).filter { it in '0'..'9' }.take(3)
      digits.length >= 6 -> digits.take(minOf(3, digits.length - 4))
      else -> ""
    }
    val hidden = when {
      firstMask >= 0 -> (compact.length - prefix.length - 3).coerceAtLeast(1)
      digits.length >= 6 -> (digits.length - prefix.length - 3).coerceAtLeast(1)
      else -> 3
    }
    return AccountIdentifier(suffix, prefix + "•".repeat(hidden) + suffix)
  }

  private fun rx(s: String) = Regex(s, RegexOption.IGNORE_CASE)
  private const val DATE_TIME = "\\b(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[-/][0-9]{1,2}[-/](?:[0-9]{4}|[0-9]{2})|[0-9]{1,2}[-/ ][A-Za-z]{3,9}[-/ ](?:[0-9]{4}|[0-9]{2})|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Za-z]{3} [0-9]{1,2} [0-9]{4})(?:(?: at)? [0-9]{1,2}:[0-9]{2}(?::[0-9]{1,2})?(?: [AP]M)?)?"
  private const val NUMBER = "((?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,2}(?:,[0-9]{2})+,[0-9]{3})(?:\\.[0-9]{1,2})?)(?![0-9]|\\.[0-9]|,[0-9])"
  private const val MONEY = "(?:₹|\\bINR\\b|\\bRs\\.?)[\\s:.]*(?:Dr\\.?\\s*)?"
  private const val ACCOUNT_TOKEN = "[0-9xX*•●×](?:[0-9xX*•●× -]{1,60}[0-9xX*•●×])?"
  private const val ACCOUNT_MENTION = "\\b(?:acct|acc|a/c|account)\\s*(?:no\\.?\\s*)?($ACCOUNT_TOKEN)\\b"
  private val money = rx(MONEY + NUMBER)
  private fun minor(s: String?): Long? = try {
    s?.replace(",", "")?.let { BigDecimal(it).movePointRight(2).longValueExact() }
      ?.takeIf { it in 0..9_007_199_254_740_991L }
  } catch (_: ArithmeticException) { null } catch (_: NumberFormatException) { null }
  private fun value(text: String, label: String): Long? =
    minor(rx("(?:$label)[\\s:]*$MONEY$NUMBER").find(text)?.groupValues?.get(1))
  fun fingerprint(text: String): String = MessageDigest.getInstance("SHA-256")
    .digest(text.lowercase(Locale.ROOT).replace(Regex("\\s+"), " ").trim().toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }

  fun parse(body: String, receivedAtMillis: Long, zone: ZoneId = ZoneId.of("Asia/Kolkata")): Result? {
    if (body.isBlank() || body.length > 16_384) return null
    val text = body.replace('\u00a0', ' ').replace(Regex("[ \\t]+"), " ").trim()
    // Remove security instructions and URLs before extracting identifiers and dates.
    val safe = text.replace(rx("https?://\\S+|www\\.\\S+"), "")
      .split(rx("not you|if not you|to dispute|call |sms block|block your card"))[0]
    val flat = safe.replace('\n', ' ')
    val lower = flat.lowercase(Locale.ROOT)
    fun has(pattern: String) = rx(pattern).containsMatchIn(flat)
    if (has("\\b(otp|one.time.password|verification code|login code)\\b")) return null
    if (has("not been used|has not been used|reward points|exclusive offer|cashback offer")) return null
    val meal = has("pluxee|sodexo")
    val tag = has("fastag|toll paid|toll plaza")
    val bank = has("\\b(acct|acc|account|a/c)\\b")
    val card = !meal && !tag && has("card") && !has("debit card")
    val debit = has("\\b(spent|debited|charged|sent|toll paid)\\b") || has("transaction of.+was made using|thank you for using.+card")
    val credit = has("\\b(credited|received)\\b")
    // The primary account is the one addressed as "your" (else the first mention). Its movement is
    // the verb grammatically attached to it, never a verb tied to a payee or counterparty account.
    val accountMentions = rx(ACCOUNT_MENTION).findAll(flat).toList()
    // Direction attached to one account mention: "A/c X is credited" / "credited to A/c X" /
    // "debited from A/c X". "Sent/paid/transferred to A/c X" marks X as the counterparty.
    fun binding(mention: MatchResult): Pair<String?, Boolean> {
      val after = rx("^\\s*(?:\\([^)]*\\)\\s*)?(?:(?:is|has|have|was|got)\\s+)?(?:been\\s+)?(?:successfully\\s+)?(credited|debited)\\b")
        .find(flat.substring(mention.range.last + 1))?.groupValues?.get(1)?.lowercase(Locale.ROOT)
      val clauseStart = flat.lastIndexOf(';', mention.range.first).let { if (it < 0) 0 else it + 1 }
      val before = rx("\\b(credited|credit of|received|deposited|debited|debit of|withdrawn|sent|paid|transferred)\\b" +
        "(?:(?!\\b(?:credited|debited|received|deposited|withdrawn|sent|paid)\\b)[^;])*?\\b(to|in|into|from)\\s+(?:your\\s+)?(?:[a-z]+\\s+)?$")
        .find(flat.substring(clauseStart, mention.range.first))?.groupValues?.map { it.lowercase(Locale.ROOT) }
      val outgoingTo = before != null && before[1] in setOf("sent", "paid", "transferred") && before[2] != "from"
      val afterDirection = when (after) { "credited" -> "CREDIT"; "debited" -> "DEBIT"; else -> null }
      val beforeDirection = when { before == null -> null; before[2] == "from" -> "DEBIT"; else -> "CREDIT" }
      val direction = when {
        afterDirection != null && beforeDirection != null && afterDirection != beforeDirection -> "AMBIGUOUS"
        else -> afterDirection ?: beforeDirection
      }
      return direction to outgoingTo
    }
    val yourMention = accountMentions.firstOrNull { rx("\\byour\\s+(?:savings\\s+|bank\\s+)?$").containsMatchIn(flat.substring(0, it.range.first)) }
    val primaryMention = yourMention
      ?: accountMentions.firstOrNull { !binding(it).second }
      ?: accountMentions.firstOrNull()
    val boundDirection = primaryMention?.let { mention ->
      val (bound, outgoingTo) = binding(mention)
      // Only "your" account can be the target of "sent to"; otherwise that verb belongs to the sender.
      if (outgoingTo && mention != yourMention) null else bound
    }
    // Fallback for alerts without an attached verb: the first money verb.
    val debitAt = rx("\\b(?:debited|spent|sent|withdrawn|charged|paid)\\b").find(flat)?.range?.first
    val creditAt = rx("\\b(?:credited|received|deposited)\\b|\\b(?:neft|imps|rtgs|upi)\\s+credit\\b|\\bcredit of\\b").find(flat)?.range?.first
    val direction = if (!bank || boundDirection == "AMBIGUOUS") null else boundDirection ?: when {
      debitAt != null && (creditAt == null || debitAt < creditAt) -> "DEBIT"
      creditAt != null -> "CREDIT"
      else -> null
    }
    // A balance statement ("Balance in your A/c ... is INR ...") is not a completed transaction,
    // even when a later phrase mentions a past credit or debit.
    val balanceOnly = bank && boundDirection == null && run {
      val balanceAt = rx("\\b(?:bal(?:ance)?|avl\\.? bal)\\b").find(flat)?.range?.first
      val amountAt = money.find(flat)?.range?.first
      val verbAt = listOfNotNull(debitAt, creditAt).minOrNull()
      balanceAt != null && amountAt != null && balanceAt < amountAt && (verbAt == null || verbAt > balanceAt)
    }
    val mealTopup = has("\\b(credited|received|loaded|recharged|topped up)\\b")
    val mealDebit = has("\\b(spent|debited)\\b")
    val due = has("is due|due on|due by|payable by|amount due|minimum due|emi reminder")
    val loan = has("loan|\\bemi\\b|\\becs\\b|merchantmandate")
    val aggregator = has("\\bcred\\b|cheq|ccbp")
    val confirmed = card && !aggregator && has("payment of.{0,100}(received|credited)|online payment.{0,100}credited")
    val completedCardUse = card && has("\\b(?:credit\\s+)?card\\b.{0,50}\\b(?:(?:was|has been|has)\\s+)?used\\s+at\\b.{0,100}\\bfor\\s+$MONEY$NUMBER")
    val statement = card && (has("statement.{0,120}\\b(?:sent|generated|issued|available(?!\\s+limit)|ready|emailed|delivered)\\b|your\\s+(?:credit\\s+)?card\\s+statement|statement\\s+(?:total|amount)") ||
      (has("\\bstatement\\b") && due && has("total|minimum") && !has("reminder")))
    val purchase = has("\\b(spent|debited|charged)\\b|transaction of.+was made using|thank you for using.+card") || completedCardUse
    val scheduled = card && has("will be (?:charged|debited)|is scheduled to be (?:charged|debited)|standing instruction.{0,60}registered")
    // A failed attempt is not a debit; a reversal remains refund evidence below.
    if (has("failed|declined|unsuccessful|has not been charged|will not be charged") && !has("refunded|reversed|reversal")) return null
    val kind = when {
      has("refunded|refund successful|refund of|reversal|reversed") && (credit || has("refunded|reversed")) -> Kind.REFUND
      scheduled -> Kind.SCHEDULED_CHARGE
      card && has("mandate.{0,40}(?:successfully )?executed") -> Kind.PURCHASE
      card && has("cashback") && credit -> Kind.CASHBACK
      meal && mealTopup && !mealDebit -> Kind.PLUXEE_TOPUP
      meal && mealDebit -> Kind.PLUXEE_PURCHASE
      tag && debit -> Kind.FASTAG_TOLL
      tag && has("recharged|loaded|credited|topped up") -> Kind.FASTAG_TOPUP
      confirmed -> Kind.CARD_PAYMENT_RECEIVED
      aggregator && has("payment.{0,80}(received|processed)|sent|debited|paid") && !due && !loan -> Kind.PAYMENT_INITIATED
      statement && !purchase && !confirmed && !credit -> Kind.STATEMENT
      card && due && !purchase && !confirmed -> Kind.PAYMENT_REMINDER
      has("statement.+generated") && !purchase && !credit -> Kind.STATEMENT
      loan && due && !has("has been debited|(?:account|acc) [x*0-9]+ debited") -> Kind.LOAN_REMINDER
      due && !debit -> Kind.PAYMENT_REMINDER
      // Conflicting verbs on the customer's own account: keep for manual review with no direction.
      bank && boundDirection == "AMBIGUOUS" -> Kind.BANK_TRANSFER
      loan && debit && bank -> Kind.LOAN_DEBIT
      card && purchase && (!bank || has("(?:spent|charged).{0,40}(?:your|using|on).{0,20}card|(?:credit card|card)[x*0-9\\s]{0,20}debited")) -> Kind.PURCHASE
      bank && debit && has("\\bcred\\b|cheq|ccbp") -> Kind.PAYMENT_INITIATED
      bank && has("sent from|credited.+debited from|debited.+credited to (?:your )?(?:a/c|acct|acc|account)\\b") -> Kind.BANK_TRANSFER
      bank && direction == "DEBIT" -> Kind.BANK_DEBIT
      bank && direction == "CREDIT" -> Kind.BANK_CREDIT
      else -> return null
    }
    if (balanceOnly && kind in setOf(Kind.BANK_DEBIT, Kind.BANK_CREDIT)) return null
    val total = value(flat, "total (?:statement amount|amount due|amt|due)(?: of)?|statement total(?: due)?|total(?: of)?")
    val minimum = value(flat, "min(?:imum)? (?:amount |amt )?due(?: of)?|minimum(?: of)?")
    val amountDue = value(flat, "(?:amount\\s+due|due\\s+amount|(?<!minimum )due)")
    // Prefer verb-scoped monetary events; statement amounts and balance are separate evidence.
    val eventText = flat.split(rx(if (meal)
      "(?:current\\s+)?meal wallet balance|current balance|avl|available|wallet bal|statement total|minimum|total due|\\bdue\\b"
      else "avl|available|wallet bal|current meal|statement total|minimum|total due|\\bdue\\b"))[0]
    val amount = if (kind == Kind.STATEMENT || (kind == Kind.PAYMENT_REMINDER && total != null)) total ?: minimum ?: money.find(flat)?.groupValues?.get(1)?.let(::minor) else {
      val matches = money.findAll(eventText).map { minor(it.groupValues[1]) }.toList()
      if (matches.size > 1 && kind !in setOf(Kind.PAYMENT_REMINDER, Kind.LOAN_REMINDER)) return null
      matches.firstOrNull()
    }
    if (amount == null || amount <= 0) return null
    val digits = rx("\\b(?:credit card|card|bobcard)(?:\\s+(?:no\\.?|ending(?: with)?))?\\s*[x*]*\\s*([0-9]{4,5})\\b")
      .find(flat)?.groupValues?.get(1)
      ?: if (meal) rx("\\b(?:meal card|wallet|card)(?:\\s+(?:number|no\\.?|ending(?:\\s+(?:with|in))?))?\\s*[:#-]?\\s*(?:[x*]\\s*)*([0-9]{4})\\b").find(flat)?.groupValues?.get(1) else null
    val accounts = accountMentions.map { it.groupValues[1] }
    val account = primaryMention?.groupValues?.get(1)
    val primaryIdentifier = accountIdentifier(account)
    val counterpartyRaw = accounts.firstOrNull { it != account }
    val counterpartyIdentifier = accountIdentifier(counterpartyRaw)
    val issuer = listOf("Pluxee" to "pluxee|sodexo", "Axis" to "axis", "ICICI" to "icici",
      "HDFC" to "hdfc", "HSBC" to "hsbc", "PNB" to "pnb", "AMEX" to "amex|american express", "Standard Chartered" to "stanchart|standard chartered",
      "Federal" to "federal", "BOBCARD" to "bobcard", "IDFC FIRST" to "idfc", "AU Bank" to "au bank", "Slice" to "slice",
      "Yes Bank" to "yes bank|yesbank", "IndusInd Bank" to "indusind")
      .firstOrNull { has(it.second) }?.first
    val ref = rx("\\b(?:UPI\\s*(?:ref(?:erence)?\\s*(?:no\\.?)?)?|RRN|UTR|Ref(?:erence)?\\s*(?:No\\.?|ID)?)\\s*[:#.]?\\s*([A-Z0-9]{9,30})\\b")
      .find(flat)?.groupValues?.get(1)
    val bankEvent = kind in setOf(Kind.BANK_DEBIT, Kind.BANK_CREDIT, Kind.BANK_TRANSFER) ||
      (kind == Kind.PAYMENT_INITIATED && bank)
    // Counterparty names are descriptions only; an account mention is never a payee name.
    val accountWords = rx("\\b(?:a/c|acct|acc|account|savings)\\b")
    fun payee(pattern: String) = rx(pattern).find(flat)?.groupValues?.get(1)?.takeIf { !accountWords.containsMatchIn(it) }
    val counterparty = if (!bankEvent) null else
      payee(";\\s*(.+?)\\s+credited\\b")
        ?: payee("\\bfrom\\s+(?!(?:your\\s+)?(?:a/c|acct|acc|account)\\b)([A-Za-z][^.;(]*?)(?=\\s+(?:via|on|ref|upi|through)\\b|\\s*[.;(]|$)")
        ?: payee("\\bto\\s+(?!(?:your\\s+)?(?:a/c|acct|acc|account)\\b)([A-Za-z][^.;(]*?)(?=\\s+(?:via|on|ref|upi|through)\\b|\\s*[.;(]|$)")
        ?: payee("\\btowards\\s+([A-Za-z][^.;(]*?)(?=\\s+for\\b|\\s*[.;(]|$)")
    val cardUseMerchant = rx("\\b(?:credit\\s+)?card\\b.{0,50}\\b(?:(?:was|has been|has)\\s+)?used\\s+at\\s+(.+?)\\s+for\\s+(?:₹|\\bINR\\b|\\bRs\\.?)").find(flat)?.groupValues?.get(1)
    val merchant = if (bankEvent) counterparty else cardUseMerchant ?: rx("\\bfor (.+?) has been charged").find(flat)?.groupValues?.get(1)
      ?: rx("\\bby (.+?) on [0-9]{1,2}[-/]").find(flat)?.groupValues?.get(1)
      ?: rx("\\bat\\s+(.+?)(?=\\s+(?:on|via|through|avl|wallet bal)\\b|\\s*\\.\\s*Avl|$)").find(flat)?.groupValues?.get(1)
      ?: safe.lines().getOrNull(3)?.takeIf { has("spent") && !it.contains("limit", true) }
      ?: rx("\\bon [0-9]{1,2}[-/][A-Za-z0-9]{2,3}[-/][0-9]{2,4} on (.+?)(?:\\. Avl|$)").find(flat)?.groupValues?.get(1)
      ?: rx(";\\s*(.+?) credited").find(flat)?.groupValues?.get(1)
      ?: rx("(?:refunded by|from) (.+?)(?= on | is credited|\\.|$)").find(flat)?.groupValues?.get(1)
    // A deadline is never the financial event date. Receipt fallback is explicit evidence.
    val eventTextDates = safe.replace(rx("(?:due on|due by|payable by)[: ]+[^.;\\n]+"), "")
    // Require a date immediately after the statement wording; never scan ahead to a deadline.
    val statementDates = safe.replace(rx("([0-9]{1,2})(?:st|nd|rd|th)\\b"), "$1")
    val statementText = rx("statement\\s+(?:dated|date)\\s*:?\\s*($DATE_TIME)").find(statementDates)?.groupValues?.get(1)
      ?: rx("statement\\s+(?:(?:was|is|has been)\\s+)?(?:issued|available)\\s+on\\s+($DATE_TIME)").find(statementDates)?.groupValues?.get(1)
    val event = event(if (kind == Kind.STATEMENT || kind == Kind.PAYMENT_REMINDER) statementText ?: "" else eventTextDates, receivedAtMillis, zone) ?: return null
    val dueText = rx(if (due || kind == Kind.STATEMENT) "(?:due on|due by|payable by|\\bby)[: ]+(.+)" else "(?:due on|due by|payable by)[: ]+(.+)").find(safe)?.groupValues?.get(1)
    val parsedDue = dueText?.let { event(it, receivedAtMillis, zone) }?.takeIf { !it.second }?.first?.toLocalDate()?.toString()
    val cleanMerchant = merchant?.split(rx("\\b(?:t&cs|terms and conditions|manage|you can manage|unsubscribe|contact support|ref(?:erence)?|utr|rrn|visit|click|not you|if not you|to dispute|call|sms block)\\b"))?.firstOrNull()
      ?.trim()?.trimEnd('.', ',', ';')?.takeIf { it.isNotBlank() && !rx("^(?:[0-9\\W]+|(?:[a-z0-9-]+\\.)+[a-z]{2,}(?:/.*)?|[a-z0-9]{18,})$").matches(it) }?.take(100)
    return Result(kind, amount, event.first.toLocalDate().toString(), cleanMerchant,
      digits, primaryIdentifier?.suffix, issuer, ref, value(flat, if (meal)
        "(?:(?:current\\s+)?meal wallet balance|current balance|(?:avl|available|wallet)\\.?\\s*bal(?:ance)?\\.?)(?:\\s+is)?"
        else "current meal wallet balance is|current balance|(?:avl|available|wallet)\\.?\\s*bal(?:ance)?\\.?"),
      if (tag) rx("\\b[A-Z]{2}\\s?[0-9]{1,2}\\s?[A-Z]{1,3}\\s?[0-9]{4}\\b").find(flat)?.value?.replace(" ", "")?.uppercase(Locale.ROOT) else null,
      eventAt = event.first.toInstant().toString(), receivedAt = receivedAtMillis, dateFallback = event.second,
      availableLimitMinor = value(flat, "(?:avl|available) limit"), statementTotalMinor = total,
      minimumDueMinor = minimum, dueDate = parsedDue,
      fingerprint = fingerprint(text + if (event.second) "|${event.first.toLocalDate()}" else ""),
      eventTime = event.first.toLocalTime().toString(), timeZone = event.first.zone.id,
      cardNetwork = if (issuer == "AMEX") "AMERICAN_EXPRESS" else if (has("rupay")) "RUPAY" else null,
      confidence = if (digits != null && issuer != null) "SOURCE_EVIDENCE" else "SOURCE_SELECTION_REQUIRED",
      earnedForPeriod = if (kind == Kind.CASHBACK && has("last month")) "previous month" else null,
      statementDate = statementText?.let { event(it, receivedAtMillis, zone) }
        ?.takeIf { !it.second }?.first?.toLocalDate()?.toString(),
      merchantEvidence = merchant?.trim()?.take(300),
      balancePosition = if (meal && has("(?:current\\s+)?meal wallet balance|current balance|(?:available|avl|wallet) bal(?:ance)?") && !has("before|opening balance")) "AFTER" else "UNKNOWN",
      eventTimeExplicit = event.third,
      standingInstructionReference = rx("\\bSI Hub Id\\s+([A-Z0-9]{6,40})\\b").find(flat)?.groupValues?.get(1),
      direction = direction,
      counterpartyAccountDigits = counterpartyIdentifier?.suffix,
      purposeHint = when {
        !bank -> null
        kind == Kind.LOAN_DEBIT -> "LOAN_REPAYMENT"
        kind == Kind.PAYMENT_INITIATED -> "CARD_REPAYMENT"
        direction == "DEBIT" && has("credit\\s*card\\s*(?:bill|payment|dues?)|towards.{0,40}\\bcard\\b|\\bbbps\\b") -> "CARD_REPAYMENT"
        direction == "DEBIT" && has("\\batm\\b|cash withdrawal|withdrawn") -> "CASH_WITHDRAWAL"
        kind in setOf(Kind.BANK_TRANSFER, Kind.BANK_DEBIT, Kind.BANK_CREDIT) && counterpartyRaw != null -> "ACCOUNT_TRANSFER"
        direction == "CREDIT" -> "INCOMING"
        direction == "DEBIT" -> "PURCHASE"
        else -> null
      },
      amountDueMinor = amountDue,
      accountMask = primaryIdentifier?.mask,
      counterpartyAccountMask = counterpartyIdentifier?.mask,
      legacyId = if (kind == Kind.STATEMENT || kind == Kind.PAYMENT_REMINDER) fingerprint(text) else null)
  }

  private fun event(text: String, receipt: Long, zone: ZoneId): Triple<ZonedDateTime, Boolean, Boolean>? {
    val dateRx = rx(DATE_TIME)
    val dateText = text.replace(rx("\\b(?:Ref(?:erence)?(?: No\\.?)?|UTR|RRN|UPI Ref(?: No\\.?)?)\\s*[:#.]?\\s*[A-Z0-9-]{8,30}"), "")
      .replace(rx("([0-9]{1,2})(?:st|nd|rd|th)\\b"), "$1")
    val raw = dateRx.find(dateText)?.value?.replace(" at ", " ", true)?.replace(Regex("^[A-Za-z]{3} "), "")
    if (raw != null) {
      val datePatterns = listOf("uuuu-MM-dd", "d-M-uuuu", "d/M/uuuu", "d-M-yy", "d/M/yy", "d-MMM-yy", "d/MMM/uuuu", "d-MMM-uuuu", "d MMMM uuuu", "d MMM uuuu", "MMM d uuuu")
      for (pattern in datePatterns) for (time in listOf(" H:mm:ss", " H:mm:s", " H:mm", " h:mm:ss a", " h:mm a", "")) {
        try {
          val builder = DateTimeFormatterBuilder().parseCaseInsensitive().appendPattern(pattern + time)
            .parseDefaulting(ChronoField.ERA, 1).parseDefaulting(ChronoField.MINUTE_OF_HOUR, 0).parseDefaulting(ChronoField.SECOND_OF_MINUTE, 0)
          if (time.isEmpty()) builder.parseDefaulting(ChronoField.HOUR_OF_DAY, 0)
          val formatter = builder
            .toFormatter(Locale.ENGLISH).withResolverStyle(ResolverStyle.STRICT)
          return Triple(LocalDateTime.parse(raw, formatter).atZone(if (text.contains("IST")) ZoneId.of("Asia/Kolkata") else zone), false, time.isNotEmpty())
        } catch (_: DateTimeException) { }
      }
      return null // Explicit invalid dates must not silently become the receipt date.
    }
    return Triple(Instant.ofEpochMilli(receipt).atZone(zone), true, false)
  }
}
