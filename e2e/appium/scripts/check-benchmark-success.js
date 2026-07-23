const fs = require("node:fs");
const path = require("node:path");

const summaryPath = path.resolve(
  process.argv[2] || "benchmark-report/summary.json"
);

if (!fs.existsSync(summaryPath)) {
  throw new Error(`Missing benchmark summary JSON: ${summaryPath}`);
}

const payload = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const reports = Array.isArray(payload.reports) ? payload.reports : [];

if (reports.length === 0) {
  throw new Error("No benchmark reports were collected.");
}

const failures = [];
for (const report of reports) {
  if (report.allowedFailure) {
    continue;
  }

  if (report.status === "failed" || report.status === "partial") {
    failures.push(
      `${report.device || "device"}: ${report.status} (${report.errorSummary || report.failedStage || "see report"})`
    );
  }

  for (const row of report.rows || []) {
    if (row.status === "failed") {
      failures.push(
        `${report.device || "device"} / ${row.modelDisplayName || row.model}: ${row.errorSummary || row.failedStage || "model failed"}`
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Benchmark failures:\n${failures.join("\n")}`);
}
