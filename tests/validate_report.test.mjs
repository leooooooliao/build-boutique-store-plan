#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtures = path.join(repositoryRoot, "tests", "fixtures");
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "boutique-gcrm-qa-"),
);
process.on("exit", () => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function run(arguments_, expectedStatus) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.equal(
    result.status,
    expectedStatus,
    `${arguments_.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return result;
}

function evidenceArguments(file) {
  return [
    "dependencies/gcrm-core/validate-evidence.mjs",
    "--evidence",
    path.join(fixtures, file),
    "--gcrm-window",
    "2026-06-29..2026-07-28",
    "--expected-themes",
    "3",
    "--json",
  ];
}

function planArguments(file) {
  return [
    "scripts/validate_plan_evidence.mjs",
    "--evidence",
    path.join(fixtures, file),
    "--merchant-window",
    "2026-07-01..2026-07-26",
    "--expected-plans",
    "3",
    "--json",
  ];
}

function reportArguments(
  report,
  evidence,
  expectedProducts,
  planEvidence = "plan-evidence-good.json",
) {
  return [
    "scripts/validate_report.mjs",
    "--report",
    path.join(fixtures, report),
    "--merchant-window",
    "2026-07-01..2026-07-26",
    "--gcrm-window",
    "2026-06-29..2026-07-28",
    "--generated-date",
    "2026-07-29",
    "--plan-evidence",
    path.join(fixtures, planEvidence),
    "--gcrm-evidence",
    path.join(fixtures, evidence),
    "--expected-gcrm-products",
    String(expectedProducts),
    "--expected-top",
    "3",
    "--json",
  ];
}

const validPlanEvidence = run(
  planArguments("plan-evidence-good.json"),
  0,
);
assert.equal(JSON.parse(validPlanEvidence.stdout).checks.refinement_count, 1);

const misclassifiedPlan = JSON.parse(
  fs.readFileSync(path.join(fixtures, "plan-evidence-good.json"), "utf8"),
);
misclassifiedPlan.plans[2].classification = "reorganization";
const misclassifiedPlanPath = path.join(
  temporaryDirectory,
  "plan-evidence-misclassified.json",
);
fs.writeFileSync(
  misclassifiedPlanPath,
  `${JSON.stringify(misclassifiedPlan, null, 2)}\n`,
);
const misclassified = run(
  [
    "scripts/validate_plan_evidence.mjs",
    "--evidence",
    misclassifiedPlanPath,
    "--merchant-window",
    "2026-07-01..2026-07-26",
    "--expected-plans",
    "3",
    "--json",
  ],
  1,
);
assert.match(misclassified.stdout, /类型错误/);

const refinementFirstPlan = JSON.parse(
  fs.readFileSync(path.join(fixtures, "plan-evidence-good.json"), "utf8"),
);
refinementFirstPlan.plans[0].rank = 3;
refinementFirstPlan.plans[2].rank = 1;
const refinementFirstPath = path.join(
  temporaryDirectory,
  "plan-evidence-refinement-first.json",
);
fs.writeFileSync(
  refinementFirstPath,
  `${JSON.stringify(refinementFirstPlan, null, 2)}\n`,
);
const refinementFirst = run(
  [
    "scripts/validate_plan_evidence.mjs",
    "--evidence",
    refinementFirstPath,
    "--merchant-window",
    "2026-07-01..2026-07-26",
    "--expected-plans",
    "3",
    "--json",
  ],
  1,
);
assert.match(refinementFirst.stdout, /必须提供结构化 ranking_override/);

refinementFirstPlan.plans[2].ranking_override = {
  enabled: true,
  reason_code: "theme_coherence",
  explanation: "主题纯度显著更高，内容改造与迁移执行成本更低",
  over_reorganization_ranks: [2, 3],
};
const refinementOverridePath = path.join(
  temporaryDirectory,
  "plan-evidence-refinement-override.json",
);
fs.writeFileSync(
  refinementOverridePath,
  `${JSON.stringify(refinementFirstPlan, null, 2)}\n`,
);
run(
  [
    "scripts/validate_plan_evidence.mjs",
    "--evidence",
    refinementOverridePath,
    "--merchant-window",
    "2026-07-01..2026-07-26",
    "--expected-plans",
    "3",
    "--json",
  ],
  0,
);

refinementFirstPlan.plans[2].ranking_override.reason_code =
  "risk_adjusted_value";
const invalidOverridePath = path.join(
  temporaryDirectory,
  "plan-evidence-invalid-override.json",
);
fs.writeFileSync(
  invalidOverridePath,
  `${JSON.stringify(refinementFirstPlan, null, 2)}\n`,
);
const invalidOverride = run(
  [
    "scripts/validate_plan_evidence.mjs",
    "--evidence",
    invalidOverridePath,
    "--merchant-window",
    "2026-07-01..2026-07-26",
    "--expected-plans",
    "3",
    "--json",
  ],
  1,
);
assert.match(invalidOverride.stdout, /reason_code 只允许/);

const verified = run(evidenceArguments("gcrm-evidence-verified.json"), 0);
assert.equal(JSON.parse(verified.stdout).status, "verified");

const noCandidate = run(
  evidenceArguments("gcrm-evidence-no-candidate.json"),
  0,
);
assert.equal(
  JSON.parse(noCandidate.stdout).status,
  "verified_no_candidate",
);

const partial = run(evidenceArguments("gcrm-evidence-partial.json"), 1);
assert.equal(JSON.parse(partial.stdout).status, "partial");

const oneAttemptEvidence = JSON.parse(
  fs.readFileSync(
    path.join(fixtures, "gcrm-evidence-partial.json"),
    "utf8",
  ),
);
oneAttemptEvidence.browser.attempted_paths = ["dom"];
const oneAttemptPath = path.join(
  temporaryDirectory,
  "gcrm-evidence-one-attempt.json",
);
fs.writeFileSync(
  oneAttemptPath,
  `${JSON.stringify(oneAttemptEvidence, null, 2)}\n`,
);
const oneAttempt = run(
  [
    "dependencies/gcrm-core/validate-evidence.mjs",
    "--evidence",
    oneAttemptPath,
    "--gcrm-window",
    "2026-06-29..2026-07-28",
    "--expected-themes",
    "3",
    "--json",
  ],
  1,
);
assert.match(oneAttempt.stdout, /至少 2 条自动恢复路径/);

const manualHandoffEvidence = JSON.parse(
  fs.readFileSync(
    path.join(fixtures, "gcrm-evidence-partial.json"),
    "utf8",
  ),
);
manualHandoffEvidence.browser.attempted_paths = [
  "dom",
  "请用户切好后回复",
];
const manualHandoffPath = path.join(
  temporaryDirectory,
  "gcrm-evidence-manual-handoff.json",
);
fs.writeFileSync(
  manualHandoffPath,
  `${JSON.stringify(manualHandoffEvidence, null, 2)}\n`,
);
const manualHandoff = run(
  [
    "dependencies/gcrm-core/validate-evidence.mjs",
    "--evidence",
    manualHandoffPath,
    "--gcrm-window",
    "2026-06-29..2026-07-28",
    "--expected-themes",
    "3",
    "--json",
  ],
  1,
);
assert.match(manualHandoff.stdout, /不能把逐组人工筛选或交接用户当作恢复路径/);

const missingExpectedThemes = run(
  evidenceArguments("gcrm-evidence-verified.json").filter(
    (argument, index, arguments_) =>
      argument !== "--expected-themes" &&
      arguments_[index - 1] !== "--expected-themes",
  ),
  1,
);
assert.match(missingExpectedThemes.stdout, /缺少 --expected-themes/);

const missingThemeEvidence = JSON.parse(
  fs.readFileSync(
    path.join(fixtures, "gcrm-evidence-no-candidate.json"),
    "utf8",
  ),
);
missingThemeEvidence.queries = missingThemeEvidence.queries.filter(
  (query) => query.theme_rank !== 3,
);
const missingThemePath = path.join(
  temporaryDirectory,
  "gcrm-evidence-missing-theme.json",
);
fs.writeFileSync(
  missingThemePath,
  `${JSON.stringify(missingThemeEvidence, null, 2)}\n`,
);
const missingTheme = run(
  [
    "dependencies/gcrm-core/validate-evidence.mjs",
    "--evidence",
    missingThemePath,
    "--gcrm-window",
    "2026-06-29..2026-07-28",
    "--expected-themes",
    "3",
    "--json",
  ],
  1,
);
assert.match(missingTheme.stdout, /缺少主题序号 3/);

const inconsistentThemeEvidence = JSON.parse(
  fs.readFileSync(
    path.join(fixtures, "gcrm-evidence-no-candidate.json"),
    "utf8",
  ),
);
inconsistentThemeEvidence.queries.push({
  ...inconsistentThemeEvidence.queries[0],
  query_id: "my-kitchen-conflicting-name-202607",
  theme_name: "另一个厨房主题",
});
const inconsistentThemePath = path.join(
  temporaryDirectory,
  "gcrm-evidence-inconsistent-theme.json",
);
fs.writeFileSync(
  inconsistentThemePath,
  `${JSON.stringify(inconsistentThemeEvidence, null, 2)}\n`,
);
const inconsistentTheme = run(
  [
    "dependencies/gcrm-core/validate-evidence.mjs",
    "--evidence",
    inconsistentThemePath,
    "--gcrm-window",
    "2026-06-29..2026-07-28",
    "--expected-themes",
    "3",
    "--json",
  ],
  1,
);
assert.match(inconsistentTheme.stdout, /同一主题序号出现多个 theme_name/);

const missingNoCandidateReasonEvidence = JSON.parse(
  fs.readFileSync(
    path.join(fixtures, "gcrm-evidence-verified.json"),
    "utf8",
  ),
);
missingNoCandidateReasonEvidence.candidates =
  missingNoCandidateReasonEvidence.candidates.filter(
    (candidate) => candidate.theme_rank !== 3,
  );
const missingNoCandidateReasonPath = path.join(
  temporaryDirectory,
  "gcrm-evidence-missing-no-candidate-reason.json",
);
fs.writeFileSync(
  missingNoCandidateReasonPath,
  `${JSON.stringify(missingNoCandidateReasonEvidence, null, 2)}\n`,
);
const missingNoCandidateReason = run(
  [
    "dependencies/gcrm-core/validate-evidence.mjs",
    "--evidence",
    missingNoCandidateReasonPath,
    "--gcrm-window",
    "2026-06-29..2026-07-28",
    "--expected-themes",
    "3",
    "--json",
  ],
  1,
);
assert.match(missingNoCandidateReason.stdout, /no_candidate_reason/);

const missingShopEvidence = JSON.parse(
  fs.readFileSync(
    path.join(fixtures, "gcrm-evidence-verified.json"),
    "utf8",
  ),
);
missingShopEvidence.candidates[0].original_shop_name = "";
const missingShopPath = path.join(
  temporaryDirectory,
  "gcrm-evidence-missing-shop.json",
);
fs.writeFileSync(
  missingShopPath,
  `${JSON.stringify(missingShopEvidence, null, 2)}\n`,
);
const missingShop = run(
  [
    "dependencies/gcrm-core/validate-evidence.mjs",
    "--evidence",
    missingShopPath,
    "--gcrm-window",
    "2026-06-29..2026-07-28",
    "--expected-themes",
    "3",
    "--json",
  ],
  1,
);
assert.match(missingShop.stdout, /original_shop_name/);

const goodReport = run(
  reportArguments(
    "report-good.md",
    "gcrm-evidence-verified.json",
    3,
  ),
  0,
);
assert.equal(JSON.parse(goodReport.stdout).delivery_status, "complete");

const misleadingPlanReport = fs
  .readFileSync(path.join(fixtures, "report-good.md"), "utf8")
  .replace("方案证据：精修型；", "方案证据：重组型；");
const misleadingPlanReportPath = path.join(
  temporaryDirectory,
  "report-misleading-plan-label.md",
);
fs.writeFileSync(misleadingPlanReportPath, misleadingPlanReport);
const misleadingPlanArguments = reportArguments(
  "report-good.md",
  "gcrm-evidence-verified.json",
  3,
);
misleadingPlanArguments[2] = misleadingPlanReportPath;
const misleadingPlan = run(misleadingPlanArguments, 1);
assert.match(
  misleadingPlan.stdout,
  /方案 3 的方案类型 精修型 未在报告中展示/,
);

const swappedThemeReport = fs
  .readFileSync(path.join(fixtures, "report-good.md"), "utf8")
  .replace("精品店 1｜高效厨房店", "精品店 1｜车主清洁与应急店")
  .replace("精品店 2｜车主清洁与应急店", "精品店 2｜高效厨房店");
const swappedThemeReportPath = path.join(
  temporaryDirectory,
  "report-swapped-theme.md",
);
fs.writeFileSync(swappedThemeReportPath, swappedThemeReport);
const swappedThemeArguments = reportArguments(
  "report-good.md",
  "gcrm-evidence-verified.json",
  3,
);
swappedThemeArguments[2] = swappedThemeReportPath;
const swappedTheme = run(swappedThemeArguments, 1);
assert.match(swappedTheme.stdout, /与报告标题.*不一致/);

const noCandidateReport = run(
  reportArguments(
    "report-no-candidate.md",
    "gcrm-evidence-no-candidate.json",
    0,
    "plan-evidence-no-candidate.json",
  ),
  0,
);
assert.equal(
  JSON.parse(noCandidateReport.stdout).checks.gcrm_status,
  "verified_no_candidate",
);

const unavailableReport = run(
  reportArguments(
    "report-unavailable.md",
    "gcrm-evidence-partial.json",
    0,
    "plan-evidence-no-candidate.json",
  ),
  1,
);
assert.equal(
  JSON.parse(unavailableReport.stdout).delivery_status,
  "partial_draft",
);

run(
  reportArguments(
    "report-empty-shop.md",
    "gcrm-evidence-verified.json",
    3,
  ),
  1,
);

run(
  [
    "scripts/validate_report.mjs",
    "--report",
    path.join(fixtures, "report-unavailable.md"),
    "--merchant-window",
    "2026-07-01..2026-07-26",
    "--gcrm-window",
    "2026-06-29..2026-07-28",
    "--generated-date",
    "2026-07-29",
    "--gcrm-mode",
    "unavailable",
    "--expected-gcrm-products",
    "0",
    "--expected-top",
    "3",
    "--json",
  ],
  1,
);

const browserRunbook = fs.readFileSync(
  path.join(
    repositoryRoot,
    "dependencies",
    "gcrm-core",
    "browser-runbook.md",
  ),
  "utf8",
);
assert.match(
  browserRunbook,
  /不得把国家或类目的逐组手动切换交给用户/,
);
assert.match(
  browserRunbook,
  /唯一可请求的人工动作是一次性的浏览器授权或登录/,
);

process.stdout.write("Report QA regression tests passed.\n");
