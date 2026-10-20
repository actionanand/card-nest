package com.actionanand.cardnest.app.sms

import android.Manifest
import android.app.job.JobScheduler
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.core.app.ActivityCompat
import com.getcapacitor.*
import com.getcapacitor.annotation.*
import org.json.JSONArray

@CapacitorPlugin(name = "CardNestSms", permissions = [Permission(alias = "sms", strings = [Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS])])
class CardNestSmsPlugin : Plugin() {
  private val permissionHandler = Handler(Looper.getMainLooper())
  @Volatile private var pendingPermissionCall: PluginCall? = null
  private val requestTimeout = Runnable { failRequest("Android did not complete the SMS permission request. Check app settings or paste a message.") }
  private val permissionFlow by lazy {
    SmsPermissionFlow({ observeAccess() }, {
      val p=SmsDiscovery.settings(context)
      SmsPermissionFlow.History(p.getBoolean("wasGranted",false),p.getString("permissionOutcome","") == "denied")
    }, { granted ->
      check(SmsDiscovery.settings(context).edit().putString("permissionOutcome",if(granted) "granted" else "denied")
        .putBoolean("wasGranted",granted || SmsDiscovery.settings(context).getBoolean("wasGranted",false)).commit())
    }, { bounds ->
      check(SmsDiscovery.permitted(context)) { "SMS access changed before enabling. Retry safely." }
      val p=SmsDiscovery.settings(context)
      val edit=p.edit().putInt("batch",bounds.batch).putBoolean("enabled",true).putBoolean("wasGranted",true)
        .putBoolean("cancelled",false).putString("error","").putString("permissionOutcome","granted")
      // Only the first successful opt-in initializes history. Re-enable resumes;
      // permission failures never touch the cursor, queue or financial database.
      if (!p.contains("cursorDate")) edit.putLong("since",bounds.since).putLong("cursorDate",bounds.since)
        .putLong("cursorId",-1).putBoolean("more",true)
      else if (p.getLong("completedAt",0) == 0L) edit.putBoolean("more",true)
      check(edit.commit()) { "SMS enable settings could not be saved." }
    })
  }
  private fun observeAccess(): SmsPermissionFlow.Access {
    val declared=isPermissionDeclared("sms")
    fun grant(permission: String) = SmsPermissionFlow.Grant(
      ActivityCompat.checkSelfPermission(context,permission) == PackageManager.PERMISSION_GRANTED,
      declared, ActivityCompat.shouldShowRequestPermissionRationale(activity,permission),
      try { context.packageManager.isPermissionRevokedByPolicy(permission,context.packageName) } catch (_: Exception) { false })
    return SmsPermissionFlow.Access(grant(Manifest.permission.READ_SMS),grant(Manifest.permission.RECEIVE_SMS),
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY))
  }
  private fun diagnostic(event: String) {
    if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
      val s=permissionFlow.status()
      Log.d("CardNestSmsPermission","$event state=${s.permission} read=${s.readGranted} receive=${s.receiveGranted}")
    }
  }
  private fun snapshot(): JSObject {
    val access=permissionFlow.status()
    val prefs=SmsDiscovery.settings(context)
    val granted=access.readGranted && access.receiveGranted
    if (!granted && prefs.getBoolean("enabled",false)) {
      prefs.edit().putBoolean("enabled",false).commit()
      (context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).cancel(SmsDiscovery.JOB_ID)
    }
    if(granted && (!prefs.getBoolean("wasGranted",false) || prefs.getString("permissionOutcome","") != "granted"))
      prefs.edit().putBoolean("wasGranted",true).putString("permissionOutcome","granted").commit()
    val enabled=granted && prefs.getBoolean("enabled",false)
    return JSObject().apply {
      put("permission",access.permission); put("permissionMessage",access.message)
      put("canRequest",access.canRequest); put("settingsRecommended",access.settingsRecommended)
      put("readGranted",access.readGranted); put("receiveGranted",access.receiveGranted)
      put("requesting",permissionFlow.requesting)
      put("enabled",enabled); put("backgroundPending",enabled && prefs.getBoolean("more",false) && !prefs.getBoolean("cancelled",false))
      put("cursorDate",prefs.getLong("cursorDate",0)); put("cursorId",prefs.getLong("cursorId",-1))
      put("completedAt",prefs.getLong("completedAt",0)); put("pages",prefs.getInt("pages",0))
      put("scanned",prefs.getInt("scanned",0)); put("found",prefs.getInt("found",0))
      put("more",prefs.getBoolean("more",false)); put("error",prefs.getString("error",""))
    }
  }
  @PluginMethod fun status(call: PluginCall) {
    call.resolve(snapshot())
  }
  @PluginMethod fun enable(call: PluginCall) {
    val batch = call.getInt("batch", 200) ?: 200
    val since = call.getLong("since", System.currentTimeMillis() - 30L * 86400000) ?: 0L
    if (batch !in 1..500 || since < 0 || since > System.currentTimeMillis()) { call.reject("Invalid scan bounds"); return }
    activity.runOnUiThread {
      try {
        when(permissionFlow.begin(SmsPermissionFlow.Bounds(since,batch))) {
          SmsPermissionFlow.Start.COMPLETE -> status(call)
          SmsPermissionFlow.Start.UNAVAILABLE -> { diagnostic("request unavailable"); status(call) }
          SmsPermissionFlow.Start.REQUEST -> {
            pendingPermissionCall=call
            permissionHandler.postDelayed(requestTimeout,120_000)
            diagnostic("request launched")
            requestPermissionForAlias("sms",call,"permissionsReady")
          }
        }
      } catch (_: Exception) {
        if(pendingPermissionCall === call) failRequest("Android could not request SMS access. Check app settings or paste a message.")
        else call.reject("SMS access request could not start, or one is already in progress.")
      }
    }
  }
  @PermissionCallback private fun permissionsReady(call: PluginCall) {
    if (pendingPermissionCall?.callbackId != call.callbackId) return
    permissionHandler.removeCallbacks(requestTimeout)
    try { permissionFlow.complete(); diagnostic("callback completed"); status(call) }
    catch (_: Exception) { call.reject("Android responded, but SMS access could not be enabled. Retry is safe.") }
    finally { pendingPermissionCall=null }
  }
  private fun failRequest(message: String) {
    val wasRequesting = pendingPermissionCall != null
    permissionHandler.removeCallbacks(requestTimeout)
    permissionFlow.failed()
    pendingPermissionCall?.reject(message)
    pendingPermissionCall=null
    if (wasRequesting) diagnostic("request interrupted")
  }
  override fun handleOnResume() { super.handleOnResume(); snapshot() }
  override fun handleOnDestroy() { failRequest("SMS permission request interrupted. Reopen SMS Sync and try again."); super.handleOnDestroy() }
  @PluginMethod fun openSettings(call: PluginCall) {
    activity.runOnUiThread {
      try {
        val intent=Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:${context.packageName}"))
        activity.startActivity(intent); call.resolve()
      } catch (_: Exception) { call.reject("Android app settings could not be opened. Open CardNest in Android Settings manually.") }
    }
  }
  @PluginMethod fun disable(call: PluginCall) {
    if(permissionFlow.requesting) failRequest("SMS access request cancelled by the user.")
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
  @PluginMethod fun beginScan(call: PluginCall) {
    try { SmsDiscovery.begin(context); call.resolve() }
    catch (_: SecurityException) { call.reject("SMS permissions are unavailable. Check SMS access before scanning.") }
    catch (_: Exception) { call.reject("Scan could not start. Saved progress is preserved; retry safely.") }
  }
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
