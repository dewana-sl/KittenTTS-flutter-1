const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_EXPECTED_MODELS = [
  "kitten-tts-nano-0.8",
  "kitten-tts-nano-0.8-int8",
  "kitten-tts-micro-0.8",
  "kitten-tts-mini-0.8",
];
const EXPECTED_MODELS = resolveExpectedModels();
const EXPECTED_WARM_RUNS = Number(process.env.TESTMU_EXPECTED_WARM_RUNS || 5);
const EXPECTED_MODEL_DISPLAY_NAMES = new Map([
  ["kitten-tts-nano-0.8", "Nano (fp32)"],
  ["kitten-tts-nano-0.8-int8", "Nano (int8)"],
  ["kitten-tts-micro-0.8", "Micro"],
  ["kitten-tts-mini-0.8", "Mini"],
]);
const BENCHMARK_REPORT_TIMEOUT_MS = Number(
  process.env.TESTMU_BENCHMARK_REPORT_TIMEOUT_MS || 30 * 60 * 1000
);
const APP_READY_TIMEOUT_MS = Number(
  process.env.TESTMU_APP_READY_TIMEOUT_MS || 6 * 60 * 1000
);
const ANDROID_APP_PACKAGE =
  process.env.TESTMU_ANDROID_APP_PACKAGE || "com.kittenml.app";

