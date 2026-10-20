package com.actionanand.cardnest.app.sms

import android.Manifest
import android.app.job.*
import android.content.*
import android.content.pm.PackageManager
import android.os.PersistableBundle
import android.provider.Telephony
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

object SmsDiscovery {
  const val JOB_ID = 8041
  private val lock = Any()
  fun begin(context: Context) = synchronized(lock) {
    val prefs = settings(context)
    if (!prefs.getBoolean("enabled",false) || !permitted(context)) throw SecurityException("SMS access unavailable")
    val edit = prefs.edit().putBoolean("cancelled", false)
    if (!prefs.getBoolean("more", false) && prefs.getLong("completedAt", 0) > 0) {
      edit.putLong("cursorDate", maxOf(prefs.getLong("since", 0), prefs.getLong("cursorDate", 0) - 2L * 86400000)).putLong("cursorId", -1)
    }
    edit.commit()
  }
  fun clear(context: Context) = synchronized(lock) {
    settings(context).edit().clear().commit()
    (context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).cancel(JOB_ID)
    SmsQueue(context).use { it.writableDatabase.delete("queue", null, null); it.destroyKey() }
  }
  fun prune(context: Context, cutoff: String) = synchronized(lock) { SmsQueue(context).use { it.prune(cutoff) } }
  fun settings(context: Context) = context.getSharedPreferences("sms-discovery", Context.MODE_PRIVATE)
  fun permitted(context: Context) = listOf(Manifest.permission.READ_SMS,Manifest.permission.RECEIVE_SMS).all {
    ContextCompat.checkSelfPermission(context,it) == PackageManager.PERMISSION_GRANTED
  }
  fun schedule(context: Context) {
    if (!settings(context).getBoolean("enabled", false) || !permitted(context)) return
    val job = JobInfo.Builder(JOB_ID, ComponentName(context, SmsScanJob::class.java))
      .setOverrideDeadline(1000).setPersisted(true).setExtras(PersistableBundle()).build()
    (context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).schedule(job)
  }
  /** One bounded page, serialized against foreground, receiver and job retries. */
  fun page(context: Context): Boolean = synchronized(lock) {
    val prefs = settings(context)
    if (!prefs.getBoolean("enabled", false) || !permitted(context)) throw SecurityException("SMS access unavailable")
    val batch = prefs.getInt("batch", 200).coerceIn(1, 500)
    val date = prefs.getLong("cursorDate", prefs.getLong("since", 0))
    val id = prefs.getLong("cursorId", -1)
    val uri = Telephony.Sms.Inbox.CONTENT_URI
    var progress = SmsPageEngine.Progress(0,0,false,false)
    SmsQueue(context).use { queue ->
      context.contentResolver.query(uri, arrayOf("_id", "date", "body"),
        "(date > ? OR (date = ? AND _id > ?))", arrayOf(date.toString(), date.toString(), id.toString()), "date ASC, _id ASC LIMIT $batch")
        ?.use { cursor ->
          val messages = sequence { while (cursor.moveToNext()) yield(SmsPageEngine.Message(cursor.getLong(0),cursor.getLong(1),cursor.getString(2) ?: "")) }
          progress = SmsPageEngine.consume(messages,batch,
            { !prefs.getBoolean("enabled",false) || prefs.getBoolean("cancelled",false) || !permitted(context) },
            { parsed,providerId -> queue.stage(parsed,providerId.toString()) },
            { received,providerId -> if (!prefs.edit().putLong("cursorDate",received).putLong("cursorId",providerId).commit()) error("Cursor could not be saved") })
        } ?: throw IllegalStateException("SMS provider query unavailable")
    }
    val more = if (progress.cancelled) prefs.getBoolean("more",true) else progress.more
    prefs.edit().putInt("scanned", prefs.getInt("scanned", 0) + progress.scanned).putInt("found", prefs.getInt("found", 0) + progress.found)
      .putInt("pages", prefs.getInt("pages", 0) + 1).putBoolean("more", more)
      .putString("error", "").apply()
    if (!more && !progress.cancelled) prefs.edit().putLong("completedAt", System.currentTimeMillis()).apply()
    more
  }
}

class SmsScanJob : JobService() {
  private val stopped = AtomicBoolean(false)
  override fun onStartJob(params: JobParameters): Boolean {
    stopped.set(false)
    Executors.newSingleThreadExecutor().also { executor -> executor.execute {
      var retry = false
      try {
        SmsDiscovery.begin(this)
        // Bound a job invocation. Further work is rescheduled without an active WebView.
        var more = true
        repeat(10) { if (!stopped.get() && more) more = SmsDiscovery.page(this) }
        retry = more && !stopped.get()
      } catch (_: SecurityException) {
        SmsDiscovery.settings(this).edit().putString("error", "SMS permission revoked or denied").apply()
      } catch (_: Exception) {
        SmsDiscovery.settings(this).edit().putString("error", "Scan interrupted; retry after reviewing queued items").apply()
        retry = true
      } finally { jobFinished(params, retry); executor.shutdown() }
    } }
    return true
  }
  override fun onStopJob(params: JobParameters): Boolean { stopped.set(true); return true }
}

class SmsReceivedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Telephony.Sms.Intents.SMS_RECEIVED_ACTION) SmsDiscovery.schedule(context)
  }
}

class SmsRestartReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action in listOf(Intent.ACTION_BOOT_COMPLETED,Intent.ACTION_MY_PACKAGE_REPLACED,Intent.ACTION_USER_UNLOCKED)) SmsDiscovery.schedule(context)
  }
}
