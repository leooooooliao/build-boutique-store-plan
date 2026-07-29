#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixtures = path.join(repositoryRoot, "tests", "fixtures");
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "boutique-store-skill-"),
);

function runNode(arguments_, expectedStatus = 0) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== expectedStatus) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(
      `${arguments_.join(" ")} exited ${result.status}; expected ${expectedStatus}`,
    );
  }
}

function reportArguments(file, mode, expectedProducts, expectedTop = 3) {
  return [
    "scripts/validate_report.mjs",
    "--report",
    path.join(fixtures, file),
    "--merchant-window",
    "2026-07-01..2026-07-26",
    "--gcrm-window",
    "2026-06-29..2026-07-28",
    "--generated-date",
    "2026-07-29",
    "--gcrm-mode",
    mode,
    "--expected-gcrm-products",
    String(expectedProducts),
    "--expected-top",
    String(expectedTop),
  ];
}

try {
  for (const relativePath of [
    "scripts/lib.mjs",
    "scripts/validate_input.mjs",
    "scripts/prepare_portfolio.mjs",
    "scripts/validate_report.mjs",
    ".github/scripts/validate_public_package.mjs",
    ".github/scripts/release_asset_downloads.mjs",
  ]) {
    runNode(["--check", relativePath]);
  }

  const commonInput = [
    "--id-data",
    path.join(fixtures, "id.tsv"),
    "--name-data",
    path.join(fixtures, "names.tsv"),
    "--merchant",
    "Synthetic QA Merchant",
    "--currency",
    "各国本币分国展示",
    "--confirm-same-merchant",
    "yes",
    "--confirm-same-period",
    "yes",
    "--merchant-window",
    "2026-07-01..2026-07-26",
    "--gcrm-window",
    "2026-06-29..2026-07-28",
  ];

  runNode(["scripts/validate_input.mjs", ...commonInput, "--json"]);
  runNode([
    "scripts/prepare_portfolio.mjs",
    ...commonInput,
    "--output",
    path.join(temporaryDirectory, "portfolio-audit.json"),
  ]);

  runNode(reportArguments("report-good.md", "verified", 3));
  runNode(reportArguments("report-no-candidate.md", "no-candidate", 0));
  runNode(reportArguments("report-unavailable.md", "unavailable", 0));
  runNode(reportArguments("report-empty-shop.md", "verified", 3), 1);
  runNode(reportArguments("report-bad.md", "verified", 1, 1), 1);

  process.stdout.write("Smoke tests passed.\n");
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