function slugify(value) {
  return String(value || "device")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function automationSlug(value) {
  return slugify(value);
}

function resolveExpectedModels() {
  const requested = String(process.env.TESTMU_EXPECTED_MODELS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return requested.length > 0 ? requested : DEFAULT_EXPECTED_MODELS;
}

function parseBenchmarkJson(rawText) {
  const jsonStart = rawText.indexOf("{");
  const jsonEnd = rawText.lastIndexOf("}");

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error(`benchmark-json did not contain JSON: ${rawText}`);
  }

  return JSON.parse(rawText.slice(jsonStart, jsonEnd + 1));
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function hasFinishedBenchmark(report) {
  return Boolean(report?.finishedAt);
}

function expectedModelDisplayName(model) {
  return EXPECTED_MODEL_DISPLAY_NAMES.get(model) || model;
}

async function readBenchmarkReport(accessibilityId) {
  for (const candidateId of [accessibilityId, "benchmark-json-visible"]) {
    try {
      const reportText = await readElementText(candidateId);
      return parseBenchmarkJson(reportText);
    } catch {
      // Try the visible JSON block if the compact automation node has no value.
    }
  }

  try {
    return parseBenchmarkJson(decodeXmlEntities(await browser.getPageSource()));
  } catch {
    // No JSON was visible in the current Android accessibility tree.
  }

  return null;
}

function isIosSession() {
  return /ios/i.test(
    String(
      browser?.capabilities?.platformName ||
        browser?.requestedCapabilities?.platformName ||
        getPlatformName()
    )
  );
}

function isAndroidSession() {
  return /android/i.test(
    String(
      browser?.capabilities?.platformName ||
        browser?.requestedCapabilities?.platformName ||
        getPlatformName()
    )
  );
}

function androidUiSelectorText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function androidSemanticsLabelRegex(accessibilityId) {
  return `(?s)(^|.*, )${regexEscape(accessibilityId)}($|[,\\n].*)`;
}

function automationSelectors(accessibilityId) {
  const selectors = [`~${accessibilityId}`];
  if (isAndroidSession()) {
    selectors.push(
      `android=new UiSelector().descriptionStartsWith("${androidUiSelectorText(
        `${accessibilityId}:`
      )}")`,
      `android=new UiSelector().descriptionMatches("${androidUiSelectorText(
        androidSemanticsLabelRegex(accessibilityId)
      )}")`
    );
  }
  return selectors;
}

async function findElementByAutomationId(accessibilityId) {
  for (const selector of automationSelectors(accessibilityId)) {
    try {
      const element = await $(selector);
      if (await element.isDisplayed()) {
        return element;
      }
    } catch {
      // Try the platform fallback selector next.
    }
  }

  return null;
}

async function findReadableElementByAutomationId(accessibilityId) {
  for (const selector of automationSelectors(accessibilityId)) {
    try {
      const element = await $(selector);
      if (element?.elementId) {
        return element;
      }
    } catch {
      // Try the platform fallback selector next.
    }
  }

  return null;
}

async function activateAndroidBenchmarkApp() {
  if (!isAndroidSession() || typeof browser.activateApp !== "function") {
    return;
  }

  try {
    await browser.activateApp(ANDROID_APP_PACKAGE);
  } catch (error) {
    console.warn(
      `[KittenTTS benchmark] Could not activate ${ANDROID_APP_PACKAGE}: ${error.message}`
    );
  }
}

async function dismissAndroidSystemDialog() {
  if (!isAndroidSession()) {
    return false;
  }

  const selectors = [
    "id=android:id/button3",
    "id=android:id/button1",
    "id=android:id/button2",
    'android=new UiSelector().textMatches("(?i)^(OK|Got it|Close|Dismiss)$")',
  ];

  for (const selector of selectors) {
    try {
      const element = await $(selector);
      if (await element.isDisplayed()) {
        const text = (await element.getText().catch(() => selector)) || selector;
        console.log(`[KittenTTS benchmark] Dismissing Android dialog: ${text}`);
        await element.click();
        await browser.pause(1000);
        await activateAndroidBenchmarkApp();
        return true;
      }
    } catch {
      // Most devices will not show a blocking system dialog. Keep polling.
    }
  }

  return false;
}

async function dismissKeyboardIfNeeded() {
  try {
    if (typeof browser.hideKeyboard === "function") {
      await browser.hideKeyboard();
      await browser.pause(500);
      return;
    }
  } catch {
    // Some Android sessions report no keyboard even after text entry.
  }

  if (isAndroidSession()) {
    try {
      await browser.pressKeyCode(4);
      await browser.pause(500);
    } catch {
      // The keyboard may already be dismissed.
    }
  }
}

function usableElementText(candidate, accessibilityId) {
  const text = String(candidate || "");
  return text.length > 0 && text !== accessibilityId ? text : "";
}

function stripFlutterSemanticsLabel(value, accessibilityId) {
  let text = String(value || "");
  const prefix = `${accessibilityId}:`;
  if (text.startsWith(prefix)) {
    text = text.slice(prefix.length);
  }
  const newlinePrefix = `${accessibilityId}\n`;
  if (text.startsWith(newlinePrefix)) {
    text = text.slice(newlinePrefix.length);
  }
  const commaPrefix = `${accessibilityId}, `;
  if (text.startsWith(commaPrefix)) {
    text = text.slice(commaPrefix.length);
  }
  const marker = `, ${accessibilityId}`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    text = text.slice(0, markerIndex);
  }
  return text.trim();
}

function shouldOverrideSampleText(currentText, sampleText) {
  if (process.env.TESTMU_SKIP_SAMPLE_OVERRIDE === "true") {
    return false;
  }

  if (!sampleText) {
    return false;
  }

  const normalizedCurrentText = String(currentText || "").trim();
  return normalizedCurrentText !== sampleText;
}

async function readElementText(accessibilityId) {
  const element = await findReadableElementByAutomationId(accessibilityId);
  if (!element) {
    return "";
  }

  const firstText = usableElementText(
    await element.getText().catch(() => ""),
    accessibilityId
  );

  if (firstText) {
    return firstText;
  }

  const attributeNames = isIosSession()
    ? ["label", "value", "name"]
    : ["text", "content-desc", "contentDescription", "name", "hint"];

  for (const attributeName of attributeNames) {
    const attributeText = usableElementText(
      await element.getAttribute(attributeName).catch(() => ""),
      accessibilityId
    );

    if (attributeText) {
      return attributeText;
    }
  }

  return "";
}

function shouldUseAudioPager(report) {
  const mode = String(
    process.env.TESTMU_AUDIO_EXTRACTION_MODE || "auto"
  ).toLowerCase();
  if (mode === "pager") return true;
  if (mode === "direct") return false;
  if (isIosSession()) return false;

  const version = Number.parseFloat(
    String(
      report?.platformVersion ||
        browser?.capabilities?.platformVersion ||
        browser?.requestedCapabilities?.platformVersion ||
        process.env.TESTMU_ANDROID_VERSION ||
        ""
    )
  );

  return !Number.isFinite(version) || version < 12;
}

function countExpectedAudioChunks(report) {
  return (report.rows || []).reduce(
    (total, row) =>
      row.status === "passed" ? total + Number(row.werAudioChunkCount || 0) : total,
    0
  );
}

async function attachWerAudioChunks(report) {
  const rows = [];
  const usePager = shouldUseAudioPager(report);
  const extractionMode = usePager ? "pager" : "direct";

  console.log(
    `Using ${extractionMode} WER audio extraction for ${report.device || "device"} ` +
      `(${report.platformName || "platform"} ${report.platformVersion || "unknown"}), ` +
      `${countExpectedAudioChunks(report)} chunk(s).`
  );

  if (usePager) {
    return attachWerAudioChunksFromPager(report);
  }

  try {
    return await attachWerAudioChunksDirect(report);
  } catch (error) {
    if (
      isIosSession() ||
      process.env.TESTMU_AUDIO_EXTRACTION_MODE === "direct"
    ) {
      throw error;
    }

    console.warn(
      `Direct WER audio extraction failed, falling back to pager: ${error.message}`
    );
    return attachWerAudioChunksFromPager(report);
  }
}

async function attachWerAudioChunksDirect(report) {
  const rows = [];

  for (const row of report.rows || []) {
    if (row.status !== "passed") {
      rows.push(row);
      continue;
    }

    const chunkCount = Number(row.werAudioChunkCount || 0);
    if (chunkCount <= 0) {
      rows.push(row);
      continue;
    }

    const rowSlug = automationSlug(row.model);
    const chunks = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const accessibilityId = `benchmark-audio-${rowSlug}-${index}`;
      const chunk = stripFlutterSemanticsLabel(
        await readElementText(accessibilityId),
        accessibilityId
      );
      if (!chunk) {
        throw new Error(
          `Missing WER audio chunk ${index + 1}/${chunkCount} for ${row.model} (${accessibilityId}).`
        );
      }
      chunks.push(chunk);
    }

    const werAudioBase64 = chunks.join("");
    if (
      Number.isFinite(row.werAudioBase64Length) &&
      werAudioBase64.length !== row.werAudioBase64Length
    ) {
      throw new Error(
        `WER audio length mismatch for ${row.model}: expected ${row.werAudioBase64Length}, got ${werAudioBase64.length}.`
      );
    }

    rows.push({
      ...row,
      werAudioBase64,
    });
  }

  return {
    ...report,
    rows,
  };
}

