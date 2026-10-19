package com.actionanand.cardnest.app.sms

import java.math.BigDecimal
import java.math.RoundingMode
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Pure and deterministic parser. Never decides to post to the financial ledger. */
object SmsTransactionParser {
  enum class Kind {
    PURCHASE, BANK_DEBIT, BANK_CREDIT, CARD_PAYMENT_RECEIVED, PAYMENT_INITIATED,
    CASHBACK, REFUND, PLUXEE_TOPUP, PLUXEE_PURCHASE, FASTAG_TOLL, FASTAG_TOPUP,
    LOAN_DEBIT, STATEMENT, PAYMENT_REMINDER, LOAN_REMINDER
  }

  data class Result(
    val kind: Kind,
    val amountMinor: Long?,
    val eventDate: String?,
    val merchant: String?,
    val cardDigits: String?,
    val accountDigits: String?,
    val issuer: String?,
    val reference: String?,
    val reportedBalanceMinor: Long?,
    val vehicleNumber: String?,
    val requiresReview: Boolean = true
  )

  private val money = Regex("""(?i)(?:₹|\\bINR\\b|\\bRs\\.?)(?:\\s*[:.]?\\s*)([0-9][0-9,]*(?:\\.[0-9]{1,2})?)""")
  private val amountBeforeVerb = Regex("""(?i)(?:₹|\\bINR\\b|\\bRs\\.?)[\\s:.]*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)[\\s]*(?:has\\s+been\\s+)?(?:spent|debited|refunded|credited|sent|paid)\\b""")
  private val cardContext = listOf(
    Regex("""(?i)(?:credit\\s+card|card\\s+no\\.?|card\\s+ending|card\\s+\\*+|your\\s+card|card\\s+xx|card\\s+x)[^\\n]{0,60}?(?:\\*+|x+|ending(?:\\s+with)?|no\\.?|\\s)([0-9]{4,5})\\b"""),
    Regex("""(?i)\\b(?:BOBCARD|AMEX|American\\s+Express)\\s+(?:\\*+|x+)([0-9]{4,5})\\b"""),
    Regex("""(?i)\\bcard\\s+(?:ending\\s+(?:with\\s+)?)?([0-9]{4,5})\\b""")
  )
  private val accountContext = Regex("""(?i)\\b(?:acct|acc|a/c|account)\\s*(?:no\\.?\\s*)?(?:x+|\\*+|[0-9]+x+)([0-9]{3,5})\\b""")
  private val referenceContext = Regex("""(?i)\\b(?:UPI\\s*(?:ref(?:erence)?\\s*(?:no\\.?)?)?|RRN|UTR|Ref(?:erence)?\\s*(?:No\\.?)?)\\s*[:#.]?\\s*([0-9]{9,15})\\b""")
  private val plate = Regex("""\\b[A-Z]{2}\\s?[0-9]{1,2}\\s?[A-Z]{1,3}\\s?[0-9]{4}\\b""")
  private val reportedBalance = Regex("""(?i)(?:current\\s+(?:meal\\s+wallet\\s+)?balance|(?:avl|available|wallet)\\s*bal(?:ance)?)[\\s:]*((?:₹|INR|Rs\\.?)\\s*[0-9][0-9,]*(?:\\.[0-9]{1,2})?)""")
  private val spendingMerchant = listOf(
    Regex("""(?i)\\b(?:spent|debited|charged)\\b[\\s\\S]{0,130}?\\bat\\s+(.+?)(?:\\s+on\\s+|\\s+via\\s+|\\s+through\\s+|\\s+avl\\b|\\s+not\\s+you|$)"""),
    Regex("""(?i)\\bat\\s+(.+?)(?:\\s+on\\s+|\\s+via\\s+|\\s+through\\s+|\\s+avl\\b|\\s+not\\s+you|$)"""),
    Regex("""(?i)\\bto\\s+(.+?)(?:\\s+on\\s+|\\s+\\(|\\s+UPI\\b|\\s+ref\\b|$)""")
  )
  private val dateFormats = listOf(
    "dd-MM-yyyy HH:mm:ss", "d-M-yyyy HH:mm:ss", "dd-MM-yyyy HH:mm:s",
    "dd-MM-yyyy HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm",
    "dd-MMM-yy", "d-MMM-yy", "dd/MM/yy", "d/M/yy", "dd/MM/yyyy",
    "dd-MM-yy", "d-MM-yy", "dd MMMM yyyy", "d MMMM yyyy",
    "EEE MMM dd yyyy HH:mm:ss", "EEE MMM d yyyy HH:mm:ss"
  )
  private val dateExpression = Regex("""(?i)\\b(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[-/][0-9]{1,2}[-/][0-9]{2,4}|[0-9]{1,2}[- ][A-Za-z]{3,9}[- ](?:[0-9]{2}|[0-9]{4})|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+[A-Za-z]{3}\\s+[0-9]{1,2}\\s+[0-9]{4})(?:\\s+[0-9]{1,2}:[0-9]{1,2}(?::[0-9]{1,2})?)?""")

