package com.actionanand.cardnest.app.sms

import org.junit.Assert.*
import org.junit.Test

class SmsTransactionParserTest {
  // Fixed, artificial clock for deterministic tests; all account identifiers below are synthetic.
  private val received = 1792454400000L

  private fun parse(text: String) = requireNotNull(SmsTransactionParser.parse(text, received))

  @Test fun pluxeeTopupIsDynamicAndBalanceIsEvidence() {
    val a = parse("Your Pluxee Card has been successfully credited with Rs.7350 towards Meal Wallet on Fri Sep 25 2026 04:29:15. Your current Meal Wallet balance is Rs.7360.84.")
    assertEquals(SmsTransactionParser.Kind.PLUXEE_TOPUP, a.kind)
    assertEquals(735000L, a.amountMinor)
    assertEquals(736084L, a.reportedBalanceMinor)
    assertEquals("2026-09-25", a.eventDate)
    assertEquals(null, a.cardDigits)
    assertTrue(a.requiresReview)
  }

  @Test fun pluxeeTopupSeparatesEventAmountFromTheReportedPostEventBalance() {
    val a = parse("Your Pluxee Card has been successfully credited with Rs.8800 towards Meal Wallet on Fri Oct 23 2026 05:17:27. Your current Meal Wallet balance is Rs.9737.24.")
    assertEquals(SmsTransactionParser.Kind.PLUXEE_TOPUP, a.kind)
    assertEquals(880000L, a.amountMinor)
    assertEquals(973724L, a.reportedBalanceMinor)
    assertEquals("2026-10-23", a.eventDate)
    assertEquals("05:17:27", a.eventTime)
    assertEquals("2026-10-22T23:47:27Z", a.eventAt)
    assertEquals("AFTER", a.balancePosition)
    assertEquals("Pluxee", a.issuer)
    assertEquals(null, SmsTransactionParser.parse("Your Pluxee Meal Wallet balance is Rs.9737.24.", received))
  }

  @Test fun pluxeeTopupSynonymsStayDistinctFromPurchases() {
    for (verb in listOf("credited", "received", "loaded", "recharged", "topped up")) {
      val topup = parse("Sodexo Meal Wallet $verb Rs.120.00 on 23-Oct-2026 05:17. Current balance is Rs.500.00")
      assertEquals(SmsTransactionParser.Kind.PLUXEE_TOPUP, topup.kind)
      assertEquals(12000L, topup.amountMinor)
      assertEquals(50000L, topup.reportedBalanceMinor)
      assertEquals("AFTER", topup.balancePosition)
    }
    for (verb in listOf("spent", "debited")) for (balance in listOf("Avl bal", "Available balance", "current Meal Wallet balance is")) {
      val purchase = parse("Pluxee Meal Wallet $verb Rs.25.00 on 23-Oct-2026 05:18. $balance Rs.475.00")
      assertEquals(SmsTransactionParser.Kind.PLUXEE_PURCHASE, purchase.kind)
      assertEquals(2500L, purchase.amountMinor)
      assertEquals(47500L, purchase.reportedBalanceMinor)
    }
    assertNull(SmsTransactionParser.parse("Sodexo current balance is Rs.500.00", received))
    assertNull(SmsTransactionParser.parse("Pluxee loaded Rs.120 and Rs.130. Available balance Rs.500", received))
  }

  @Test fun pluxeePurchaseHasAmountNotAvailableBalance() {
    val a = parse("Rs. 586.89 spent from Pluxee Meal wallet, card no.xx1111 on 7-10-2026 22:52:3 at FICTIONAL MARKET. Avl bal Rs.4929.44.")
    assertEquals(SmsTransactionParser.Kind.PLUXEE_PURCHASE, a.kind)
    assertEquals(58689L, a.amountMinor)
    assertEquals(492944L, a.reportedBalanceMinor)
    assertEquals("1111", a.cardDigits)
    assertEquals("2026-10-07", a.eventDate)
  }

  @Test fun confirmedCardPaymentNeverBecomesCardPurchase() {
    val a = parse("Payment of Rs 4350 has been received on your ICICI Bank Credit Card XX2222 through Bharat Bill Payment System on 17-OCT-26.")
    assertEquals(SmsTransactionParser.Kind.CARD_PAYMENT_RECEIVED, a.kind)
    assertEquals(435000L, a.amountMinor)
    assertEquals("2222", a.cardDigits)
  }

  @Test fun bankDebitViaCheqIsNotConfirmedCardReceipt() {
    val a = parse("ICICI Bank Acct XX987 debited for Rs 4246.20 on 20-Sep-26; CheQ credited. UPI:123456783333.")
    assertEquals(SmsTransactionParser.Kind.PAYMENT_INITIATED, a.kind)
    assertEquals(424620L, a.amountMinor)
    assertEquals("987", a.accountDigits)
    assertEquals("123456783333", a.reference)
  }

  @Test fun yesBankAndIndusIndIssuersAreRecognized() {
    val yes = parse("Yes Bank Acct XX987 debited for Rs 100 on 20-Sep-26")
    assertEquals("Yes Bank", yes.issuer)
    assertEquals("987", yes.accountDigits)
    val indus = parse("IndusInd Bank Account XX007 credited with Rs 100 on 20-Sep-26")
    assertEquals("IndusInd Bank", indus.issuer)
    assertEquals("007", indus.accountDigits)
  }

