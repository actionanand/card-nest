#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    Window window = getWindow();
    window.setStatusBarColor(Color.rgb(40, 104, 78));
    window.setNavigationBarColor(Color.rgb(245, 246, 241));

    // CardNest contains financial information. Keep app previews and screenshots private.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
  }
}
`,
);

// @capacitor/local-notifications contributes notification, boot, and wake-lock
// manifest entries through Android manifest merging. No exact-alarm permission is requested.
console.log('CardNest Android shell, secure-window flag, and notification icon patched.');
