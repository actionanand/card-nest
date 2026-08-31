#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const androidRoot = join(process.cwd(), 'android', 'app', 'src', 'main');
const javaDirectory = join(androidRoot, 'java', 'com', 'actionanand', 'cardnest', 'app');
const mainActivityPath = join(javaDirectory, 'MainActivity.java');
const reminderSchedulerPath = join(javaDirectory, 'CardNestReminderScheduler.java');
const reminderReceiverPath = join(javaDirectory, 'CardNestReminderReceiver.java');
const manifestPath = join(androidRoot, 'AndroidManifest.xml');
const appBuildGradlePath = join(process.cwd(), 'android', 'app', 'build.gradle');
const notificationIconPath = join(androidRoot, 'res', 'drawable', 'ic_stat_card_nest.xml');

for (const requiredPath of [mainActivityPath, manifestPath]) {
  if (!existsSync(requiredPath)) {
    throw new Error(
      `Android project file not found: ${requiredPath}. Run "npx cap add android" first.`,
    );
  }
}

let manifest = readFileSync(manifestPath, 'utf8');
if (!manifest.includes('android.permission.USE_BIOMETRIC')) {
  manifest = manifest.replace(
    /(<manifest\b[^>]*>)/,
    '$1\n    <uses-permission android:name="android.permission.USE_BIOMETRIC" />',
  );
}
if (!manifest.includes('android.permission.USE_FINGERPRINT')) {
  manifest = manifest.replace(
    /(<manifest\b[^>]*>)/,
    '$1\n    <uses-permission android:name="android.permission.USE_FINGERPRINT" />',
  );
}
if (!manifest.includes('com.actionanand.cardnest.app.CardNestReminderReceiver')) {
  const cardNestReminderReceiver = `        <receiver
            android:name="com.actionanand.cardnest.app.CardNestReminderReceiver"
            android:directBootAware="true"
            android:exported="false">
            <intent-filter>
                <action android:name="com.actionanand.cardnest.app.REMINDER_ALARM" />
                <action android:name="android.intent.action.LOCKED_BOOT_COMPLETED" />
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
                <action android:name="android.intent.action.TIME_SET" />
                <action android:name="android.intent.action.TIMEZONE_CHANGED" />
                <action android:name="android.intent.action.USER_UNLOCKED" />
            </intent-filter>
        </receiver>`;
  manifest = manifest.replace('</application>', `${cardNestReminderReceiver}\n    </application>`);
}
writeFileSync(manifestPath, manifest);

