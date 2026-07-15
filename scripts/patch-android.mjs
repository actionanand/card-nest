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

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  private boolean darkMode;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    darkMode = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
      == Configuration.UI_MODE_NIGHT_YES;
    getBridge().getWebView().addJavascriptInterface(new SystemBarsBridge(), "CardNestSystemBars");
    applySystemBarStyle(darkMode);
  }

  @Override
  public void onResume() {
    super.onResume();
    // Re-apply after Capacitor WebView reinitialises the window on config change.
    applySystemBarStyle(darkMode);
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) applySystemBarStyle(darkMode);
  }

  private class SystemBarsBridge {
    @JavascriptInterface
    public void setDarkMode(boolean enabled) {
      darkMode = enabled;
      runOnUiThread(() -> applySystemBarStyle(enabled));
    }
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
            <solid android:color="#FFFFFF" />
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
        <item name="windowSplashScreenIconBackgroundColor">#FFFFFF</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
        <item name="android:statusBarColor">#F5F6F1</item>
        <item name="android:windowLightStatusBar">true</item>
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
