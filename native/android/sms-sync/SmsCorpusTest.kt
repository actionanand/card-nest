package com.actionanand.cardnest.app.sms

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import java.io.File
import java.time.Instant

/** Every supplied fixture is executed independently; amounts/dates/suffixes are reviewable oracles. */
@RunWith(Parameterized::class)
class SmsCorpusTest(private val fixture: JSONObject, private val oracle: String) {
  @Test fun suppliedCase() {
    val fields = oracle.split('|')
    val expected = fixture.getString("expectedKind")
    val parsed = SmsTransactionParser.parse(fixture.getString("sms"), Instant.parse("2026-10-19T12:00:00Z").toEpochMilli())
    if (expected.startsWith("IGNORE")) { assertNull(parsed); return }
    val result = requireNotNull(parsed) { fixture.getString("id") }
    val kind = when (expected) {
      "CARD_PURCHASE" -> "PURCHASE"
      "CASHBACK_CREDIT" -> "CASHBACK"
      "REFUND_CREDIT" -> "REFUND"
      "STATEMENT_REMINDER" -> "PAYMENT_REMINDER"
      "STATEMENT_GENERATED" -> "STATEMENT"
      "BANK_DEBIT_INFORMATION", "BANK_DEBIT_REVIEW" -> "BANK_DEBIT"
      "BANK_CREDIT_INFORMATION" -> "BANK_CREDIT"
      "BANK_TRANSFER_INFORMATION" -> "BANK_TRANSFER"
      "ECS_DEBIT_REVIEW" -> "LOAN_DEBIT"
      else -> expected
    }
    assertEquals(kind, result.kind.name)
    assertEquals(fields[0].toLong(), result.amountMinor)
    if (kind in setOf("STATEMENT", "PAYMENT_REMINDER", "LOAN_REMINDER") && result.statementDate == null) {
      // Legacy date oracles above described the deadline. It is separate evidence, not a purchase date.
      assertEquals(fields[1], result.dueDate ?: "2026-10-19") // Relative/absent deadlines are not invented.
      assertEquals("2026-10-19", result.eventDate)
      assertTrue(result.dateFallback)
    } else assertEquals(fields[1], result.eventDate)
    assertEquals(fields[2].ifEmpty { null }, result.cardDigits)
    if (fields.size > 3 && fields[3].isNotEmpty()) assertEquals(fields[3].toLong(), result.reportedBalanceMinor)
    assertEquals("INR", result.currency)
    assertTrue(result.requiresReview)
    assertEquals(64, result.fingerprint.length)
    assertEquals(Instant.parse("2026-10-19T12:00:00Z").toEpochMilli(), result.receivedAt)
    references[fixture.getString("id")]?.let { assertEquals(it,result.reference) }
    merchants[fixture.getString("id")]?.let { assertEquals(it,result.merchant) }
    accounts[fixture.getString("id")]?.let { assertEquals(it,result.accountDigits) }
    if (fixture.getString("id") in setOf("BASE-14","BASE-15","BASE-30","BASE-31","BASE-32","BASE-33")) {
      assertEquals("AMEX",result.issuer); assertEquals("AMERICAN_EXPRESS",result.cardNetwork)
    }
    if (fixture.getString("id") in setOf("BASE-27","BASE-28","EXTRA-13")) assertEquals("KA01AB1234",result.vehicleNumber)
    if (fixture.getString("id") == "EXTRA-14") assertEquals("KA02CD5678",result.vehicleNumber)
    if (fixture.getString("id") == "BASE-13") {
      assertEquals("2026-10-20",result.dueDate); assertEquals(21700L,result.minimumDueMinor)
      assertEquals("2026-10-01",result.statementDate)
    }
    if (fixture.getString("id") == "BASE-25") assertNull(result.statementDate)
  }
  companion object {
    private val accounts = mapOf("BASE-04" to "444","BASE-05" to "444","BASE-06" to "444","BASE-07" to "444","BASE-08" to "444",
      "BASE-35" to "4040","BASE-36" to "4040","BASE-37" to "6060","BASE-41" to "444","BASE-56" to "1516",
      "EXTRA-05" to "444","EXTRA-06" to "444","EXTRA-07" to "4040")
    private val references = mapOf("BASE-04" to "910667248461","BASE-05" to "926571136735","BASE-06" to "911121549053","BASE-07" to "953963767557",
      "BASE-08" to "994098391434","BASE-09" to "960864318957","BASE-10" to "928994255740","BASE-11" to "935212789417","BASE-12" to "988317120750",
      "BASE-17" to "SYNTHREF123456","BASE-18" to "915349566827","BASE-26" to "987089660905","BASE-29" to "981536729229","BASE-35" to "972429848961",
      "BASE-37" to "926571136735","BASE-38" to "954527936440","BASE-39" to "968342021109","BASE-40" to "945873329926","BASE-48" to "937878628349",
      "BASE-51" to "966158478185","BASE-56" to "910623164981","EXTRA-08" to "941069222863")
    private val merchants = mapOf("BASE-01" to "DEMO CAFE","BASE-02" to "DEMO GROCERY ONE","BASE-03" to "DEMO GROCERY TWO",
      "BASE-09" to "DEMO TELECOM","BASE-10" to "DEMO PHARMACY","BASE-11" to "DEMO MERCHANT A","BASE-12" to "DEMO MERCHANT B",
      "BASE-14" to "DEMO INSURANCE","BASE-15" to "DEMO INSURANCE","BASE-18" to "merchant.one@sampleupi","BASE-20" to "DEMO SHOP A",
      "BASE-21" to "DEMO SHOP B","BASE-22" to "DEMO ONLINE SHOP","BASE-24" to "DEMO FUEL STATION","BASE-26" to "merchant.two@sampleupi",
      "BASE-27" to "DEMO PLAZA A","BASE-28" to "DEMO PLAZA B","BASE-29" to "merchant.three@sampleupi","BASE-30" to "DEMO CLINIC",
      "BASE-31" to "DEMO INSURANCE","BASE-32" to "DEMO SUBSCRIPTION","BASE-34" to "DEMO FUEL STATION","BASE-38" to "DEMO EATERY",
      "BASE-39" to "DEMO MERCHANT C","BASE-40" to "DEMO MERCHANT B","BASE-44" to "DEMO ECOMMERCE","BASE-48" to "DEMO PETROL",
      "BASE-50" to "DEMO ONLINE RETAILER","BASE-51" to "merchant.four@sampleupi","BASE-53" to "DEMO DINING","BASE-54" to "DEMO MEDIA",
      "BASE-55" to "910106351458 DEMO STORE","EXTRA-04" to "DEMO MEDIA","EXTRA-14" to "DEMO PLAZA C")
    @JvmStatic @Parameterized.Parameters(name = "{index}: {0}") fun cases(): Collection<Array<Any>> {
      val stream = SmsCorpusTest::class.java.getResourceAsStream("/sms-corpus.json")
      val text = stream?.bufferedReader()?.use { it.readText() }
        ?: File("codex-spec/CardNest_SMS_Synthetic_Test_Corpus.json").readText()
      val fixtures = JSONObject(text).getJSONArray("fixtures")
      val expected = listOf(
        "116500|2026-10-18||220024", "110200|2026-10-07|2147|335424", "60388|2026-10-07|2147|484644",
        "23400|2026-10-18|", "771700|2026-10-12|", "130700|2026-10-07|", "426220|2026-09-20|", "1900|2026-08-11|",
        "48782|2026-10-18|3141", "43000|2026-10-10|3141", "3700|2026-10-17|3141", "4200|2026-10-11|3141",
        "210611|2026-10-01|4152", "136970|2026-10-17|52137", "136970|2026-07-17|2137", "40100|2026-10-17|6161",
        "69300|2026-10-02|7171", "46500|2026-10-01|", "13000|2026-10-19|9191", "4600|2026-10-08|9191",
        "20700|2026-10-02|9191", "1451700|2026-09-29|9191", "163928|2026-08-01|2020", "99575|2026-07-27|2020",
        "163928|2026-08-01|2020", "2700|2026-08-26|", "9200|2026-08-07||83700", "12200|2026-08-07||91200",
        "241900|2026-08-05|", "29200|2026-10-13|52137", "136970|2026-09-17|52137", "201600|2026-09-15|52137",
        "396891|2026-07-12|52137", "34967|2026-10-13|3030", "3801700|2026-10-04|", "3775000|2026-10-05||215618",
        "771700|2026-10-12|", "7700|2026-09-03|7070", "16700|2026-07-11|7070", "9200|2026-07-12|7070",
        "1727300|2026-10-10||1485237", "331536|2026-08-30|6161", "162340|2026-09-07|9090", "21600|2026-10-03|6161",
        "1727300|2026-08-10|", "40973|2026-10-05|", "510300|2026-10-19|", "21700|2026-10-02|7070", "",
        "1221700|2026-09-27|1213", "30100|2026-07-21|", "427320|2026-09-20|4152", "144800|2026-09-11|9090",
        "196700|2026-08-07|1314", "8700|2026-08-02|1415", "91900|2026-07-31|",
        "624000|2026-09-25||625025", "910000|2026-07-24||911084", "1900|2026-09-11|2323", "196700|2026-08-07|1314",
        "1739700|2026-08-10||1937407", "1727700|2026-10-10||1485237", "3775000|2026-10-05||215618", "510300|2026-10-07|", "", "",
        "14200|2026-10-19|9191", "433400|2026-10-19|6161", "66700|2026-10-19||83400", "9200|2026-08-07||43700"
      )
      require(fixtures.length() == 70 && expected.size == 70)
      return (0 until fixtures.length()).map { arrayOf(fixtures.getJSONObject(it), expected[it]) }
    }
  }
}