async function attachWerAudioChunksFromPager(report) {
  const rows = [];
  const expectedChunks = [];

  for (const row of report.rows || []) {
    if (row.status !== "passed") {
      continue;
    }

    const chunkCount = Number(row.werAudioChunkCount || 0);
    const rowSlug = automationSlug(row.model);
    for (let index = 0; index < chunkCount; index += 1) {
      expectedChunks.push({
        key: `${rowSlug}-${index}`,
        row,
        index,
        chunkCount,
      });
    }
  }

  const chunksByModel = new Map(
    (report.rows || []).map((row) => [row.model, []])
  );

  for (let globalIndex = 0; globalIndex < expectedChunks.length; globalIndex += 1) {
    const expected = expectedChunks[globalIndex];
    await waitForAudioPagerKey(expected.key, globalIndex, expectedChunks.length);

    const chunk = stripFlutterSemanticsLabel(
      await readElementText("benchmark-audio-current"),
      "benchmark-audio-current"
    );
    if (!chunk) {
      throw new Error(
        `Missing WER audio chunk ${expected.index + 1}/${expected.chunkCount} for ${expected.row.model} (${expected.key}).`
      );
    }

    chunksByModel.get(expected.row.model).push(chunk);

    if (globalIndex < expectedChunks.length - 1) {
      const nextButton = await findElementByAutomationId("benchmark-audio-next");
      if (!nextButton) {
        throw new Error("Missing WER audio pager next button.");
      }
      await nextButton.click();
    }
  }

  for (const row of report.rows || []) {
    if (row.status !== "passed") {
      rows.push(row);
      continue;
    }

    const chunks = chunksByModel.get(row.model) || [];
    const werAudioBase64 = chunks.join("");
    if (
      Number.isFinite(row.werAudioBase64Length) &&
      werAudioBase64.length !== row.werAudioBase64Length
    ) {
      throw new Error(
        `WER audio length mismatch for ${row.model}: expected ${row.werAudioBase64Length}, got ${werAudioBase64.length}.`
      );
    }

    rows.push({
      ...row,
      werAudioBase64,
    });
  }

  return {
    ...report,
    rows,
  };
}

