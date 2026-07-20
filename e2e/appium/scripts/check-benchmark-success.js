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
const advisoryFailures = [];
for (const report of reports) {
  const targetFailures = report.advisory ? advisoryFailures : failures;

  if (report.status === "failed" || report.status === "partial") {
    targetFailures.push(
      `${report.device || "device"}: ${report.status} (${report.errorSummary || report.failedStage || "see report"})`
    );
  }

  for (const row of report.rows || []) {
    if (row.status === "failed") {
      targetFailures.push(
        `${report.device || "device"} / ${row.modelDisplayName || row.model}: ${row.errorSummary || row.failedStage || "model failed"}`
      );
    }
  }
}

if (advisoryFailures.length > 0) {
  console.warn(`Advisory benchmark failures:\n${advisoryFailures.join("\n")}`);
}

if (failures.length > 0) {
  throw new Error(`Benchmark failures:\n${failures.join("\n")}`);
}
