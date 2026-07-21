const fs = require("node:fs");
const path = require("node:path");

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function slugify(value) {
  return String(value || "device")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function findErrorSummary(logText) {
  const lines = stripAnsi(logText).split(/\r?\n/).filter(Boolean);
  const priorityPatterns = [
    /Timed out after \d+ minutes/i,
    /Timed out waiting/i,
    /^(?:\[[^\]]+\]\s*)?Error:\s*(?!Timeout)/i,
    /Error in "/i,
    /^Error:\s*Timeout/i,
  ];
  const usefulPatterns = [
    /App showed error-banner/i,
    /Timed out waiting/i,
    /Timed out after \d+ minutes/i,
    /still not enabled/i,
    /waitForEnabled/i,
    /no such element/i,
    /invalid element state/i,
    /Session deleted/i,
    /ECONNRESET/i,
    /Error:/i,
    /Timeout/i,
  ];
  const noisyPatterns = [
    /Spec Files:/i,
    /^\s*FAILED\s+in/i,
    /^\s*at\s+/i,
    /stacktrace:/i,
    /node:internal/i,
    /listOnTimeout/i,
    /processTimers/i,
  ];

  const isUseful = (candidate, patterns) =>
    patterns.some((pattern) => pattern.test(candidate)) &&
    !noisyPatterns.some((pattern) => pattern.test(candidate));

  const priorityLine = lines
    .slice()
    .reverse()
    .find((candidate) => isUseful(candidate, priorityPatterns));

  if (priorityLine) {
    return priorityLine.trim().slice(0, 280);
  }

  const line = lines
    .slice()
    .reverse()
    .find((candidate) => isUseful(candidate, usefulPatterns));

  return line
    ? line.trim().slice(0, 280)
    : "The Appium benchmark step failed before benchmark rows were collected.";
}

function readLog() {
  const logPath = path.join(process.cwd(), "reports", "appium-output.log");
  if (!fs.existsSync(logPath)) {
    return "";
  }

  return fs.readFileSync(logPath, "utf8");
}

function normalizeLogLine(line) {
  return String(line || "")
    .replace(/^\[\d+-\d+\]\s*/, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+INFO\s+webdriver:\s+RESULT\s+/, "")
    .replace(/,\s*benchmark-json-display\s*$/, "");
}

function updateBraceBalance(line, balance) {
  let inString = false;
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;
    if (char === "{") balance += 1;
    if (char === "}") balance -= 1;
  }

  return balance;
}

function extractLastBenchmarkReport(logText) {
  const reports = [];
  let current = [];
  let balance = 0;

  for (const rawLine of stripAnsi(logText).split(/\r?\n/)) {
    const line = normalizeLogLine(rawLine);

    if (current.length === 0) {
      if (!line.startsWith("{")) continue;
      current = [line];
      balance = updateBraceBalance(line, 0);
    } else {
      current.push(line);
      balance = updateBraceBalance(line, balance);
    }

    if (current.length > 0 && balance === 0) {
      const candidate = current.join("\n");
      current = [];
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.rows)) {
          reports.push(parsed);
        }
      } catch {
        // Appium logs contain many JSON-like fragments; only benchmark reports matter.
      }
    }
  }

  return reports.at(-1) || null;
}

function markRecoveredReportFailed(report, failureSummary) {
  return {
    ...report,
    status: "partial",
    finishedAt: report.finishedAt || null,
    rows: (report.rows || []).map((row) => {
      if (row.status === "passed" || row.status === "failed") {
        return row;
      }

      return {
        ...row,
        status: "failed",
        failedStage: row.failedStage || "Benchmark timeout",
        errorSummary: `${row.errorSummary || "Model did not finish."} ${failureSummary}`.trim(),
      };
    }),
  };
}

function numberFromEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : null;
}

function main() {
  const logText = readLog();
  const device = process.env.TESTMU_DEVICE || "device";
  const target = process.env.TESTMU_TARGET || "app";
  const browserName = process.env.TESTMU_BROWSER_NAME || null;
  const platformName = process.env.TESTMU_PLATFORM_NAME || "Android";
  const startedAtMs = numberFromEnv("BENCHMARK_STARTED_AT_MS");
  const finishedAtMs = numberFromEnv("BENCHMARK_FINISHED_AT_MS") || Date.now();
  const totalRuntimeSeconds =
    numberFromEnv("BENCHMARK_TOTAL_RUNTIME_SECONDS") ||
    (startedAtMs
      ? Number(((finishedAtMs - startedAtMs) / 1000).toFixed(3))
      : null);
  const workflowRunUrl = process.env.GITHUB_RUN_URL || null;
  const logHint = workflowRunUrl
    ? `Open the workflow run logs and select the "${device}" benchmark job.`
    : "Open this benchmark job log in GitHub Actions for the full Appium output.";
  const sampleText = process.env.TESTMU_SAMPLE_TEXT || null;

  const recoveredReport = extractLastBenchmarkReport(logText);
  const baseReport = recoveredReport
    ? markRecoveredReportFailed(recoveredReport, findErrorSummary(logText))
    : {
        schemaVersion: 1,
        status: "failed",
        sampleText,
        characterLength: sampleText ? Array.from(sampleText).length : null,
        rows: [],
      };

  const report = {
    ...baseReport,
    schemaVersion: 1,
    target,
    status: recoveredReport ? "partial" : "failed",
    failedStage:
      process.env.BENCHMARK_FAILED_STAGE ||
      `Run TestMu ${platformName} benchmark`,
    errorSummary: findErrorSummary(logText),
    errorDetails: logHint,
    logUrl: workflowRunUrl,
    device,
    platformName,
    platformVersion: process.env.TESTMU_PLATFORM_VERSION || null,
    browserName,
    browserVersion: process.env.TESTMU_BROWSER_VERSION || null,
    requestedBrowserName: browserName,
    webUrl: process.env.TESTMU_WEB_URL || null,
    tunnelName: process.env.TESTMU_TUNNEL_NAME || null,
    realDevice: process.env.TESTMU_REAL_DEVICE !== "false",
    sessionId: null,
    githubRunId: process.env.GITHUB_RUN_ID || null,
    githubSha: process.env.TESTMU_GITHUB_SHA || process.env.GITHUB_SHA || null,
    deviceStartedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
    deviceFinishedAt: new Date(finishedAtMs).toISOString(),
    totalRuntimeSeconds,
    capturedAt: new Date().toISOString(),
    sampleText: baseReport.sampleText || sampleText,
    characterLength:
      baseReport.characterLength ||
      (sampleText ? Array.from(sampleText).length : null),
    rows: baseReport.rows || [],
  };

  fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
  const filePrefix =
    target === "web"
      ? `web-${slugify(device)}-${slugify(browserName || "browser")}`
      : slugify(device);
  fs.writeFileSync(
    path.join(process.cwd(), "reports", `${filePrefix}.json`),
    `${JSON.stringify(report, null, 2)}\n`
  );
}

main();