async function waitForAudioPagerKey(expectedKey, globalIndex, totalChunks) {
  const startedAt = Date.now();
  let lastKey = "";

  while (Date.now() - startedAt < 10_000) {
    lastKey = stripFlutterSemanticsLabel(
      await readElementText("benchmark-audio-current-key"),
      "benchmark-audio-current-key"
    );
    if (lastKey === expectedKey) {
      return;
    }

    await browser.pause(250);
  }

  throw new Error(
    `WER audio pager mismatch at chunk ${globalIndex + 1}/${totalChunks}: expected ${expectedKey}, got ${lastKey || "empty"}.`
  );
}

async function getBenchmarkReportFromUi({ includeAudio = false } = {}) {
  const report = await readBenchmarkReport("benchmark-json-display");

  if (!report || !includeAudio) {
    return report;
  }

  return attachWerAudioChunks(report);
}

function markPartialReport(report, timeoutMessage) {
  const sourceRows = Array.isArray(report.rows) ? report.rows : [];
  const rows = EXPECTED_MODELS.map((model) => {
    const row =
      sourceRows.find(
        (candidate) => candidate.model === model || candidate.modelId === model
      ) || null;

    if (!row) {
      return {
        model,
        modelId: model,
        modelDisplayName: expectedModelDisplayName(model),
        status: "failed",
        failedStage: "Benchmark timeout",
        errorSummary: `Model did not finish before the device session ended. ${timeoutMessage}`,
      };
    }

    if (row.status !== "failed") {
      return row;
    }

    const summary = String(row.errorSummary || "");
    if (
      !/did not run|did not finish|in progress|session ended/i.test(summary)
    ) {
      return row;
    }

    return {
      ...row,
      failedStage: row.failedStage || "Benchmark timeout",
      errorSummary: `${summary} ${timeoutMessage}`.trim(),
    };
  });

  return {
    ...report,
    status: "partial",
    finishedAt: report.finishedAt || null,
    rows,
  };
}

function getDeviceName() {
  return (
    process.env.TESTMU_DEVICE ||
    process.env.TESTMU_ANDROID_DEVICE ||
    process.env.TESTMU_IOS_DEVICE ||
    "Pixel 5"
  );
}

function getPlatformName() {
  return (
    browser?.capabilities?.platformName ||
    browser?.requestedCapabilities?.platformName ||
    process.env.TESTMU_PLATFORM_NAME ||
    (process.env.TESTMU_IOS_DEVICE ? "iOS" : "Android")
  );
}

function getCapabilityPlatformVersion() {
  return (
    browser?.capabilities?.platformVersion ||
    browser?.capabilities?.platform_version ||
    browser?.capabilities?.osVersion ||
    browser?.capabilities?.os_version ||
    browser?.requestedCapabilities?.platformVersion ||
    browser?.requestedCapabilities?.platform_version ||
    null
  );
}

function getPlatformVersion() {
  return (
    getCapabilityPlatformVersion() ||
    process.env.TESTMU_PLATFORM_VERSION ||
    process.env.TESTMU_ANDROID_VERSION ||
    process.env.TESTMU_IOS_VERSION ||
    "12"
  );
}