  fun parse(body: String, receivedAtMillis: Long): Result? {
    if (body.length > 16_384 || body.isBlank()) return null
    val normalized = body.replace('\u00a0', ' ').replace(Regex("""[ \\t]+"""), " ").trim()
    val plain = normalized.replace('\n', ' ')
    val lower = plain.lowercase(Locale.ROOT)
    if (Regex("""(?i)\\b(?:otp|one.time.password|verification\\s+code|login\\s+code)\\b""").containsMatchIn(plain) &&
      !Regex("""(?i)\\b(?:debited|spent|credited|refund|cashback|payment\\s+received)\\b""").containsMatchIn(plain)) return null
    if (Regex("""(?i)\\b(?:offer|discount|cashback\\s+offer|reward\\s+points|not\\s+been\\s+used|has\\s+not\\s+been\\s+used|not\\s+been\\s+used\\s+for)\\b""").containsMatchIn(plain) &&
      !Regex("""(?i)\\b(?:spent|debited|credited|refunded|payment\\s+(?:of|received))\\b""").containsMatchIn(plain)) return null

    val pluxee = lower.contains("pluxee") || lower.contains("sodexo")
    val fastag = lower.contains("toll paid") || lower.contains("fastag") || lower.contains("toll plaza")
    val loan = lower.contains("loan") || lower.contains("emi") || lower.contains("ecs") ||
      lower.contains("merchantmandate") || lower.contains("autopay")
    val statement = (lower.contains("statement") && (lower.contains("generated") || lower.contains("total due") || lower.contains("minimum due"))) ||
      lower.contains("minimum amount due") || lower.contains("minimum due") || lower.contains("total amount due")
    val due = Regex("""(?i)\\b(?:emi|payment|amount|total|minimum)\\b.{0,90}\\b(?:is\\s+due|due\\s+on|due\\s+by|payable\\s+by)\\b""").containsMatchIn(plain)
    val topup = Regex("""(?i)\\b(?:credited|loaded|recharged|topped\\s*up)\\b""").containsMatchIn(plain) &&
      !lower.contains("refunded")
    val refund = Regex("""(?i)\\b(?:refunded|refund\\s+successful|refund\\s+of|reversal|reversed)\\b""").containsMatchIn(plain)
    val cashback = Regex("""(?i)\\bcashback\\b.{0,100}\\b(?:credited|received|deposited)\\b""").containsMatchIn(plain) ||
      Regex("""(?i)\\b(?:credited|received)\\b.{0,100}\\bcashback\\b""").containsMatchIn(plain)
    val cardPayment = Regex("""(?i)(?:payment\\s+(?:of\\s+.{0,40}?)?(?:has\\s+been\\s+)?received|payment\\s+(?:of\\s+.{0,50}?)?was\\s+credited|online\\s+payment.{0,100}credited)""").containsMatchIn(plain) &&
      (lower.contains("card") || lower.contains("bobcard"))
    val debit = Regex("""(?i)\\b(?:debited|spent|charged|sent|toll\\s+paid)\\b""").containsMatchIn(plain)
    val credit = Regex("""(?i)\\b(?:credited|received)\\b""").containsMatchIn(plain)
    val sourceCard = lower.contains("credit card") || lower.contains("amex") || lower.contains("bobcard") ||
      (lower.contains("card") && !pluxee && !fastag && !lower.contains("debit card"))
    val bank = Regex("""(?i)\\b(?:acct|account|a/c|savings)\\b""").containsMatchIn(plain)
    val amount = extractAmount(plain, cashback, statement)
    val kind = when {
      refund -> Kind.REFUND
      cashback -> Kind.CASHBACK
      pluxee && topup && !debit -> Kind.PLUXEE_TOPUP
      pluxee && debit -> Kind.PLUXEE_PURCHASE
      fastag && Regex("""(?i)\\b(?:toll\\s+paid|debited|spent)\\b""").containsMatchIn(plain) -> Kind.FASTAG_TOLL
      fastag && topup -> Kind.FASTAG_TOPUP
      cardPayment -> Kind.CARD_PAYMENT_RECEIVED
      statement -> Kind.STATEMENT
      loan && due && !debit && !credit -> Kind.LOAN_REMINDER
      due && !debit && !credit -> Kind.PAYMENT_REMINDER
      loan && debit && bank -> Kind.LOAN_DEBIT
      sourceCard && debit -> Kind.PURCHASE
      bank && debit && (lower.contains("cred") || lower.contains("cheq") || lower.contains("ccbp")) -> Kind.PAYMENT_INITIATED
      bank && debit -> Kind.BANK_DEBIT
      bank && credit -> Kind.BANK_CREDIT
      sourceCard && due -> Kind.PAYMENT_REMINDER
      else -> return null
    }
    // Pure reminders may legitimately include due amounts, but never become ledger entries.
    if (amount == null && kind !in setOf(Kind.STATEMENT, Kind.PAYMENT_REMINDER, Kind.LOAN_REMINDER)) return null
    val cardDigits = cardContext.firstNotNullOfOrNull { it.find(plain)?.groupValues?.getOrNull(1) }
    val accountDigits = accountContext.find(plain)?.groupValues?.getOrNull(1)
    val issuer = when {
      pluxee -> "Pluxee"
      lower.contains("axis") -> "Axis"
      lower.contains("icici") -> "ICICI"
      lower.contains("hdfc") -> "HDFC"
      lower.contains("pnb") -> "PNB"
      lower.contains("amex") || lower.contains("american express") -> "AMEX"
      lower.contains("stan") -> "Standard Chartered"
      lower.contains("federal") -> "Federal"
      lower.contains("bobcard") -> "BOBCARD"
      lower.contains("idfc") -> "IDFC FIRST"
      lower.contains("au bank") -> "AU Bank"
      lower.contains("slice") -> "Slice"
      else -> null
    }
    val merchant = when (kind) {
      Kind.PURCHASE, Kind.PLUXEE_PURCHASE, Kind.FASTAG_TOLL, Kind.BANK_DEBIT, Kind.PAYMENT_INITIATED ->
        spendingMerchant.firstNotNullOfOrNull { it.find(plain)?.groupValues?.getOrNull(1) }
          ?.trim()?.take(100)
      else -> null
    }
    return Result(kind, amount, extractEventDate(plain, receivedAtMillis), merchant, cardDigits,
      accountDigits, issuer, referenceContext.find(plain)?.groupValues?.getOrNull(1),
      reportedBalance.find(plain)?.groupValues?.getOrNull(1)?.let(::parseMinor),
      if (fastag) plate.find(plain.uppercase(Locale.ROOT))?.value?.replace(" ", "") else null)
  }

