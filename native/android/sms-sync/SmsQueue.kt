package com.actionanand.cardnest.app.sms

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Separate private queue; never opens the Capacitor ledger database. No raw bodies. */
class SmsQueue(context: Context) : SQLiteOpenHelper(context, "sms-discovery.db", null, 1) {
  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL("CREATE TABLE queue (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
  }
  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    return (store.getKey("cardnest-sms-v1", null) as? SecretKey) ?: KeyGenerator.getInstance("AES", "AndroidKeyStore").run {
      init(KeyGenParameterSpec.Builder("cardnest-sms-v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
      generateKey()
    }
  }
  private fun encrypt(value: String): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    return Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
  }
  private fun decrypt(value: String): String {
    val bytes = Base64.decode(value, Base64.NO_WRAP)
    return String(Cipher.getInstance("AES/GCM/NoPadding").run {
      init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
      doFinal(bytes.copyOfRange(12, bytes.size))
    }, Charsets.UTF_8)
  }
  fun stage(result: SmsTransactionParser.Result, providerId: String): Boolean {
    val db = writableDatabase
    db.rawQuery("SELECT COUNT(*) FROM queue", null).use { it.moveToFirst(); if (it.getInt(0) >= 5000) return false }
    db.execSQL("INSERT OR REPLACE INTO queue(id,payload) VALUES (?,?)", arrayOf(result.fingerprint, encrypt(json(result, providerId).toString())))
    return true
  }
  fun pending(limit: Int): List<JSONObject> = readableDatabase.rawQuery("SELECT payload FROM queue ORDER BY rowid LIMIT ?", arrayOf(limit.toString())).use { cursor ->
    buildList { while (cursor.moveToNext()) add(JSONObject(decrypt(cursor.getString(0)))) }
  }
  fun ack(ids: List<String>) {
    val db = writableDatabase
    db.beginTransaction()
    try { ids.forEach { db.delete("queue", "id = ?", arrayOf(it)) }; db.setTransactionSuccessful() } finally { db.endTransaction() }
  }
  fun prune(cutoff: String) {
    val ids = readableDatabase.rawQuery("SELECT id,payload FROM queue",null).use { cursor ->
      buildList { while (cursor.moveToNext()) {
        val item = JSONObject(decrypt(cursor.getString(1)))
        if (item.getString("eventDate") < cutoff) add(cursor.getString(0))
      } }
    }
    ack(ids)
  }
  fun destroyKey() {
    KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("cardnest-sms-v1") }
  }
  companion object {
    fun json(r: SmsTransactionParser.Result, providerId: String): JSONObject = JSONObject().apply {
      put("id", r.fingerprint); put("providerId", providerId); put("kind", r.kind.name)
      put("amountMinor", r.amountMinor); put("eventDate", r.eventDate); put("eventAt", r.eventAt)
      put("receivedAt", r.receivedAt); put("dateFallback", r.dateFallback); put("currency", r.currency)
      put("merchant", r.merchant); put("merchantEvidence", r.merchantEvidence); put("cardDigits", r.cardDigits); put("accountDigits", r.accountDigits)
      put("issuer", r.issuer); put("reference", r.reference); put("reportedBalanceMinor", r.reportedBalanceMinor)
      put("vehicleNumber", r.vehicleNumber); put("availableLimitMinor", r.availableLimitMinor)
      put("statementTotalMinor", r.statementTotalMinor); put("minimumDueMinor", r.minimumDueMinor)
      put("dueDate", r.dueDate); put("evidence", r.evidence)
      put("eventTime", r.eventTime); put("timeZone", r.timeZone); put("cardNetwork", r.cardNetwork)
      put("confidence", r.confidence); put("earnedForPeriod", r.earnedForPeriod); put("statementDate", r.statementDate)
      put("balancePosition", r.balancePosition)
    }
  }
}