  @Test fun rupayCreditCardMerchantPaymentIsCardPurchase() {
    val a = parse("PNB Credit Card 3333 debited with Rs.471.82 [CODE:WZ9999] at DEMO TELECOM on 18-10-2026 00:09 through UPI: 234567890123 Avl limit Rs. 42886.")
    assertEquals(SmsTransactionParser.Kind.PURCHASE, a.kind)
    assertEquals("3333", a.cardDigits)
    assertEquals(47182L, a.amountMinor)
    assertEquals("234567890123", a.reference)
  }

  @Test fun amexFiveDigitsAreExtracted() {
    val a = parse("Alert: You've spent INR 1,359.70 on your AMEX card ** 51234 at DEMO INSURANCE on 17 October 2026 at 02:20 PM IST.")
    assertEquals(SmsTransactionParser.Kind.PURCHASE, a.kind)
    assertEquals("51234", a.cardDigits)
    assertEquals("2026-10-17", a.eventDate)
    assertEquals(135970L, a.amountMinor)
  }

  @Test fun cashbackIsActualCardCreditNotOffer() {
    val a = parse("Congratulations! Cashback of INR 117 has been credited to your Axis Bank Ace Credit Card XX4444 towards your last month spends - Axis Bank")
    assertEquals(SmsTransactionParser.Kind.CASHBACK, a.kind)
    assertEquals(11700L, a.amountMinor)
    assertEquals("4444", a.cardDigits)
    assertNull(SmsTransactionParser.parse("You can earn cashback offer up to Rs.500 on your next purchase.", received))
  }

  @Test fun refundsKeepAmountAndCard() {
    val a = parse("Refund Successful!Rs 1955.00 from DEMO MERCHANT is credited to HDFC Bank Pixel Play credit card xx5555 on 07/08/26 12:08.")
    assertEquals(SmsTransactionParser.Kind.REFUND, a.kind)
    assertEquals(195500L, a.amountMinor)
    assertEquals("5555", a.cardDigits)
    assertEquals("2026-08-07", a.eventDate)
  }

  @Test fun fastagTollIsNotWalletBalance() {
    val a = parse("Toll Paid! Rs.76.0 for KA01AB1234 At Sample Plaza On 2026-08-07 13:57:10 Wallet Bal: Rs.830.00 HDFC Bank")
    assertEquals(SmsTransactionParser.Kind.FASTAG_TOLL, a.kind)
    assertEquals(7600L, a.amountMinor)
    assertEquals(83000L, a.reportedBalanceMinor)
    assertEquals("KA01AB1234", a.vehicleNumber)
  }

  @Test fun statementsNeverBecomePurchases() {
    val a = parse("Your statement for Axis Bank Credit Card no. XX6666 is generated. Due on: 01-08-26 Total amt: INR Dr. 1623.28 Min amt due: INR Dr. 100.00")
    assertEquals(SmsTransactionParser.Kind.STATEMENT, a.kind)
    assertEquals(162328L, a.amountMinor)
  }

  @Test fun loanRemindersAndRealDebitsDiffer() {
    val reminder = parse("EMI of Rs 17266 for ICICI Bank Personal Loan XX7777 is due on 10-Aug-26. Maintain funds.")
    val payment = parse("ICICI Bank Acc XX987 debited Rs. 17,380.00 on 10-Aug-26 InfoBIL*Auto Loan.Avl Bal Rs. 19,357.07.")
    assertEquals(SmsTransactionParser.Kind.LOAN_REMINDER, reminder.kind)
    assertEquals(SmsTransactionParser.Kind.LOAN_DEBIT, payment.kind)
    assertEquals(1738000L, payment.amountMinor)
  }

  @Test fun ecsDebitRequiresLoanReview() {
    val a = parse("Your account 123xxxx9999 has been debited on 05/10/2026 by INR 37,733.25 towards ECS.Available Balance:INR 2,139.19 -StanChart")
    assertEquals(SmsTransactionParser.Kind.LOAN_DEBIT, a.kind)
    assertEquals(3773325L, a.amountMinor)
    assertTrue(a.requiresReview)
  }

  @Test fun maskedAndCompleteBankIdentifiersKeepOnlyMaskedHintAndFinalThreeDigits() {
    val examples = listOf(
      "A/c 432xxxxx765 debited INR 100 on 20-Sep-26" to ("765" to "432•••••765"),
      "A/c 1xxxx7650 debited INR 100 on 20-Sep-26" to ("650" to "1•••••650"),
      "A/c xxxx980 debited INR 100 on 20-Sep-26" to ("980" to "••••980"),
      "A/c xxx007 debited INR 100 on 20-Sep-26" to ("007" to "•••007"),
      "A/c 432123456700 debited INR 100 on 20-Sep-26" to ("700" to "432••••••700"),
    )
    for ((message, expected) in examples) {
      val result = parse(message)
      assertEquals(expected.first, result.accountDigits)
      assertEquals(expected.second, result.accountMask)
      assertFalse(result.accountMask!!.contains(Regex("[0-9]{6,}")))
    }
  }

  @Test fun ignoresOtpAndNonFinancialInactivityAlerts() {
    assertNull(SmsTransactionParser.parse("Your OTP is 4821 for login. Do not share.", received))
    assertNull(SmsTransactionParser.parse("Your credit card ending 8888 has not been used for over 3 months.", received))
  }

  @Test fun rejectsInvalidMoneyAndHugeAmountsSafely() {
    assertNull(SmsTransactionParser.parse("Spent Rs.999999999999999999999999 on Card XX1234", received))
    assertNull(SmsTransactionParser.parse("", received))
  }
}
