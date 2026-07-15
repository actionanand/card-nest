#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const appPackage = 'com.actionanand.cardnest.app';
const javaDirectory = join('android', 'app', 'src', 'main', 'java', ...appPackage.split('.'));
const pluginPath = join(javaDirectory, 'CardNestExportPlugin.java');
const mainActivityPath = join(javaDirectory, 'MainActivity.java');
const manifestPath = join('android', 'app', 'src', 'main', 'AndroidManifest.xml');
const filePathsPath = join(
  'android',
  'app',
  'src',
  'main',
  'res',
  'xml',
  'card_nest_file_paths.xml',
);

for (const requiredPath of [mainActivityPath, manifestPath]) {
  if (!existsSync(requiredPath)) {
    throw new Error(
      `Android project file not found: ${requiredPath}. Run "npx cap add android" first.`,
    );
  }
}

mkdirSync(javaDirectory, { recursive: true });
mkdirSync(dirname(filePathsPath), { recursive: true });

writeFileSync(
  pluginPath,
  `package ${appPackage};

import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "CardNestExport")
public class CardNestExportPlugin extends Plugin {
  // A4 portrait at 72 points per inch: 210 x 297 mm.
  private static final int PAGE_WIDTH = 595;
  private static final int PAGE_HEIGHT = 842;
  private static final int MARGIN = 28;
  private static final int AVAILABLE_WIDTH = PAGE_WIDTH - (MARGIN * 2);
  private static final int BOTTOM = PAGE_HEIGHT - MARGIN;
  private static final int PADDING = 4;
  private static final int LINE_HEIGHT = 10;
  private static final int MIN_ROW_HEIGHT = 22;

  @PluginMethod
  public void exportPdf(PluginCall call) {
    String filename = call.getString("filename");
    String content = call.getString("content");
    String title = call.getString("title", "CardNest PDF export");
    if (filename == null || filename.trim().isEmpty() || content == null || content.trim().isEmpty()) {
      call.reject("A filename and PDF content are required.");
      return;
    }
    try {
      File file = outputFile(filename, ".pdf");
      writePdf(file, title, content);
      SavedExport saved = saveToDownloads(file, "application/pdf");
      share(saved.uri, "application/pdf", title);
      resolve(call, saved.path);
    } catch (ActivityNotFoundException error) {
      call.reject("No app can save or share this PDF.");
    } catch (Exception error) {
      call.reject("Unable to export PDF.");
    }
  }

  @PluginMethod
  public void exportCsv(PluginCall call) {
    String filename = call.getString("filename");
    String content = call.getString("content");
    String title = call.getString("title", "CardNest CSV export");
    if (filename == null || filename.trim().isEmpty() || content == null) {
      call.reject("A filename and CSV content are required.");
      return;
    }
    try {
      File file = outputFile(filename, ".csv");
      try (FileOutputStream output = new FileOutputStream(file, false)) {
        output.write(content.getBytes(StandardCharsets.UTF_8));
      }
      SavedExport saved = saveToDownloads(file, "text/csv");
      share(saved.uri, "text/csv", title);
      resolve(call, saved.path);
    } catch (ActivityNotFoundException error) {
      call.reject("No app can save or share this CSV.");
    } catch (Exception error) {
      call.reject("Unable to export CSV.");
    }
  }

  private File outputFile(String filename, String extension) throws Exception {
    File directory = new File(getContext().getCacheDir(), "exports");
    if (!directory.exists() && !directory.mkdirs()) {
      throw new Exception("Unable to prepare export folder.");
    }
    String name = filename.trim().replaceAll("[^a-zA-Z0-9._-]", "_");
    if (name.isEmpty()) name = "cardnest-export" + extension;
    if (!name.toLowerCase().endsWith(extension)) name += extension;
    return new File(directory, name);
  }

  private void resolve(PluginCall call, String path) {
    JSObject result = new JSObject();
    result.put("path", path);
    call.resolve(result);
  }

  private SavedExport saveToDownloads(File source, String mimeType) throws Exception {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ContentValues values = new ContentValues();
      values.put(MediaStore.Downloads.DISPLAY_NAME, source.getName());
      values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
      values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
      values.put(MediaStore.Downloads.IS_PENDING, 1);
      ContentResolver resolver = getContext().getContentResolver();
      Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
      if (uri == null) throw new Exception("Unable to create the Downloads file.");
      try (FileInputStream input = new FileInputStream(source); OutputStream output = resolver.openOutputStream(uri, "w")) {
        if (output == null) throw new Exception("Unable to open the Downloads file.");
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
      }
      values.clear();
      values.put(MediaStore.Downloads.IS_PENDING, 0);
      resolver.update(uri, values, null, null);
      return new SavedExport(uri, "Downloads/" + source.getName());
    }

    File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
    if (!downloads.exists() && !downloads.mkdirs()) throw new Exception("Unable to open Downloads.");
    File target = uniqueFile(downloads, source.getName());
    try (FileInputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(target, false)) {
      byte[] buffer = new byte[8192];
      int read;
      while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
    }
    Uri uri = FileProvider.getUriForFile(
      getContext(),
      getContext().getPackageName() + ".exports.fileprovider",
      target
    );
    return new SavedExport(uri, target.getAbsolutePath());
  }

  private File uniqueFile(File directory, String name) {
    File candidate = new File(directory, name);
    if (!candidate.exists()) return candidate;
    int dot = name.lastIndexOf('.');
    String base = dot > 0 ? name.substring(0, dot) : name;
    String ext = dot > 0 ? name.substring(dot) : "";
    int index = 1;
    while (candidate.exists()) {
      candidate = new File(directory, base + "-" + index + ext);
      index++;
    }
    return candidate;
  }

  private void share(Uri uri, String mimeType, String title) {
    Intent intent = new Intent(Intent.ACTION_SEND);
    intent.setType(mimeType);
    intent.putExtra(Intent.EXTRA_STREAM, uri);
    intent.putExtra(Intent.EXTRA_TITLE, title);
    intent.putExtra(Intent.EXTRA_SUBJECT, title);
    // Android 6+ requires ClipData for FLAG_GRANT_READ_URI_PERMISSION to propagate
    // through the chooser to any app the user selects.
    intent.setClipData(android.content.ClipData.newRawUri("", uri));
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    Intent chooser = Intent.createChooser(intent, title);
    chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    getActivity().startActivity(chooser);
  }

  private void writePdf(File file, String fallbackTitle, String content) throws Exception {
    JSONObject report = new JSONObject(content);
    PdfDocument document = new PdfDocument();
    Paint titlePaint = textPaint(Color.rgb(20, 39, 30), 18, true);
    Paint subtitlePaint = textPaint(Color.rgb(88, 112, 102), 8.5f, false);
    Paint sectionPaint = textPaint(Color.rgb(20, 39, 30), 12, true);
    Paint valuePaint = textPaint(Color.rgb(40, 104, 78), 12, true);
    Paint labelPaint = textPaint(Color.rgb(88, 112, 102), 8, false);
    Paint headerPaint = textPaint(Color.WHITE, 7.5f, true);
    Paint cellPaint = textPaint(Color.rgb(20, 39, 30), 7.4f, false);
    Paint creditPaint = textPaint(Color.rgb(25, 116, 71), 7.4f, true);
    Paint warningPaint = textPaint(Color.rgb(161, 52, 46), 7.4f, false);
    Paint headerFill = fillPaint(Color.rgb(40, 104, 78));
    Paint alternateFill = fillPaint(Color.rgb(245, 248, 245));
    Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    borderPaint.setStyle(Paint.Style.STROKE);
    borderPaint.setStrokeWidth(0.7f);
    borderPaint.setColor(Color.rgb(216, 226, 220));

    PageState page = startPage(document, 1);
    page.canvas.drawText(report.optString("title", fallbackTitle), MARGIN, page.y, titlePaint);
    page.y += 17;
    String subtitle = report.optString("subtitle", "");
    String generated = report.optString("generatedOn", "");
    page.canvas.drawText(subtitle + (generated.isEmpty() ? "" : "  |  Generated " + generated), MARGIN, page.y, subtitlePaint);
    page.y += 18;
    drawSummary(document, page, report.optJSONArray("summary"), valuePaint, labelPaint);
    page.y += 8;

    JSONArray sections = report.optJSONArray("sections");
    if (sections == null || sections.length() == 0) {
      page.canvas.drawText("No data in this period.", MARGIN, page.y, labelPaint);
    } else {
      for (int index = 0; index < sections.length(); index++) {
        JSONObject section = sections.optJSONObject(index);
        if (section == null) continue;
        ensureSpace(document, page, 55);
        page.canvas.drawText(section.optString("title", "Details"), MARGIN, page.y, sectionPaint);
        page.y += 14;
        drawStats(page, section.optJSONArray("stats"), subtitlePaint);
        JSONArray headers = section.optJSONArray("headers");
        JSONArray rows = section.optJSONArray("rows");
        if (headers == null || headers.length() == 0) continue;
        float[] widths = columnWidths(headers.length());
        drawHeader(document, page, headers, widths, headerPaint, borderPaint, headerFill);
        if (rows == null || rows.length() == 0) {
          ensureSpace(document, page, MIN_ROW_HEIGHT);
          page.canvas.drawText("No data in this period.", MARGIN + PADDING, page.y + 14, labelPaint);
          page.y += MIN_ROW_HEIGHT;
          continue;
        }
        for (int rowIndex = 0; rowIndex < rows.length(); rowIndex++) {
          JSONObject row = rows.optJSONObject(rowIndex);
          if (row == null) continue;
          JSONArray cells = row.optJSONArray("cells");
          if (cells == null) continue;
          int height = rowHeight(cells, widths, cellPaint);
          if (page.y + height > BOTTOM) {
            nextPage(document, page);
            drawHeader(document, page, headers, widths, headerPaint, borderPaint, headerFill);
          }
          String state = row.optString("state", "normal");
          Paint rowPaint = "credit".equals(state) ? creditPaint : "warning".equals(state) ? warningPaint : cellPaint;
          drawRow(page, cells, widths, rowPaint, borderPaint, rowIndex % 2 == 1 ? alternateFill : null);
        }
        page.y += 10;
      }
    }
    ensureSpace(document, page, 24);
    page.canvas.drawText("CardNest - Private, local-first money tracking", MARGIN, page.y + 10, subtitlePaint);
    document.finishPage(page.page);
    try (FileOutputStream output = new FileOutputStream(file, false)) {
      document.writeTo(output);
    } finally {
      document.close();
    }
  }

  private void drawSummary(PdfDocument document, PageState page, JSONArray items, Paint value, Paint label) {
    if (items == null || items.length() == 0) return;
    int columns = Math.min(4, items.length());
    int rows = (items.length() + columns - 1) / columns;
    ensureSpace(document, page, rows * 30);
    float width = (float) AVAILABLE_WIDTH / columns;
    int start = page.y;
    for (int index = 0; index < items.length(); index++) {
      JSONObject item = items.optJSONObject(index);
      if (item == null) continue;
      float x = MARGIN + ((index % columns) * width);
      int y = start + ((index / columns) * 30);
      page.canvas.drawText(item.optString("value", "-"), x, y, value);
      page.canvas.drawText(item.optString("label", ""), x, y + 12, label);
    }
    page.y = start + (rows * 30);
  }

  private void drawStats(PageState page, JSONArray stats, Paint paint) {
    if (stats == null || stats.length() == 0) return;
    StringBuilder line = new StringBuilder();
    for (int index = 0; index < stats.length(); index++) {
      JSONObject stat = stats.optJSONObject(index);
      if (stat == null) continue;
      if (line.length() > 0) line.append("   ");
      line.append(stat.optString("label", "")).append(": ").append(stat.optString("value", ""));
    }
    page.canvas.drawText(line.toString(), MARGIN, page.y, paint);
    page.y += 12;
  }

  private void drawHeader(PdfDocument document, PageState page, JSONArray headers, float[] widths, Paint text, Paint border, Paint fill) {
    ensureSpace(document, page, MIN_ROW_HEIGHT * 2);
    drawRow(page, headers, widths, text, border, fill);
  }

  private void drawRow(PageState page, JSONArray cells, float[] widths, Paint text, Paint border, Paint fill) {
    int height = rowHeight(cells, widths, text);
    float x = MARGIN;
    int top = page.y;
    for (int index = 0; index < widths.length; index++) {
      float right = x + widths[index];
      if (fill != null) page.canvas.drawRect(x, top, right, top + height, fill);
      page.canvas.drawRect(x, top, right, top + height, border);
      List<String> lines = wrap(cells.optString(index, ""), text, widths[index] - (PADDING * 2));
      float baseline = top + PADDING - text.ascent();
      for (String line : lines) {
        page.canvas.drawText(line, x + PADDING, baseline, text);
        baseline += LINE_HEIGHT;
      }
      x = right;
    }
    page.y += height;
  }

  private int rowHeight(JSONArray cells, float[] widths, Paint paint) {
    int lines = 1;
    for (int index = 0; index < widths.length; index++) {
      lines = Math.max(lines, wrap(cells.optString(index, ""), paint, widths[index] - (PADDING * 2)).size());
    }
    return Math.max(MIN_ROW_HEIGHT, (lines * LINE_HEIGHT) + (PADDING * 2));
  }

  private List<String> wrap(String value, Paint paint, float maxWidth) {
    List<String> lines = new ArrayList<>();
    String text = value == null ? "" : value.trim();
    if (text.isEmpty()) {
      lines.add("");
      return lines;
    }
    StringBuilder current = new StringBuilder();
    for (String word : text.split("\\\\s+")) {
      String next = current.length() == 0 ? word : current + " " + word;
      if (paint.measureText(next) <= maxWidth) {
        current.setLength(0);
        current.append(next);
      } else {
        if (current.length() > 0) lines.add(current.toString());
        current.setLength(0);
        if (paint.measureText(word) <= maxWidth) {
          current.append(word);
        } else {
          for (int index = 0; index < word.length(); index++) {
            String part = current.toString() + word.charAt(index);
            if (paint.measureText(part) > maxWidth && current.length() > 0) {
              lines.add(current.toString());
              current.setLength(0);
            }
            current.append(word.charAt(index));
          }
        }
      }
    }
    if (current.length() > 0) lines.add(current.toString());
    return lines;
  }

  private float[] columnWidths(int count) {
    float[] widths = new float[count];
    float width = (float) AVAILABLE_WIDTH / count;
    for (int index = 0; index < count; index++) widths[index] = width;
    return widths;
  }

  private Paint textPaint(int colour, float size, boolean bold) {
    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(colour);
    paint.setTextSize(size);
    if (bold) paint.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
    return paint;
  }

  private Paint fillPaint(int colour) {
    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(colour);
    paint.setStyle(Paint.Style.FILL);
    return paint;
  }

  private PageState startPage(PdfDocument document, int number) {
    PageState state = new PageState();
    PdfDocument.PageInfo info = new PdfDocument.PageInfo.Builder(PAGE_WIDTH, PAGE_HEIGHT, number).create();
    state.page = document.startPage(info);
    state.canvas = state.page.getCanvas();
    state.canvas.drawColor(Color.WHITE);
    state.number = number;
    state.y = MARGIN;
    return state;
  }

  private void nextPage(PdfDocument document, PageState state) {
    document.finishPage(state.page);
    PageState next = startPage(document, state.number + 1);
    state.page = next.page;
    state.canvas = next.canvas;
    state.number = next.number;
    state.y = next.y;
  }

  private void ensureSpace(PdfDocument document, PageState state, int height) {
    if (state.y + height > BOTTOM) nextPage(document, state);
  }

  private static class SavedExport {
    final Uri uri;
    final String path;

    SavedExport(Uri uri, String path) {
      this.uri = uri;
      this.path = path;
    }
  }

  private static class PageState {
    PdfDocument.Page page;
    Canvas canvas;
    int number;
    int y;
  }
}
`,
);

writeFileSync(
  filePathsPath,
  `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="card_nest_exports" path="exports/" />
    <external-path name="card_nest_downloads" path="Download/" />
</paths>
`,
);

let mainActivity = readFileSync(mainActivityPath, 'utf8');
if (!/registerPlugin\(CardNestExportPlugin\.class\)/.test(mainActivity)) {
  mainActivity = mainActivity.replace(
    /super\.onCreate\(savedInstanceState\);/,
    'registerPlugin(CardNestExportPlugin.class);\n    super.onCreate(savedInstanceState);',
  );
  writeFileSync(mainActivityPath, mainActivity);
}

let manifest = readFileSync(manifestPath, 'utf8');
if (!/android:authorities="\$\{applicationId\}\.exports\.fileprovider"/.test(manifest)) {
  manifest = manifest.replace(
    /<\/application>/,
    `        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.exports.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/card_nest_file_paths" />
        </provider>
    </application>`,
  );
  writeFileSync(manifestPath, manifest);
}

console.log('CardNest native PDF and CSV export plugin patched.');
