#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import android.os.Bundle;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    Window window = getWindow();
    window.setStatusBarColor(Color.rgb(40, 104, 78));
    window.setNavigationBarColor(Color.rgb(245, 246, 241));

    // The status bar sits on the dark green brand colour, so its icons must stay
    // white in both light and dark mode. The light navigation bar keeps dark icons.
    WindowInsetsControllerCompat insetsController =
        WindowCompat.getInsetsController(window, window.getDecorView());
    insetsController.setAppearanceLightStatusBars(false);
    insetsController.setAppearanceLightNavigationBars(true);
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
            android:src="@mipmap/ic_launcher_foreground" />
    </item>
</layer-list>
`,
);

// @capacitor/local-notifications contributes notification, boot, and wake-lock
// manifest entries through Android manifest merging. No exact-alarm permission is requested.
console.log(
  'CardNest Android shell, status-bar icons, splash screen, and notification icon patched.',
);

await import('./patch-android-export.mjs');