if (existsSync(appBuildGradlePath)) {
  let buildGradle = readFileSync(appBuildGradlePath, 'utf8');
  if (!buildGradle.includes('androidx.biometric:biometric')) {
    buildGradle = buildGradle.replace(
      /(dependencies\s*\{)/,
      '$1\n    implementation "androidx.biometric:biometric:1.1.0"',
    );
    writeFileSync(appBuildGradlePath, buildGradle);
  }
}

mkdirSync(dirname(notificationIconPath), { recursive: true });
writeFileSync(
  notificationIconPath,
  `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#00000000"
        android:strokeColor="#FFFFFFFF"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:strokeWidth="2"
        android:pathData="M4,5.5h16a2,2 0,0 1,2 2v9a2,2 0,0 1,-2 2H4a2,2 0,0 1,-2 -2v-9a2,2 0,0 1,2 -2z" />
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M2,9h20v2.25H2zM5.5,14.25h6.5v2H5.5z" />
</vector>
`,
);

writeFileSync(
  reminderSchedulerPath,
  `package com.actionanand.cardnest.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import java.util.Calendar;
import java.util.HashSet;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONObject;

final class CardNestReminderScheduler {
  static final String ACTION_ALARM = "com.actionanand.cardnest.app.REMINDER_ALARM";
  private static final String CHANNEL_ID = "card-nest-reminders";
  private static final String STORE = "card_nest_native_reminders";
  private static final String RECORDS_KEY = "records";

  private CardNestReminderScheduler() { }

  static void replace(Context context, String recordsJson) throws Exception {
    JSONArray replacement = new JSONArray(recordsJson);
    ensureChannel(context);
    if (replacement.length() > 0 && !channelEnabled(context)) {
      throw new IllegalStateException("The CardNest reminder notification channel is disabled.");
    }

    JSONArray valid = new JSONArray();
    long now = System.currentTimeMillis();
    for (int index = 0; index < replacement.length(); index++) {
      JSONObject record = replacement.getJSONObject(index);
      if (!record.has("id") || record.optString("title").isEmpty()) {
        throw new IllegalArgumentException("A reminder is missing its ID or title.");
      }
      long atMillis = record.optLong("atMillis", 0);
      if (atMillis <= now) continue;
      valid.put(record);
    }

    JSONArray previous = records(context);
    cancelBatches(context, previous);
    persist(context, valid);
    scheduleBatches(context, valid, false);
  }

  static int pendingCount(Context context) {
    return records(context).length();
  }

  static boolean channelEnabled(Context context) {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
    NotificationManager manager =
      (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager == null) return false;
    NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
    return channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
  }

  static void deliver(Context context, long scheduledAt) {
    JSONArray saved = records(context);
    JSONArray remaining = new JSONArray();
    for (int index = 0; index < saved.length(); index++) {
      JSONObject record = saved.optJSONObject(index);
      if (record == null) continue;
      if (record.optLong("atMillis") == scheduledAt) showNotification(context, record);
      else remaining.put(record);
    }
    persist(context, remaining);
  }

  static void rebuild(Context context) {
    JSONArray saved = records(context);
    cancelBatches(context, saved);
    JSONArray valid = new JSONArray();
    long now = System.currentTimeMillis();
    for (int index = 0; index < saved.length(); index++) {
      JSONObject record = saved.optJSONObject(index);
      if (record == null) continue;
      long rebuiltAt = localDateTimeMillis(record);
      if (rebuiltAt <= 0) continue;
      try { record.put("atMillis", rebuiltAt); } catch (Exception ignored) { continue; }
      if (rebuiltAt > now || sameLocalDay(rebuiltAt, now)) valid.put(record);
    }
    persist(context, valid);
    ensureChannel(context);
    scheduleBatches(context, valid, true);
  }

  private static void scheduleBatches(Context context, JSONArray values, boolean catchUpToday) {
    Set<Long> scheduledTimes = new HashSet<>();
    long now = System.currentTimeMillis();
    for (int index = 0; index < values.length(); index++) {
      JSONObject record = values.optJSONObject(index);
      if (record == null) continue;
      long originalAt = record.optLong("atMillis", 0);
      if (originalAt <= 0 || !scheduledTimes.add(originalAt)) continue;
      long triggerAt = originalAt;
      if (catchUpToday && originalAt <= now && sameLocalDay(originalAt, now)) {
        triggerAt = now + 15_000;
      }
      if (triggerAt > now) scheduleAlarm(context, originalAt, triggerAt);
    }
  }

  private static void scheduleAlarm(Context context, long batchAt, long triggerAt) {
    AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    if (alarms == null) throw new IllegalStateException("Android AlarmManager is unavailable.");
    PendingIntent pending = alarmIntent(context, batchAt, PendingIntent.FLAG_UPDATE_CURRENT);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending);
    } else {
      alarms.set(AlarmManager.RTC_WAKEUP, triggerAt, pending);
    }
  }

  private static void cancelBatches(Context context, JSONArray values) {
    AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    if (alarms == null) return;
    Set<Long> times = new HashSet<>();
    for (int index = 0; index < values.length(); index++) {
      JSONObject record = values.optJSONObject(index);
      if (record == null) continue;
      long at = record.optLong("atMillis", 0);
      if (at <= 0 || !times.add(at)) continue;
      PendingIntent pending = alarmIntent(context, at, PendingIntent.FLAG_NO_CREATE);
      if (pending != null) alarms.cancel(pending);
    }
  }

  private static PendingIntent alarmIntent(Context context, long batchAt, int updateFlag) {
    Intent intent = new Intent(context, CardNestReminderReceiver.class);
    intent.setAction(ACTION_ALARM);
    intent.setData(Uri.parse("cardnest://reminders/" + batchAt));
    intent.putExtra("scheduledAt", batchAt);
    return PendingIntent.getBroadcast(
      context,
      0,
      intent,
      updateFlag | PendingIntent.FLAG_IMMUTABLE
    );
  }

  private static void showNotification(Context context, JSONObject record) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED) return;
    if (!channelEnabled(context)) return;

    int id = record.optInt("id", -1);
    if (id < 0) return;
    Intent open = new Intent(context, MainActivity.class);
    open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    open.putExtra("cardId", record.optString("cardId"));
    PendingIntent content = PendingIntent.getActivity(
      context,
      id,
      open,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
    );
    String body = record.optString("body", "You have a CardNest reminder.");
    String title = deliveryTitle(record);
    NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_card_nest)
      .setColor(Color.parseColor("#28684E"))
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setGroup("card-nest-reminders-" + record.optLong("atMillis"))
      .setAutoCancel(true)
      .setContentIntent(content);
    NotificationManagerCompat.from(context).notify(id, notification.build());
  }

  private static String deliveryTitle(JSONObject record) {
    int days = eventDaysFromToday(record);
    if (days == Integer.MIN_VALUE) {
      return record.optString("title", "CardNest reminder");
    }
    String kind = record.optString("kind");
    String subject = "PAYMENT".equals(kind)
      ? "Payment due"
      : "ANNUAL_FEE".equals(kind) ? "Annual fee due" : "Card expires";
    if (days < 0) {
      int overdueDays = Math.abs(days);
      if ("EXPIRY".equals(kind)) {
        return "Card expired " + overdueDays + " " +
          (overdueDays == 1 ? "day" : "days") + " ago";
      }
      return subject.replace(" due", "") + " overdue by " + overdueDays + " " +
        (overdueDays == 1 ? "day" : "days");
    }
    if (days == 0) return subject + " today";
    if (days == 1) return subject + " tomorrow";
    return subject + " in " + days + " days";
  }

  private static int eventDaysFromToday(JSONObject record) {
    try {
      Calendar today = Calendar.getInstance();
      today.set(Calendar.HOUR_OF_DAY, 0);
      today.set(Calendar.MINUTE, 0);
      today.set(Calendar.SECOND, 0);
      today.set(Calendar.MILLISECOND, 0);
      Calendar event = Calendar.getInstance();
      event.clear();
      event.setLenient(false);
      event.set(
        record.getInt("eventYear"),
        record.getInt("eventMonth") - 1,
        record.getInt("eventDay"),
        0,
        0,
        0
      );
      return (int) Math.round(
        (event.getTimeInMillis() - today.getTimeInMillis()) / 86400000.0
      );
    } catch (Exception ignored) {
      return Integer.MIN_VALUE;
    }
  }

  private static void ensureChannel(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager manager =
      (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager == null) return;
    NotificationChannel channel = new NotificationChannel(
      CHANNEL_ID,
      "Card and payment reminders",
      NotificationManager.IMPORTANCE_HIGH
    );
    channel.setDescription("Masked statement-due, annual-fee, and expiry reminders");
    channel.enableLights(true);
    channel.setLightColor(Color.parseColor("#28684E"));
    channel.enableVibration(true);
    channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
    manager.createNotificationChannel(channel);
  }

  private static long localDateTimeMillis(JSONObject record) {
    try {
      Calendar value = Calendar.getInstance();
      value.clear();
      value.setLenient(false);
      value.set(
        record.getInt("year"),
        record.getInt("month") - 1,
        record.getInt("day"),
        record.getInt("hour"),
        record.getInt("minute"),
        0
      );
      return value.getTimeInMillis();
    } catch (Exception ignored) {
      return -1;
    }
  }

  private static boolean sameLocalDay(long leftMillis, long rightMillis) {
    Calendar left = Calendar.getInstance();
    left.setTimeInMillis(leftMillis);
    Calendar right = Calendar.getInstance();
    right.setTimeInMillis(rightMillis);
    return left.get(Calendar.ERA) == right.get(Calendar.ERA) &&
      left.get(Calendar.YEAR) == right.get(Calendar.YEAR) &&
      left.get(Calendar.DAY_OF_YEAR) == right.get(Calendar.DAY_OF_YEAR);
  }

  private static JSONArray records(Context context) {
    String json = preferences(context).getString(RECORDS_KEY, "[]");
    try { return new JSONArray(json); } catch (Exception ignored) { return new JSONArray(); }
  }

  private static void persist(Context context, JSONArray values) {
    if (!preferences(context).edit().putString(RECORDS_KEY, values.toString()).commit()) {
      throw new IllegalStateException("Reminder schedule could not be stored.");
    }
  }

  private static SharedPreferences preferences(Context context) {
    return context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
  }
}
`,
);

writeFileSync(
  reminderReceiverPath,
  `package com.actionanand.cardnest.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.UserManager;

public class CardNestReminderReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (CardNestReminderScheduler.ACTION_ALARM.equals(intent == null ? null : intent.getAction())) {
      CardNestReminderScheduler.deliver(context, intent.getLongExtra("scheduledAt", -1));
      return;
    }
    UserManager users = (UserManager) context.getSystemService(Context.USER_SERVICE);
    if (users == null || !users.isUserUnlocked()) return;
    CardNestReminderScheduler.rebuild(context);
  }
}
`,
);

writeFileSync(
  mainActivityPath,
  `package com.actionanand.cardnest.app;

import android.content.res.Configuration;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.Toast;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.Executor;

public class MainActivity extends BridgeActivity {
  private static final int CREATE_BACKUP_REQUEST = 4101;
  private static final int OPEN_BACKUP_REQUEST = 4102;
  private boolean darkMode;
  private byte[] pendingBackup;
  private View launchOverlay;
  private BiometricPrompt biometricPrompt;
  private boolean waitingForExitBackPress;
  private String reminderScheduleError = "";

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    showLaunchOverlay();
    darkMode = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
      == Configuration.UI_MODE_NIGHT_YES;
    getBridge().getWebView().addJavascriptInterface(new SystemBarsBridge(), "CardNestSystemBars");
    getBridge().getWebView().addJavascriptInterface(new CardNestNativeBridge(), "CardNestNative");
    applyLaunchBarStyle();
  }

  @Override
  public void onResume() {
    super.onResume();
    // Re-apply after Capacitor WebView reinitialises the window on config change.
    if (launchOverlay == null) applySystemBarStyle(darkMode);
  }

  @Override
  public void onBackPressed() {
    if (waitingForExitBackPress) {
      finishAffinity();
      return;
    }

    waitingForExitBackPress = true;
    new android.os.Handler(getMainLooper()).postDelayed(
      () -> waitingForExitBackPress = false,
      2500
    );

    if (getBridge() == null || getBridge().getWebView() == null) return;
    getBridge().getWebView().evaluateJavascript(
      "window.history.replaceState({}, '', '/');" +
        "window.dispatchEvent(new PopStateEvent('popstate'));",
      null
    );
    Toast.makeText(this, "Press back again to exit CardNest", Toast.LENGTH_SHORT).show();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus && launchOverlay == null) applySystemBarStyle(darkMode);
  }

  public class SystemBarsBridge {
    @JavascriptInterface
    public void setDarkMode(boolean enabled) {
      darkMode = enabled;
      runOnUiThread(() -> applySystemBarStyle(enabled));
    }
  }

  public class CardNestNativeBridge {
    @JavascriptInterface
    public boolean replaceReminderSchedule(String remindersJson) {
      try {
        CardNestReminderScheduler.replace(MainActivity.this, remindersJson);
        reminderScheduleError = "";
        return true;
      } catch (Exception error) {
        reminderScheduleError = error.getMessage() == null
          ? "Android could not store the reminder schedule."
          : error.getMessage();
        return false;
      }
    }

    @JavascriptInterface
    public int pendingReminderCount() {
      return CardNestReminderScheduler.pendingCount(MainActivity.this);
    }

    @JavascriptInterface
    public boolean reminderChannelEnabled() {
      return CardNestReminderScheduler.channelEnabled(MainActivity.this);
    }

    @JavascriptInterface
    public String reminderScheduleError() {
      return reminderScheduleError;
    }

    @JavascriptInterface
    public void setScreenSecure(boolean enabled) {
      runOnUiThread(() -> {
        if (enabled) {
          getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
          getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
      });
    }

    @JavascriptInterface
    public void hideSplash() {
      runOnUiThread(() -> hideLaunchOverlay());
    }

    @JavascriptInterface
    public boolean isBiometricAvailable() {
      return BiometricManager.from(MainActivity.this).canAuthenticate(
        BiometricManager.Authenticators.BIOMETRIC_WEAK
      )
        == BiometricManager.BIOMETRIC_SUCCESS;
    }

    @JavascriptInterface
    public void authenticateBiometric() {
      runOnUiThread(() -> {
        if (biometricPrompt != null) biometricPrompt.cancelAuthentication();
        Executor executor = ContextCompat.getMainExecutor(MainActivity.this);
        biometricPrompt = new BiometricPrompt(
          MainActivity.this,
          executor,
          new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
              super.onAuthenticationSucceeded(result);
              biometricPrompt = null;
              dispatchNativeResult("biometric", true, "", "");
            }

            @Override
            public void onAuthenticationError(int errorCode, CharSequence errorMessage) {
              super.onAuthenticationError(errorCode, errorMessage);
              biometricPrompt = null;
              dispatchNativeResult("biometric", false, "", errorMessage.toString());
            }
          }
        );
        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
          .setTitle("Unlock CardNest")
          .setSubtitle("Confirm your identity to access your cards")
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK)
          .setNegativeButtonText("Use application PIN")
          .build();
        biometricPrompt.authenticate(promptInfo);
      });
    }

    @JavascriptInterface
    public void cancelBiometric() {
      runOnUiThread(() -> {
        if (biometricPrompt != null) {
          biometricPrompt.cancelAuthentication();
          biometricPrompt = null;
        }
      });
    }

    @JavascriptInterface
    public void saveBackup(String fileName, String base64Data) {
      runOnUiThread(() -> {
        try {
          pendingBackup = Base64.decode(base64Data, Base64.DEFAULT);
          Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
          intent.addCategory(Intent.CATEGORY_OPENABLE);
          intent.setType("application/octet-stream");
          intent.putExtra(Intent.EXTRA_TITLE, fileName);
          startActivityForResult(intent, CREATE_BACKUP_REQUEST);
        } catch (Exception error) {
          dispatchNativeResult("backup-saved", false, "", error.getMessage());
        }
      });
    }

    @JavascriptInterface
    public void openBackup() {
      runOnUiThread(() -> {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(intent, OPEN_BACKUP_REQUEST);
      });
    }
  }

  private void showLaunchOverlay() {
    FrameLayout overlay = new FrameLayout(this);
    overlay.setBackgroundColor(Color.rgb(40, 104, 78));
    overlay.setClickable(true);

    ImageView icon = new ImageView(this);
    icon.setImageResource(R.drawable.card_nest_splash_logo);
    icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
    int padding = dp(25);
    icon.setPadding(padding, padding, padding, padding);
    GradientDrawable tile = new GradientDrawable();
    tile.setShape(GradientDrawable.OVAL);
    tile.setColor(Color.rgb(245, 246, 241));
    icon.setBackground(tile);
    icon.setElevation(dp(6));

    FrameLayout.LayoutParams iconLayout = new FrameLayout.LayoutParams(dp(164), dp(164));
    iconLayout.gravity = Gravity.CENTER;
    overlay.addView(icon, iconLayout);
    addContentView(
      overlay,
      new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    );
    launchOverlay = overlay;
  }

  private void hideLaunchOverlay() {
    View overlay = launchOverlay;
    if (overlay == null) return;
    launchOverlay = null;
    overlay.animate()
      .alpha(0f)
      .setDuration(180)
      .withEndAction(() -> {
        if (overlay.getParent() instanceof ViewGroup) {
          ((ViewGroup) overlay.getParent()).removeView(overlay);
        }
        applySystemBarStyle(darkMode);
      })
      .start();
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  @SuppressWarnings("deprecation")
  private void applyLaunchBarStyle() {
    Window window = getWindow();
    int green = Color.rgb(40, 104, 78);
    window.setStatusBarColor(green);
    window.setNavigationBarColor(green);
    View decor = window.getDecorView();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      WindowInsetsController controller = decor.getWindowInsetsController();
      if (controller != null) {
        controller.setSystemBarsAppearance(
          0,
          WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
            | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        );
      }
      return;
    }
    int flags = decor.getSystemUiVisibility();
    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    decor.setSystemUiVisibility(flags);
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != CREATE_BACKUP_REQUEST && requestCode != OPEN_BACKUP_REQUEST) return;
    String action = requestCode == CREATE_BACKUP_REQUEST ? "backup-saved" : "backup-opened";
    if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
      pendingBackup = null;
      dispatchNativeResult(action, false, "", "File selection was cancelled.");
      return;
    }
    Uri uri = data.getData();
    try {
      if (requestCode == CREATE_BACKUP_REQUEST) {
        try (OutputStream output = getContentResolver().openOutputStream(uri)) {
          if (output == null) throw new IllegalStateException("The selected file could not be opened.");
          output.write(pendingBackup);
        }
        pendingBackup = null;
        dispatchNativeResult(action, true, "", "");
        return;
      }
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      try (InputStream input = getContentResolver().openInputStream(uri)) {
        if (input == null) throw new IllegalStateException("The selected file could not be opened.");
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
      }
      dispatchNativeResult(
        action,
        true,
        Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP),
        ""
      );
    } catch (Exception error) {
      pendingBackup = null;
      dispatchNativeResult(action, false, "", error.getMessage());
    }
  }

  private void dispatchNativeResult(
    String action,
    boolean success,
    String data,
    String message
  ) {
    runOnUiThread(() -> {
      String script = "window.dispatchEvent(new CustomEvent('cardnest-native-result',{detail:{"
        + "action:" + JSONObject.quote(action)
        + ",success:" + success
        + ",data:" + JSONObject.quote(data == null ? "" : data)
        + ",message:" + JSONObject.quote(message == null ? "" : message)
        + "}}));";
      getBridge().getWebView().evaluateJavascript(script, null);
    });
  }

  @SuppressWarnings("deprecation")
  private void applySystemBarStyle(boolean darkMode) {
    Window window = getWindow();
    window.setStatusBarColor(darkMode ? Color.rgb(23, 33, 28) : Color.rgb(245, 246, 241));
    window.setNavigationBarColor(darkMode ? Color.rgb(23, 33, 28) : Color.rgb(245, 246, 241));

    View decor = window.getDecorView();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      WindowInsetsController controller = decor.getWindowInsetsController();
      if (controller != null) {
        int appearance = darkMode ? 0 : WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
          | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        controller.setSystemBarsAppearance(
          appearance,
          WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
            | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        );
      }
      return;
    }

    int flags = decor.getSystemUiVisibility();
    if (darkMode) {
      flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
      flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    } else {
      flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
      flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    }
    decor.setSystemUiVisibility(flags);
  }
}
`,
);

// A branded launch splash. Capacitor's default launch theme uses @drawable/splash, so
// we replace any raster splash with a vector-friendly layer-list on the brand colour with
// the launcher icon centred. This avoids the plain white flash on cold start.
const drawableRoot = join(androidRoot, 'res');
if (existsSync(drawableRoot)) {
  for (const directory of readdirSync(drawableRoot)) {
    if (!directory.startsWith('drawable')) continue;
    const splashPng = join(drawableRoot, directory, 'splash.png');
    if (existsSync(splashPng)) rmSync(splashPng);
    // Remove per-orientation duplicates that would clash with the shared splash.xml.
    if (directory !== 'drawable') {
      const splashXml = join(drawableRoot, directory, 'splash.xml');
      if (existsSync(splashXml)) rmSync(splashXml);
    }
  }
}
const splashIconSource = join(process.cwd(), 'public', 'card-nest.png');
const legacySplashIconPath = join(
  androidRoot,
  'res',
  'drawable-nodpi',
  'card_nest_splash_icon.png',
);
const splashLogoPath = join(androidRoot, 'res', 'drawable-nodpi', 'card_nest_splash_logo.png');
if (existsSync(legacySplashIconPath)) rmSync(legacySplashIconPath);
if (existsSync(splashIconSource)) {
  mkdirSync(dirname(splashLogoPath), { recursive: true });
  copyFileSync(splashIconSource, splashLogoPath);
}
const splashIconDrawablePath = join(androidRoot, 'res', 'drawable', 'card_nest_splash_icon.xml');
mkdirSync(dirname(splashIconDrawablePath), { recursive: true });
writeFileSync(
  splashIconDrawablePath,
  `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item
        android:width="160dp"
        android:height="160dp"
        android:gravity="center">
        <shape android:shape="oval">
            <solid android:color="#F5F6F1" />
        </shape>
    </item>
    <item
        android:width="112dp"
        android:height="112dp"
        android:gravity="center">
        <bitmap
            android:gravity="fill"
            android:src="@drawable/card_nest_splash_logo" />
    </item>
</layer-list>
`,
);
const splashPath = join(androidRoot, 'res', 'drawable', 'splash.xml');
mkdirSync(dirname(splashPath), { recursive: true });
writeFileSync(
  splashPath,
  `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item>
        <shape android:shape="rectangle">
            <solid android:color="#28684E" />
        </shape>
    </item>
    <item
        android:drawable="@drawable/card_nest_splash_icon"
        android:gravity="center" />
</layer-list>
`,
);

// @capacitor/local-notifications contributes notification, boot, and wake-lock
// manifest entries through Android manifest merging. No exact-alarm permission is requested.

// ── Patch styles.xml ──────────────────────────────────────────────────────────
// 1. Force white status-bar icons (dark green background) in ALL themes by setting
//    android:windowLightStatusBar=false at the theme level so it survives configuration
//    changes and Capacitor WebView resets.
// 2. Set the nav-bar colour so the launch theme matches the runtime theme.
// 3. Reference the branded splash drawable in the launch theme.
const stylesItems = `        <item name="android:statusBarColor">#F5F6F1</item>
        <item name="android:windowLightStatusBar">true</item>
        <item name="android:navigationBarColor">#F5F6F1</item>
        <item name="android:windowLightNavigationBar">true</item>`;

const stylesPath = join(androidRoot, 'res', 'values', 'styles.xml');
if (existsSync(stylesPath)) {
  let styles = readFileSync(stylesPath, 'utf8');
  if (!styles.includes('android:windowLightStatusBar')) {
    // Inject the status-bar items into the first <style …> block.
    styles = styles.replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/,
      (_m, open, body, close) => `${open}${body}${stylesItems}\n    ${close}`,
    );
  }
  // Always repair the launch theme. Earlier patch versions could add the system-bar
  // items without adding the branded splash reference.
  styles = styles.replace(
    /(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)([\s\S]*?)(<\/style>)/,
    (_match, open, body, close) => {
      const splashItem = '        <item name="android:background">@drawable/splash</item>';
      const patchedBody = body.match(/<item name="android:background">[\s\S]*?<\/item>/)
        ? body.replace(/\s*<item name="android:background">[\s\S]*?<\/item>/, `\n${splashItem}`)
        : `${body}${splashItem}\n`;
      return `${open}${patchedBody}${close}`;
    },
  );
  writeFileSync(stylesPath, styles);
}

