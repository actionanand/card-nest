package com.actionanand.cardnest.app.sms

import android.Manifest
import android.app.job.JobScheduler
import android.content.Context
import com.getcapacitor.*
import com.getcapacitor.annotation.*
import org.json.JSONArray

@CapacitorPlugin(name = "CardNestSms", permissions = [Permission(alias = "sms", strings = [Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS])])
class CardNestSmsPlugin : Plugin() {
  @PluginMethod fun status(call: PluginCall) {
    val prefs = SmsDiscovery.settings(context)
    call.resolve(JSObject().apply {
      put("permission", if (SmsDiscovery.permitted(context)) "granted" else if (prefs.getBoolean("wasGranted",false)) "revoked/unavailable" else if (prefs.getBoolean("requested", false)) "denied" else "not requested")
      put("enabled", prefs.getBoolean("enabled", false)); put("cursorDate", prefs.getLong("cursorDate", 0))
      put("cursorId", prefs.getLong("cursorId", -1)); put("completedAt", prefs.getLong("completedAt", 0))
      put("pages", prefs.getInt("pages", 0)); put("scanned", prefs.getInt("scanned", 0)); put("found", prefs.getInt("found", 0))
      put("more", prefs.getBoolean("more", false)); put("error", prefs.getString("error", ""))
    })
  }
  @PluginMethod fun enable(call: PluginCall) {
    val batch = call.getInt("batch", 200) ?: 200
    val since = call.getLong("since", System.currentTimeMillis() - 30L * 86400000) ?: 0L
    if (batch !in 1..500 || since < 0 || since > System.currentTimeMillis()) { call.reject("Invalid scan bounds"); return }
    val prefs = SmsDiscovery.settings(context)
    prefs.edit().putInt("batch", batch).putLong("since", since).putLong("cursorDate",since).putLong("cursorId",-1)
      .putBoolean("more",true).putBoolean("requested", true).putBoolean("cancelled", false).commit()
    if (SmsDiscovery.permitted(context)) permissionsReady(call) else requestPermissionForAlias("sms", call, "permissionsReady")
  }
  @PermissionCallback private fun permissionsReady(call: PluginCall) {
    val granted = SmsDiscovery.permitted(context)
    SmsDiscovery.settings(context).edit().putBoolean("enabled", granted).commit()
    if (granted) SmsDiscovery.settings(context).edit().putBoolean("wasGranted",true).commit()
    status(call)
  }
  @PluginMethod fun disable(call: PluginCall) {
    SmsDiscovery.settings(context).edit().putBoolean("enabled", false).putBoolean("cancelled", true).commit()
    (context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).cancel(SmsDiscovery.JOB_ID)
    status(call)
  }
  @PluginMethod fun cancel(call: PluginCall) {
    SmsDiscovery.settings(context).edit().putBoolean("cancelled", true).commit()
    (context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).cancel(SmsDiscovery.JOB_ID)
    status(call)
  }
  @PluginMethod fun scanPage(call: PluginCall) {
    execute {
      try { SmsDiscovery.page(context); status(call) }
      catch (_: Exception) { call.reject("Scan unavailable. Check permission, storage and queue capacity; retry.") }
    }
  }
  @PluginMethod fun beginScan(call: PluginCall) { SmsDiscovery.begin(context); call.resolve() }
  @PluginMethod fun catchUp(call: PluginCall) { SmsDiscovery.schedule(context); call.resolve() }
  @PluginMethod fun pending(call: PluginCall) { execute {
    try { SmsQueue(context).use { call.resolve(JSObject().put("items", JSONArray(it.pending(200)))) } }
    catch (_: Exception) { call.reject("Private queue unavailable; no queued items were discarded") }
  } }
  @PluginMethod fun acknowledge(call: PluginCall) { execute {
    try {
      val ids = call.getArray("ids") ?: JSArray()
      require(ids.length() <= 200)
      SmsQueue(context).use { q -> q.ack((0 until ids.length()).map { ids.getString(it) }) }
      call.resolve()
    } catch (_: Exception) { call.reject("Queue acknowledgement failed; retry is safe") }
  } }
  @PluginMethod fun parseText(call: PluginCall) {
    val body = call.getString("text") ?: ""
    val result = SmsTransactionParser.parse(body, System.currentTimeMillis())
    call.resolve(JSObject().put("item", result?.let { SmsQueue.json(it, "paste") }))
  }
  @PluginMethod fun clear(call: PluginCall) {
    SmsDiscovery.clear(context)
    call.resolve()
  }
  @PluginMethod fun prune(call: PluginCall) {
    val cutoff = call.getString("cutoff") ?: ""
    if (!Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(cutoff)) { call.reject("Invalid retention date"); return }
    execute { try { SmsDiscovery.prune(context,cutoff); call.resolve() } catch (_: Exception) { call.reject("Queue retention failed") } }
  }
}
