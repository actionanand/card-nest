package com.actionanand.cardnest.app.sms

import org.junit.Assert.*
import org.junit.Test

class SmsTransactionParserTest {
  private val received = 1792454400000L

  private fun parse(text: String) = requireNotNull(SmsTransactionParser.parse(text, received))

  @Test fun pluxeeTopupIsDynamicAndBalanceIsEvidence() {
    val a = parse("Your Pluxee Card has been successfully credited with Rs.7300 towards Meal Wallet on Fri Sep 25 2026 04:29:15. Your current Meal Wallet balance is Rs.7310.84.")
    assertEquals(SmsTransactionParser.Kind.PLUXEE_TOPUP, a.kind)
    assertEquals(730000L, a.amountMinor)
    assertEquals(731084L, a.reportedBalanceMinor)
    assertEquals("2026-09-25", a.eventDate)
    assertEquals(null, a.cardDigits)
    assertTrue(a.requiresReview)
  }

  @Test fun pluxeePurchaseHasAmountNotAvailableBalance() {
    val a = parse("Rs. 586.88 spent from Pluxee Meal wallet, card no.xx6423 on 7-10-2026 22:52:3 at BIG BASKET. Avl bal Rs.4829.44.")
    assertEquals(SmsTransactionParser.Kind.PLUXEE_PURCHASE, a.kind)
    assertEquals(58688L, a.amountMinor)
    assertEquals(482944L, a.reportedBalanceMinor)
    assertEquals("6423", a.cardDigits)
    assertEquals("2026-10-07", a.eventDate)
  }

  @Test fun confirmedCardPaymentNeverBecomesCardPurchase() {
    val a = parse("Payment of Rs 4300 has been received on your ICICI Bank Credit Card XX8000 through Bharat Bill Payment System on 17-OCT-26.")
    assertEquals(SmsTransactionParser.Kind.CARD_PAYMENT_RECEIVED, a.kind)
    assertEquals(430000L, a.amountMinor)
    assertEquals("8000", a.cardDigits)
  }

  @Test fun bankDebitViaCheqIsNotConfirmedCardReceipt() {
    val a = parse("ICICI Bank Acct XX053 debited for Rs 4245.20 on 20-Sep-26; CheQ credited. UPI:130605807423.")
    assertEquals(SmsTransactionParser.Kind.PAYMENT_INITIATED, a.kind)
    assertEquals(424520L, a.amountMinor)
    assertEquals("053", a.accountDigits)
    assertEquals("130605807423", a.reference)
  }

  @Test fun rupayCreditCardMerchantPaymentIsCardPurchase() {
    val a = parse("PNB Credit Card 9012 debited with Rs.470.82 [CODE:WL7386] at JIO Postpaid on 18-10-2026 00:09 through UPI: 665773378714 Avl limit Rs. 42786.")
    assertEquals(SmsTransactionParser.Kind.PURCHASE, a.kind)
    assertEquals("9012", a.cardDigits)
    assertEquals(47082L, a.amountMinor)
    assertEquals("665773378714", a.reference)
  }

  @Test fun amexFiveDigitsAreExtracted() {
    val a = parse("Alert: You've spent INR 1,352.70 on your AMEX card ** 21003 at POLICY BAZAA on 17 October 2026 at 02:20 PM IST.")
    assertEquals(SmsTransactionParser.Kind.PURCHASE, a.kind)
    assertEquals("21003", a.cardDigits)
    assertEquals("2026-10-17", a.eventDate)
    assertEquals(135270L, a.amountMinor)
  }

  @Test fun cashbackIsActualCardCreditNotOffer() {
    val a = parse("Congratulations! Cashback of INR 113 has been credited to your Axis Bank Ace Credit Card XX0957 towards your last month spends - Axis Bank")
    assertEquals(SmsTransactionParser.Kind.CASHBACK, a.kind)
    assertEquals(11300L, a.amountMinor)
    assertEquals("0957", a.cardDigits)
    assertNull(SmsTransactionParser.parse("You can earn cashback offer up to Rs.500 on your next purchase.", received))
  }

  @Test fun refundsKeepAmountAndCard() {
    val a = parse("Refund Successful!Rs 1950.00 from GOOGLEPLAY is credited to HDFC Bank Pixel Play credit card xx4007 on 07/08/26 12:08.")
    assertEquals(SmsTransactionParser.Kind.REFUND, a.kind)
    assertEquals(195000L, a.amountMinor)
    assertEquals("4007", a.cardDigits)
    assertEquals("2026-08-07", a.eventDate)
  }

  @Test fun fastagTollIsNotWalletBalance() {
    val a = parse("Toll Paid! Rs.75.0 for KA01AB1234 At Fictional Plaza On 2026-08-07 13:57:10 Wallet Bal: Rs.820.00 HDFC Bank")
    assertEquals(SmsTransactionParser.Kind.FASTAG_TOLL, a.kind)
    assertEquals(7500L, a.amountMinor)
    assertEquals(82000L, a.reportedBalanceMinor)
    assertEquals("KA01AB1234", a.vehicleNumber)
  }

  @Test fun statementsNeverBecomePurchases() {
    val a = parse("Your statement for Axis Bank Credit Card no. XX1868 is generated. Due on: 01-08-26 Total amt: INR Dr. 1622.28 Min amt due: INR Dr. 100.00")
    assertEquals(SmsTransactionParser.Kind.STATEMENT, a.kind)
    assertEquals(162228L, a.amountMinor)
  }

  @Test fun loanRemindersAndRealDebitsDiffer() {
    val reminder = parse("EMI of Rs 17256 for ICICI Bank Personal Loan XX9105 is due on 10-Aug-26. Maintain funds.")
    val payment = parse("ICICI Bank Acc XX053 debited Rs. 17,370.00 on 10-Aug-26 InfoBIL*Auto Loan.Avl Bal Rs. 19,357.07.")
    assertEquals(SmsTransactionParser.Kind.LOAN_REMINDER, reminder.kind)
    assertEquals(SmsTransactionParser.Kind.LOAN_DEBIT, payment.kind)
    assertEquals(1737000L, payment.amountMinor)
  }

  @Test fun ecsDebitRequiresLoanReview() {
    val a = parse("Your account 456xxxx8539 has been debited on 05/10/2026 by INR 37,733.00 towards ECS.Available Balance:INR 2,139.18 -StanChart")
    assertEquals(SmsTransactionParser.Kind.LOAN_DEBIT, a.kind)
    assertEquals(3773300L, a.amountMinor)
    assertTrue(a.requiresReview)
  }

  @Test fun ignoresOtpAndNonFinancialInactivityAlerts() {
    assertNull(SmsTransactionParser.parse("Your OTP is 4821 for login. Do not share.", received))
    assertNull(SmsTransactionParser.parse("Your credit card ending 3836 has not been used for over 3 months.", received))
  }

  @Test fun rejectsInvalidMoneyAndHugeAmountsSafely() {
    assertNull(SmsTransactionParser.parse("Spent Rs.999999999999999999999999 on Card XX1234", received))
    assertNull(SmsTransactionParser.parse("", received))
  }
}