function writeDeviceReport(report, startedAtMs) {
  const device = getDeviceName();
  const finishedAtMs = Date.now();
  const outputDir = path.resolve(__dirname, "..", "reports");
  fs.mkdirSync(outputDir, { recursive: true });

  const payload = {
    device,
    platformName: getPlatformName(),
    platformVersion: getPlatformVersion(),
    requestedPlatformVersion:
      process.env.TESTMU_PLATFORM_VERSION ||
      process.env.TESTMU_ANDROID_VERSION ||
      process.env.TESTMU_IOS_VERSION ||
      null,
    realDevice: process.env.TESTMU_REAL_DEVICE !== "false",
    sessionId: browser.sessionId,
    githubRunId: process.env.GITHUB_RUN_ID || null,
    githubSha: process.env.GITHUB_SHA || null,
    deviceStartedAt: new Date(startedAtMs).toISOString(),
    deviceFinishedAt: new Date(finishedAtMs).toISOString(),
    totalRuntimeMs: finishedAtMs - startedAtMs,
    totalRuntimeSeconds: Number(
      ((finishedAtMs - startedAtMs) / 1000).toFixed(3)
    ),
    capturedAt: new Date().toISOString(),
    ...report,
  };

  const outputPath = path.join(outputDir, `${slugify(device)}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function getOptionalText(accessibilityId) {
  try {
    const element = await findElementByAutomationId(accessibilityId);
    return element ? await readTextFromElement(element, accessibilityId) : null;
  } catch {
    return null;
  }

  return null;
}

async function isDisplayed(accessibilityId) {
  try {
    return Boolean(await findElementByAutomationId(accessibilityId));
  } catch {
    return false;
  }
}

async function findDisplayedElement(selectors) {
  for (const selector of selectors) {
    try {
      const element = await $(selector);
      if (await element.isDisplayed()) {
        return element;
      }
    } catch {
      // Flutter can expose the same widget differently across platforms.
    }
  }

  return null;
}

async function findBenchmarkTextInput() {
  const selectors = automationSelectors("tts-input");
  if (isAndroidSession()) {
    selectors.push('android=new UiSelector().className("android.widget.EditText")');
  }

  return findDisplayedElement(selectors);
}

async function readTextFromElement(element, fallbackId) {
  const firstText = usableElementText(
    await element.getText().catch(() => ""),
    fallbackId
  );

  if (firstText) {
    return firstText;
  }

  const attributeNames = isIosSession()
    ? ["label", "value", "name"]
    : ["text", "content-desc", "contentDescription", "name", "hint"];

  for (const attributeName of attributeNames) {
    const attributeText = usableElementText(
      await element.getAttribute(attributeName).catch(() => ""),
      fallbackId
    );

    if (attributeText) {
      return attributeText;
    }
  }

  return "";
}

async function getPageSourceSummary() {
  try {
    const source = await browser.getPageSource();
    return source
      .replace(/\s+/g, " ")
      .slice(0, 2000);
  } catch (error) {
    return `Could not read page source: ${error.message}`;
  }
}

async function collectAndroidFailureContext() {
  if (!isAndroidSession()) {
    return "";
  }

  const details = [];
  try {
    details.push(`Current package: ${await browser.getCurrentPackage()}`);
  } catch (error) {
    details.push(`Current package unavailable: ${error.message}`);
  }

  try {
    const sourceSummary = await getPageSourceSummary();
    details.push(`Page source: ${sourceSummary}`);
  } catch {
    // getPageSourceSummary already protects itself.
  }

  try {
    const logs = await browser.getLogs("logcat");
    const interesting = logs
      .map((entry) => String(entry.message || entry))
      .filter((line) =>
        /AndroidRuntime|FATAL EXCEPTION|com\.kittenml|kittentts|flutter|onnx|ort|libc|crash/i.test(
          line
        )
      )
      .slice(-120);
    if (interesting.length > 0) {
      const logcat = interesting.join("\n");
      fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
      fs.writeFileSync(
        path.join(process.cwd(), "reports", "android-logcat-tail.log"),
        `${logcat}\n`
      );
      details.push(`Logcat tail:\n${logcat.slice(-4000)}`);
    } else {
      details.push("Logcat tail: no matching AndroidRuntime/Flutter/ORT lines.");
    }
  } catch (error) {
    details.push(`Logcat unavailable: ${error.message}`);
  }

  return details.join("\n");
}

async function waitForAppReady(timeoutMs) {
  const startedAt = Date.now();
  let lastStatus = "No app status captured yet.";

  await activateAndroidBenchmarkApp();

  while (Date.now() - startedAt < timeoutMs) {
    if (await dismissAndroidSystemDialog()) {
      continue;
    }

    const errorMessage = await getOptionalText("error-message");
    if (errorMessage) {
      throw new Error(`App showed error-banner before benchmark: ${errorMessage}`);
    }

    const statusLabel = await getOptionalText("status-label");
    if (statusLabel && statusLabel !== lastStatus) {
      lastStatus = statusLabel;
      console.log(`[KittenTTS app status] ${statusLabel}`);
    }

    const benchmark = await findElementByAutomationId("benchmark-button");
    if (
      benchmark &&
      (await benchmark.isEnabled().catch(() => false))
    ) {
      return benchmark;
    }

    await browser.pause(5000);
  }

  const sourceSummary = await getPageSourceSummary();
  throw new Error(
    `Timed out waiting for app readiness after ${timeoutMs}ms. Last app status: ${lastStatus}. Page source: ${sourceSummary}`
  );
}

async function waitForBenchmarkReport(timeoutMs) {
  const startedAt = Date.now();
  let lastStatus = "No app status captured yet.";
  let lastReport = null;

  while (Date.now() - startedAt < timeoutMs) {
    const report = await getBenchmarkReportFromUi();
    if (report) {
      lastReport = report;
      if (hasFinishedBenchmark(report)) {
        return (await getBenchmarkReportFromUi({ includeAudio: true })) || report;
      }
    }

    const errorMessage = await getOptionalText("error-message");
    if (errorMessage) {
      throw new Error(`App showed error-banner: ${errorMessage}`);
    }

    const statusLabel = await getOptionalText("status-label");
    if (statusLabel && statusLabel !== lastStatus) {
      lastStatus = statusLabel;
      console.log(`[KittenTTS benchmark status] ${statusLabel}`);
    }

    await browser.pause(5000);
  }

  const timeoutMessage = `Timed out waiting for benchmark-report. Last app status: ${lastStatus}`;
  if (lastReport) {
    return markPartialReport(lastReport, timeoutMessage);
  }

  const failureContext = await collectAndroidFailureContext();
  throw new Error(
    failureContext ? `${timeoutMessage}\n${failureContext}` : timeoutMessage
  );
}

describe("KittenTTS Flutter benchmark", () => {
  it("benchmarks every bundled model and writes a device report", async () => {
    const deviceStartedAtMs = Date.now();
    let benchmark = await waitForAppReady(APP_READY_TIMEOUT_MS);

    const sampleText = process.env.TESTMU_SAMPLE_TEXT;
    if (sampleText) {
      const input = await findBenchmarkTextInput();
      const currentText = input
        ? await readTextFromElement(input, "tts-input")
        : "";
      if (shouldOverrideSampleText(currentText, sampleText)) {
        try {
          await input.click();
          await input.clearValue();
          await input.setValue(sampleText);
        } catch (error) {
          console.warn(
            `[KittenTTS benchmark] Could not override sample text; continuing with the app default. ${error.message}`
          );
        }
        await dismissKeyboardIfNeeded();
        benchmark =
          (await findElementByAutomationId("benchmark-button")) ||
          (await waitForAppReady(60_000));
      } else {
        console.log(
          `[KittenTTS benchmark] Using app sample text; Appium reported "${currentText || "<empty>"}".`
        );
      }
    }

    await benchmark.click();
    if (isAndroidSession()) {
      try {
        console.log(
          `[KittenTTS benchmark] Package after benchmark tap: ${await browser.getCurrentPackage()}`
        );
      } catch (error) {
        console.warn(
          `[KittenTTS benchmark] Could not read package after benchmark tap: ${error.message}`
        );
      }

      const immediateReport = await getBenchmarkReportFromUi();
      if (immediateReport) {
        console.log(
          `[KittenTTS benchmark] Immediate report status after tap: ${immediateReport.status || "unknown"}`
        );
      } else {
        console.log("[KittenTTS benchmark] No immediate report after tap.");
      }
    }

    const report = await waitForBenchmarkReport(BENCHMARK_REPORT_TIMEOUT_MS);

    expect(report.schemaVersion).toBe(1);
    expect(report.sampleText.length).toBeGreaterThan(0);
    expect(report.characterLength).toBeGreaterThan(0);
    if (report.rows.length !== EXPECTED_MODELS.length) {
      throw new Error(
        `Benchmark report has ${report.rows.length} model rows, expected ${EXPECTED_MODELS.length}. Models: ${report.rows
          .map((row) => row.model || row.modelId || row.modelDisplayName)
          .join(", ")}`
      );
    }

    for (const expectedModel of EXPECTED_MODELS) {
      const row = report.rows.find(
        (candidate) => candidate.model === expectedModel
      );

      if (!row) {
        throw new Error(`Missing benchmark row for model: ${expectedModel}`);
      }
      if (!["passed", "failed"].includes(row.status)) {
        throw new Error(
          `Invalid status for ${expectedModel}: ${String(row.status)}`
        );
      }

      if (row.status === "passed") {
        expect(row.generationMs).toBeGreaterThan(0);
        expect(row.generationSeconds).toBeGreaterThan(0);
        expect(row.firstGenerationMs).toBeGreaterThan(0);
        expect(row.firstGenerationSeconds).toBeGreaterThan(0);
        expect(row.warmRunCount).toBe(EXPECTED_WARM_RUNS);
        expect(row.warmGenerationMs.length).toBe(EXPECTED_WARM_RUNS);
        expect(row.warmRtf.length).toBe(EXPECTED_WARM_RUNS);
        expect(row.warmP50GenerationMs).toBeGreaterThan(0);
        expect(row.warmP95GenerationMs).toBeGreaterThan(0);
        expect(row.warmP50Rtf).toBeGreaterThan(0);
        expect(row.warmP95Rtf).toBeGreaterThan(0);
        expect(row.durationSeconds).toBeGreaterThan(0);
        expect(row.rtf).toBeGreaterThan(0);
        expect(row.sampleCount).toBeGreaterThan(0);
        expect(row.sampleRate).toBe(24000);
        if (!/^[0-9a-f]{8}$/.test(row.sampleHash)) {
          throw new Error(
            `Invalid sample hash for ${expectedModel}: ${row.sampleHash}`
          );
        }
        if (process.env.TESTMU_REQUIRE_WER_AUDIO === "true") {
          expect(row.werReferenceText).toBe(report.sampleText);
          expect(row.werAudioFormat).toBe("wav-base64");
          expect(row.werAudioSampleRate).toBe(24000);
          expect(row.werAudioChunkCount).toBeGreaterThan(0);
          expect(row.werAudioBase64Length).toBeGreaterThan(1000);
          if (typeof row.werAudioBase64 !== "string") {
            throw new Error(
              `Missing attached WER audio for ${expectedModel}; expected ${row.werAudioChunkCount} chunk(s) and ${row.werAudioBase64Length} base64 characters.`
            );
          }
          expect(row.werAudioBase64.length).toBe(row.werAudioBase64Length);
          expect(row.parakeetStatus).toBe("pending");
        }
      } else {
        expect(row.failedStage.length).toBeGreaterThan(0);
        expect(row.errorSummary.length).toBeGreaterThan(0);
      }
    }

    writeDeviceReport(report, deviceStartedAtMs);

    const failedRows = report.rows.filter((row) => row.status === "failed");
    if (report.status === "partial" || failedRows.length > 0) {
      throw new Error(
        `Benchmark completed with ${failedRows.length} failed model row(s). See uploaded device report for row-level errors.`
      );
    }
  });
});
