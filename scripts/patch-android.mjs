#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const androidRoot = join(process.cwd(), 'android', 'app', 'src', 'main');
const javaDirectory = join(androidRoot, 'java', 'com', 'actionanand', 'cardnest', 'app');
const mainActivityPath = join(javaDirectory, 'MainActivity.java');
const manifestPath = join(androidRoot, 'AndroidManifest.xml');
const notificationIconPath = join(androidRoot, 'res', 'drawable', 'ic_stat_card_nest.xml');

for (const requiredPath of [mainActivityPath, manifestPath]) {
  if (!existsSync(requiredPath)) {
    throw new Error(
      `Android project file not found: ${requiredPath}. Run "npx cap add android" first.`,
    );
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
  mainActivityPath,
  `package com.actionanand.cardnest.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    applySystemBarStyle();
  }

  @Override
  public void onResume() {
    super.onResume();
    // Re-apply after Capacitor WebView reinitialises the window on config change.
    applySystemBarStyle();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) applySystemBarStyle();
  }

  @SuppressWarnings("deprecation")
  private void applySystemBarStyle() {
    Window window = getWindow();
    window.setStatusBarColor(Color.rgb(40, 104, 78));
    window.setNavigationBarColor(Color.rgb(245, 246, 241));

    View decor = window.getDecorView();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      WindowInsetsController controller = decor.getWindowInsetsController();
      if (controller != null) {
        // No APPEARANCE_LIGHT_STATUS_BARS means white status-bar icons.
        controller.setSystemBarsAppearance(
          WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
          WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
            | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        );
      }
      return;
    }

    // Clear SYSTEM_UI_FLAG_LIGHT_STATUS_BAR  → white status-bar icons on the dark-green bar.
    // Set   SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR → dark nav-bar icons on the light nav bar.
    int flags = decor.getSystemUiVisibility();
    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
    flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
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
    <item android:gravity="center">
        <bitmap
            android:gravity="center"
            android:src="@mipmap/ic_launcher" />
    </item>
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
const stylesItems = `        <item name="android:statusBarColor">#28684E</item>
        <item name="android:windowLightStatusBar">false</item>
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
    // Ensure the launch theme references the branded splash.
    if (styles.includes('NoActionBarLaunch') && !styles.includes('@drawable/splash')) {
      styles = styles.replace(
        /(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)([\s\S]*?)(<\/style>)/,
        (_m, open, body, close) =>
          `${open}${body}        <item name="android:background">@drawable/splash</item>\n    ${close}`,
      );
    }
    writeFileSync(stylesPath, styles);
  }
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
        <item name="android:statusBarColor">#28684E</item>
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
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item>
        <item name="windowSplashScreenIconBackgroundColor">#28684E</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
        <item name="android:statusBarColor">#28684E</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:navigationBarColor">#F5F6F1</item>
        <item name="android:windowLightNavigationBar">true</item>
    </style>
</resources>
`,
);

console.log(
  'CardNest Android shell, status-bar icons, splash screen, styles, and notification icon patched.',
);

await import('./patch-android-export.mjs');
