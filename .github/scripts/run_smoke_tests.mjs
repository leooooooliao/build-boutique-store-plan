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
    "Aime 与 Mira 的浏览器授权",
    "不要选择云端浏览器授权",
    "浮层内自动滚动协议",
    "完整报告必须实际查询营销参谋",
    "同一个 Excel 的两个 Sheet",
    "直接在对话中分两段粘贴",
    "达人找不到清晰的合作主题",
    "固定入口（以后都用这两个）",
    "本 README 是唯一持续维护的使用说明",
    "每次启用时都会先自动检查官方 GitHub Release",
    "v1.2.0 或更早版本",
  ];
  const missing = requiredFragments.filter((fragment) => !readme.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`README is missing required fragments: ${missing.join(", ")}`);
  }
}

function validateSelfUpdateContract() {
  const skill = fs.readFileSync(path.join(repositoryRoot, "SKILL.md"), "utf8");
  const version = fs
    .readFileSync(path.join(repositoryRoot, "VERSION"), "utf8")
    .trim();
  const updateHeading = skill.indexOf("## 0. 每次启用先同步版本");
  const interactionHeading = skill.indexOf("## 1. 先完成首次交互");
  if (
    updateHeading < 0 ||
    interactionHeading < 0 ||
    updateHeading > interactionHeading
  ) {
    throw new Error("The self-update gate must precede the first interaction.");
  }
  for (const fragment of [
    "scripts/sync_skill_release.mjs",
    "--apply --json",
    "每个新任务第一次触发",
    "同一任务不再检查",
    "references/self-update.md",
    "不得比较 `dependencies/gcrm-core/source-version.json`",
  ]) {
    if (!skill.includes(fragment)) {
      throw new Error(`SKILL.md is missing self-update contract: ${fragment}`);
    }
  }
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error(`VERSION is not a stable SemVer tag: ${version}`);
  }
}

function runNodeCapture(arguments_, expectedStatus = 0) {
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
  return result;
}

function runNode(arguments_, expectedStatus = 0) {
  runNodeCapture(arguments_, expectedStatus);
}

function validateGcrmFilterAutomation() {
  const runbook = fs.readFileSync(
    path.join(repositoryRoot, "dependencies/gcrm-core/browser-runbook.md"),
    "utf8",
  );
  for (const fragment of [
    "build-filter-plan.mjs",
    "li[role=\"menuitemcheckbox\"][title=\"<CATEGORY>\"]",
    ".potoo-marketing-advisor-cascader-checkbox",
    "浮层内部",
    "浮层展开后再做一次新的完整 `snapshot`",
    "不要继续使用展开前的旧 ref",
    "aime-browser click --tab_id=<TAB_ID> --selector='<L1_TARGET_CHECKBOX_SELECTOR>'",
    "### Level 2 Category",
    "level_two_selection.target_checkbox_selector",
    "不得因“滚轮滑不动”让用户手选",
  ]) {
    if (!runbook.includes(fragment)) {
      throw new Error(`GCRM browser runbook is missing: ${fragment}`);
    }
  }

  const result = runNodeCapture([
    "dependencies/gcrm-core/build-filter-plan.mjs",
    "--country",
    "MY",
    "--category",
    "虚拟商品",
  ]);
  const plan = JSON.parse(result.stdout);
  if (plan.manual_selection_required !== false) {
    throw new Error("GCRM filter plan must not require manual selection.");
  }
  if (!plan.country_selection.direct_url.includes("region=MY")) {
    throw new Error("GCRM filter plan is missing the direct country URL.");
  }
  if (
    !plan.category_selection.target_checkbox_selector.includes(
      '[title="虚拟商品"]',
    )
  ) {
    throw new Error("GCRM filter plan is missing the exact category selector.");
  }
  if (
    !plan.category_selection.trigger_selector.endsWith(
      "> .potoo-marketing-advisor-select-selector",
    ) ||
    !plan.category_selection.open_strategy.includes(
      "not the whole root",
    ) ||
    !plan.category_selection.target_checkbox_selector.includes(
      ":not(.potoo-marketing-advisor-select-dropdown-hidden)",
    )
  ) {
    throw new Error(
      "GCRM filter plan must use the safe category trigger and visible L1 popup.",
    );
  }

  const levelTwoResult = runNodeCapture([
    "dependencies/gcrm-core/build-filter-plan.mjs",
    "--country",
    "MY",
    "--category",
    "美妆个护",
    "--l2",
    "美容、个护电器",
  ]);
  const levelTwoPlan = JSON.parse(levelTwoResult.stdout);
  if (
    levelTwoPlan.schema_version !== "1.3.0" ||
    levelTwoPlan.level_two_selection.requested !== true ||
    !levelTwoPlan.level_two_selection.level_two_menu_selector.includes(
      "nth-of-type(2)",
    ) ||
    !levelTwoPlan.level_two_selection.target_checkbox_selector.includes(
      '[title="美容、个护电器"]',
    ) ||
    !levelTwoPlan.level_two_selection.readback_strategy.includes(
      "aria-checked=true",
    )
  ) {
    throw new Error(
      "GCRM filter plan is missing deterministic level-2 selectors and readback.",
    );
  }
  if (
    plan.country_selection.is_sea_child !== true ||
    !plan.country_selection.sea_expand_selector.includes('[title="SEA"]') ||
    !plan.country_selection.collapsed_sea_recovery.includes(
      "take a fresh full snapshot",
    )
  ) {
    throw new Error(
      "GCRM filter plan is missing automatic SEA parent expansion.",
    );
  }
  if (
    !plan.category_selection.target_checkbox_fallback_selector.includes(
      '[title="虚拟商品"]',
    ) ||
    !plan.category_selection.fallback_guard.includes(
      "fallback count is exactly 1",
    )
  ) {
    throw new Error(
      "GCRM filter plan is missing the guarded category fallback selector.",
    );
  }
  if (
    !plan.category_selection.target_checked_selector.includes(
      '[aria-checked="true"]',
    ) ||
    !plan.category_selection.selection_strategy.includes(
      "only when the target row is not already aria-checked=true",
    )
  ) {
    throw new Error(
      "GCRM filter plan must not toggle an already selected target category.",
    );
  }
  if (
    !plan.category_selection.offscreen_strategy.includes(
      "auto-scrolls inside the category popup",
    )
  ) {
    throw new Error("GCRM filter plan is missing popup auto-scroll guidance.");
  }
}

try {
  validateReadme();
  validateSelfUpdateContract();
  validateGcrmFilterAutomation();

  for (const relativePath of [
    "scripts/lib.mjs",
    "scripts/validate_input.mjs",
    "scripts/prepare_portfolio.mjs",
    "scripts/sync_skill_release.mjs",
    "scripts/validate_plan_evidence.mjs",
    "scripts/validate_report.mjs",
    "dependencies/gcrm-core/validate-evidence.mjs",
    "dependencies/gcrm-core/build-filter-plan.mjs",
    "tests/data_regression.mjs",
    "tests/gcrm_metrics.test.mjs",
    "tests/self_update.test.mjs",
    "tests/validate_report.test.mjs",
    ".github/scripts/validate_public_package.mjs",
    ".github/scripts/release_asset_downloads.mjs",
  ]) {
    runNode(["--check", relativePath]);
  }

  runNode(["tests/data_regression.mjs"]);
  runNode(["tests/gcrm_metrics.test.mjs"]);
  runNode(["tests/self_update.test.mjs"]);
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
    "2026-07-01..2026-07-26",
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