// Night-mode override: keep the same green status bar but switch the nav bar to dark.
const nightStylesDir = join(androidRoot, 'res', 'values-night');
const nightStylesPath = join(nightStylesDir, 'styles.xml');
mkdirSync(nightStylesDir, { recursive: true });
if (
  !existsSync(nightStylesPath) ||
  !readFileSync(nightStylesPath, 'utf8').includes('android:windowLightStatusBar')
) {
  writeFileSync(
    nightStylesPath,
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Night-mode overrides: keep the brand-green status bar with white icons;
         switch the navigation bar to the dark app background. -->
    <style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="android:statusBarColor">#17211C</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:navigationBarColor">#17211C</item>
        <item name="android:windowLightNavigationBar">false</item>
    </style>
</resources>
`,
  );
}

// Android 12+ shows the platform splash before Capacitor's launch theme. Keep it
// branded and use the generated launcher icon so users never see a plain white flash.
const v31StylesDir = join(androidRoot, 'res', 'values-v31');
const v31StylesPath = join(v31StylesDir, 'styles.xml');
mkdirSync(v31StylesDir, { recursive: true });
writeFileSync(
  v31StylesPath,
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme.NoActionBarLaunch" parent="AppTheme.NoActionBar">
        <item name="windowSplashScreenBackground">#28684E</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/card_nest_splash_icon</item>
        <item name="windowSplashScreenIconBackgroundColor">#F5F6F1</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
        <item name="android:statusBarColor">#28684E</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:navigationBarColor">#28684E</item>
        <item name="android:windowLightNavigationBar">false</item>
    </style>
</resources>
`,
);

console.log(
  'CardNest Android shell, native reminder scheduler, status-bar icons, splash screen, styles, and notification icon patched.',
);

await import('./patch-android-export.mjs');
