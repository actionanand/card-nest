package com.actionanand.cardnest.app.sms

import org.junit.Assert.*
import org.junit.Test

class SmsPermissionFlowTest {
  private val denied = SmsPermissionFlow.Grant(false)
  private val granted = SmsPermissionFlow.Grant(true)
  private var access = SmsPermissionFlow.Access(denied, denied)
  private var past = SmsPermissionFlow.History()
  private val durable = mutableMapOf("cursorDate" to 42L, "cursorId" to 17L, "pages" to 4L,
    "staged" to 3L, "approved" to 2L, "rejected" to 1L)
  private var activations = 0
  private fun flow() = SmsPermissionFlow({ access }, { past }, { ok ->
    past = SmsPermissionFlow.History(past.wasGranted || ok, !ok)
  }, { activations++ })
  private val bounds = SmsPermissionFlow.Bounds(0,200)
  @Test fun firstRequestDoesNotWriteProgressOrHistory() {
    val f=flow(); val before=durable.toMap()
    assertEquals("not requested",f.status().permission)
    assertEquals(SmsPermissionFlow.Start.REQUEST,f.begin(bounds))
    assertEquals("requesting",f.status().permission)
    assertEquals(before,durable); assertFalse(past.deniedCallback); assertEquals(0,activations)
  }
  @Test fun bothPermissionsMustBeIndependentlyGranted() {
    val f=flow(); f.begin(bounds); access=SmsPermissionFlow.Access(granted,granted); f.complete()
    assertEquals("granted",f.status().permission); assertEquals(1,activations); assertTrue(past.wasGranted)
  }
  @Test fun partialReadGrantCannotEnable() {
    val f=flow(); f.begin(bounds); access=SmsPermissionFlow.Access(granted,denied.copy(rationale=true)); f.complete()
    assertEquals("denied",f.status().permission); assertEquals(0,activations)
  }
  @Test fun partialReceiveGrantCannotEnable() {
    val f=flow(); f.begin(bounds); access=SmsPermissionFlow.Access(denied.copy(rationale=true),granted); f.complete()
    assertEquals(0,activations); assertFalse(f.status().readGranted)
  }
  @Test fun explicitDenialRetainsEveryDurableRecord() {
    val f=flow(); val before=durable.toMap(); f.begin(bounds)
    access=SmsPermissionFlow.Access(denied.copy(rationale=true),denied.copy(rationale=true)); f.complete()
    assertEquals("denied",f.status().permission); assertTrue(f.status().canRequest)
    assertEquals(before,durable); assertEquals(0,activations)
  }
  @Test fun noDialogCallbackRecommendsSettingsWithoutClaimingUserDenial() {
    val f=flow(); f.begin(bounds); f.complete()
    assertEquals("unavailable",f.status().permission); assertTrue(f.status().settingsRecommended)
    assertTrue(f.status().canRequest); assertEquals(0,activations)
  }
  @Test fun policyAndMissingManifestAreUnavailableWithoutRequesting() {
    for (missing in listOf(denied.copy(policyBlocked=true),denied.copy(declared=false))) {
      access=SmsPermissionFlow.Access(missing,denied); val f=flow()
      assertEquals(SmsPermissionFlow.Start.UNAVAILABLE,f.begin(bounds)); assertEquals(0,activations)
    }
  }
  @Test fun unsupportedDeviceDoesNotCreatePendingWork() {
    access=SmsPermissionFlow.Access(denied,denied,false); val f=flow()
    assertEquals(SmsPermissionFlow.Start.UNAVAILABLE,f.begin(bounds)); assertFalse(f.requesting)
  }
  @Test fun revocationAfterGrantIsObservedAfterRestart() {
    past=SmsPermissionFlow.History(true,false)
    assertEquals("revoked",flow().status().permission); assertEquals(0,activations)
  }
  @Test fun settingsGrantOverridesPreviousDenialAndNeedsExplicitEnable() {
    past=SmsPermissionFlow.History(false,true); access=SmsPermissionFlow.Access(granted,granted)
    val f=flow(); assertEquals("granted",f.status().permission); assertEquals(0,activations)
    assertEquals(SmsPermissionFlow.Start.COMPLETE,f.begin(bounds)); assertEquals(1,activations)
  }
  @Test fun repeatedEnableTapsCannotReplaceOriginalRequest() {
    val f=flow(); f.begin(bounds)
    try { f.begin(SmsPermissionFlow.Bounds(1,100)); fail("Expected in-flight guard") } catch (_: IllegalStateException) {}
    access=SmsPermissionFlow.Access(granted,granted); f.complete(); f.complete(); assertEquals(1,activations)
  }
  @Test fun failedRequestAndLateCallbackNeverActivate() {
    val f=flow(); val before=durable.toMap(); f.begin(bounds); f.failed()
    access=SmsPermissionFlow.Access(granted,granted); f.complete()
    assertEquals(0,activations); assertEquals(before,durable)
  }
}
