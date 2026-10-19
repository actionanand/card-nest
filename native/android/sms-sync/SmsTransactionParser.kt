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
    LOAN_DEBIT, STATEMENT, PAYMENT_REMINDER, LOAN_REMINDER
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
    val earnedForPeriod: String?, val statementDate: String?
  )
  private fun rx(s: String) = Regex(s, RegexOption.IGNORE_CASE)
  private const val NUMBER = "([0-9][0-9,]*(?:\\.[0-9]{1,2})?)(?![0-9]|\\.[0-9])"
  private const val MONEY = "(?:₹|\\bINR\\b|\\bRs\\.?)[\\s:.]*(?:Dr\\.?\\s*)?"
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
    val due = has("is due|due on|due by|payable by|amount due|minimum due|emi reminder")
    val loan = has("loan|\\bemi\\b|\\becs\\b|merchantmandate")
    val confirmed = card && has("payment of.{0,100}(received|credited)|online payment.{0,100}credited")
    val kind = when {
      has("refunded|refund successful|refund of|reversal|reversed") && (credit || has("refunded|reversed")) -> Kind.REFUND
      card && has("cashback") && credit -> Kind.CASHBACK
      meal && credit && !debit -> Kind.PLUXEE_TOPUP
      meal && debit -> Kind.PLUXEE_PURCHASE
      tag && debit -> Kind.FASTAG_TOLL
      tag && has("recharged|loaded|credited|topped up") -> Kind.FASTAG_TOPUP
      confirmed -> Kind.CARD_PAYMENT_RECEIVED
      has("statement.+generated") -> Kind.STATEMENT
      loan && due && !has("has been debited|(?:account|acc) [x*0-9]+ debited") -> Kind.LOAN_REMINDER
      due && !debit -> Kind.PAYMENT_REMINDER
      loan && debit && bank -> Kind.LOAN_DEBIT
      card && debit -> Kind.PURCHASE
      bank && debit && has("\\bcred\\b|cheq|ccbp") -> Kind.PAYMENT_INITIATED
      bank && has("sent from|credited.+debited from") -> Kind.BANK_TRANSFER
      bank && debit -> Kind.BANK_DEBIT
      bank && credit -> Kind.BANK_CREDIT
      else -> return null
    }
    val total = value(flat, "total (?:amount due|amt|due)(?: of)?|statement total due")
    val minimum = value(flat, "min(?:imum)? (?:amount |amt )?due(?: of)?")
    // Prefer verb-scoped monetary events; statement amounts and balance are separate evidence.
    val eventText = flat.split(rx("avl|available|wallet bal|current meal|statement total|minimum|total due"))[0]
    val amount = if (kind == Kind.STATEMENT || (kind == Kind.PAYMENT_REMINDER && total != null)) total else {
      val matches = money.findAll(eventText).map { minor(it.groupValues[1]) }.toList()
      if (matches.size > 1 && kind !in setOf(Kind.PAYMENT_REMINDER, Kind.LOAN_REMINDER)) return null
      matches.firstOrNull()
    }
    if (amount == null || amount <= 0) return null
    val digits = rx("\\b(?:credit card|card|bobcard)(?:\\s+(?:no\\.?|ending(?: with)?))?\\s*[x*]*\\s*([0-9]{4,5})\\b")
      .find(flat)?.groupValues?.get(1)
    val account = rx("\\b(?:acct|acc|a/c|account)\\s*(?:no\\.?\\s*)?(?:[0-9]*[x*]+)([0-9]{3,5})\\b").find(flat)?.groupValues?.get(1)
    val issuer = listOf("Pluxee" to "pluxee|sodexo", "Axis" to "axis", "ICICI" to "icici",
      "HDFC" to "hdfc", "PNB" to "pnb", "AMEX" to "amex|american express", "Standard Chartered" to "stanchart|standard chartered",
      "Federal" to "federal", "BOBCARD" to "bobcard", "IDFC FIRST" to "idfc", "AU Bank" to "au bank", "Slice" to "slice")
      .firstOrNull { has(it.second) }?.first
    val ref = rx("\\b(?:UPI\\s*(?:ref(?:erence)?\\s*(?:no\\.?)?)?|RRN|UTR|Ref(?:erence)?\\s*(?:No\\.?)?)\\s*[:#.]?\\s*([A-Z0-9]{9,30})\\b")
      .find(flat)?.groupValues?.get(1)
    val merchant = rx("\\bfor (.+?) has been charged").find(flat)?.groupValues?.get(1)
      ?: rx("\\bat\\s+(.+?)(?=\\s+(?:on|via|through|avl|wallet bal)\\b|\\s*\\.\\s*Avl|$)").find(flat)?.groupValues?.get(1)
      ?: safe.lines().getOrNull(3)?.takeIf { has("spent") && !it.contains("limit", true) }
      ?: rx("\\bon [0-9]{1,2}[-/][A-Za-z0-9]{2,3}[-/][0-9]{2,4} on (.+?)(?:\\. Avl|$)").find(flat)?.groupValues?.get(1)
      ?: rx(";\\s*(.+?) credited").find(flat)?.groupValues?.get(1)
      ?: rx("(?:refunded by|from) (.+?)(?= on | is credited|\\.|$)").find(flat)?.groupValues?.get(1)
    val event = event(safe, receivedAtMillis, zone) ?: return null
    val dueText = rx("(?:due on|due by|payable by|\\bby)[: ]+(.+)").find(safe)?.groupValues?.get(1)
    val parsedDue = dueText?.let { event(it, receivedAtMillis, zone) }?.takeIf { !it.second }?.first?.toLocalDate()?.toString()
    return Result(kind, amount, event.first.toLocalDate().toString(), merchant?.trim()?.trimEnd('.')?.take(100),
      digits, account, issuer, ref, value(flat, "current meal wallet balance is|current balance|(?:avl|available|wallet) bal(?:ance)?"),
      if (tag) rx("\\b[A-Z]{2}\\s?[0-9]{1,2}\\s?[A-Z]{1,3}\\s?[0-9]{4}\\b").find(flat)?.value?.replace(" ", "")?.uppercase(Locale.ROOT) else null,
      eventAt = event.first.toInstant().toString(), receivedAt = receivedAtMillis, dateFallback = event.second,
      availableLimitMinor = value(flat, "(?:avl|available) limit"), statementTotalMinor = total,
      minimumDueMinor = minimum, dueDate = parsedDue,
      fingerprint = fingerprint(text + if (event.second) "|${event.first.toLocalDate()}" else ""),
      eventTime = event.first.toLocalTime().toString(), timeZone = event.first.zone.id,
      cardNetwork = if (issuer == "AMEX") "AMERICAN_EXPRESS" else if (has("rupay")) "RUPAY" else null,
      confidence = if (digits != null && issuer != null) "SOURCE_EVIDENCE" else "SOURCE_SELECTION_REQUIRED",
      earnedForPeriod = if (kind == Kind.CASHBACK && has("last month")) "previous month" else null,
      statementDate = rx("statement\\s+dated\\s+(.+)").find(safe)?.groupValues?.get(1)
        ?.let { event(it,receivedAtMillis,zone) }?.takeIf { !it.second }?.first?.toLocalDate()?.toString())
  }

  private fun event(text: String, receipt: Long, zone: ZoneId): Pair<ZonedDateTime, Boolean>? {
    val dateRx = rx("\\b(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[-/][0-9]{1,2}[-/](?:[0-9]{4}|[0-9]{2})|[0-9]{1,2}[-/ ][A-Za-z]{3,9}[-/ ](?:[0-9]{4}|[0-9]{2})|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Za-z]{3} [0-9]{1,2} [0-9]{4})(?:(?: at)? [0-9]{1,2}:[0-9]{2}(?::[0-9]{1,2})?(?: [AP]M)?)?")
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
          return LocalDateTime.parse(raw, formatter).atZone(if (text.contains("IST")) ZoneId.of("Asia/Kolkata") else zone) to false
        } catch (_: DateTimeException) { }
      }
      return null // Explicit invalid dates must not silently become the receipt date.
    }
    return Instant.ofEpochMilli(receipt).atZone(zone) to true
  }
}
