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

function validateReadme() {
  const readme = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");
  const requiredFragments = [
    "img.shields.io/github/downloads/leooooooliao/build-boutique-store-plan/total",
    "hits.sh/github.com/leooooooliao/build-boutique-store-plan.svg",
    "github/issues-search",
    "给任意 AI 的安装提示词",
    "第一次使用",
    "不得假装安装成功",
    "Amy 与 Mira 的浏览器授权",
    "不要选择云端浏览器授权",
    "完整报告必须实际查询营销参谋",
    "同一个 Excel 的两个 Sheet",
    "直接在对话中分两段粘贴",
    "达人找不到清晰的合作主题",
  ];
  const missing = requiredFragments.filter((fragment) => !readme.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`README is missing required fragments: ${missing.join(", ")}`);
  }
}

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

try {
  validateReadme();

  for (const relativePath of [
    "scripts/lib.mjs",
    "scripts/validate_input.mjs",
    "scripts/prepare_portfolio.mjs",
    "scripts/validate_plan_evidence.mjs",
    "scripts/validate_report.mjs",
    "dependencies/gcrm-core/validate-evidence.mjs",
    "tests/data_regression.mjs",
    "tests/validate_report.test.mjs",
    ".github/scripts/validate_public_package.mjs",
    ".github/scripts/release_asset_downloads.mjs",
  ]) {
    runNode(["--check", relativePath]);
  }

  runNode(["tests/data_regression.mjs"]);
  runNode(["tests/validate_report.test.mjs"]);

  const commonInput = [
    "--id-data",
    path.join(fixtures, "id.tsv"),
    "--name-data",
    path.join(fixtures, "names.tsv"),
    "--merchant",
    "Synthetic QA Merchant",
    "--currency",
    "各国本币分国展示",
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
    "--analysis-output",
    path.join(temporaryDirectory, "analysis-pool.json"),
  ]);

  process.stdout.write("Smoke tests passed.\n");
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