  private fun extractAmount(text: String, cashback: Boolean, statement: Boolean): Long? {
    if (statement) {
      val total = Regex("""(?i)(?:total\\s+(?:amt|amount|due)[\\s:.]*|total\\s+fresh\\s+pro\\s+credited.{0,5})(?:INR|Rs\\.?|₹)?\\s*(?:Dr\\.?\\s*)?([0-9][0-9,]*(?:\\.[0-9]{1,2})?)""")
        .find(text)?.groupValues?.getOrNull(1)
      if (total != null) return parseMinor(total)
    }
    if (cashback) {
      val match = Regex("""(?i)cashback\\s+(?:of\\s+)?(?:INR|Rs\\.?|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)""")
        .find(text)?.groupValues?.getOrNull(1)
      if (match != null) return parseMinor(match)
    }
    return amountBeforeVerb.find(text)?.groupValues?.getOrNull(1)?.let(::parseMinor)
      ?: money.find(text)?.groupValues?.getOrNull(1)?.let(::parseMinor)
  }

  private fun parseMinor(number: String): Long? = try {
    BigDecimal(number.replace(",", "")).multiply(BigDecimal(100))
      .setScale(0, RoundingMode.UNNECESSARY).longValueExact().takeIf { it > 0 }
  } catch (_: Exception) { null }

  private fun extractEventDate(text: String, receivedAtMillis: Long): String {
    val match = dateExpression.find(text)?.value
    if (match != null) {
      for (format in dateFormats) {
        try {
          val parser = SimpleDateFormat(format, Locale.ENGLISH).apply { isLenient = false }
          val parsed = parser.parse(match)
          if (parsed != null) return SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(parsed)
        } catch (_: Exception) { /* Try another format. */ }
      }
    }
    return SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(Date(receivedAtMillis))
  }
}
