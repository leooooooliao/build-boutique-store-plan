#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAmountRange,
  validateGcrmEvidence,
} from "../dependencies/gcrm-core/validate-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  here,
  "fixtures",
  "gcrm-evidence-verified.json",
);
const expectedWindow = { start: "2026-07-01", end: "2026-07-26" };
const filterPlanPath = path.join(
  here,
  "..",
  "dependencies",
  "gcrm-core",
  "build-filter-plan.mjs",
);
const sourceVersionPath = path.join(
  here,
  "..",
  "dependencies",
  "gcrm-core",
  "source-version.json",
);

function loadFixture() {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function validate(evidence) {
  return validateGcrmEvidence(evidence, expectedWindow, {
    expectedThemeCount: 3,
  });
}

function assertHasError(result, pattern) {
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), pattern);
}

assert.equal(parseAmountRange("USD 10K–20K")?.midpoint, 15_000);
assert.equal(parseAmountRange("USD 1M–2M")?.midpoint, 1_500_000);
assert.equal(parseAmountRange("USD 1B–3B")?.midpoint, 2_000_000_000);
assert.equal(parseAmountRange("USD 900–1K")?.midpoint, 950);
assert.equal(parseAmountRange("USD 10–20K")?.midpoint, 15_000);
assert.equal(parseAmountRange("USD 3.3")?.midpoint, 3.3);
assert.equal(parseAmountRange("USD 1K+"), null);
assert.equal(parseAmountRange("USD 1K–N/A"), null);

const verified = validate(loadFixture());
assert.equal(verified.ok, true, verified.errors.join("\n"));
assert.equal(verified.checks.tr_available_candidate_count, 3);
assert.equal(verified.checks.tr_unavailable_candidate_count, 0);
assert.equal(
  JSON.parse(fs.readFileSync(sourceVersionPath, "utf8")).gcrm_core_version,
  "1.3.0",
);

const scaledRanges = loadFixture();
scaledRanges.candidates[0].gmv_range = "USD 1M–2M";
scaledRanges.candidates[0].ads_cost_range = "USD 10K–20K";
scaledRanges.candidates[0].tr_estimate = 0.01;
assert.equal(validate(scaledRanges).ok, true);

const openRange = loadFixture();
openRange.candidates[0].ads_cost_range = "USD 1K+";
openRange.candidates[0].tr_estimate = null;
openRange.candidates[0].tr_unavailable_reason = "广告消耗是开口区间，无法取得中点";
assert.equal(validate(openRange).ok, true);

const unparseableRange = loadFixture();
unparseableRange.candidates[0].ads_cost_range = "USD 1K–N/A";
unparseableRange.candidates[0].tr_estimate = null;
unparseableRange.candidates[0].tr_unavailable_reason = "广告消耗区间上界不可解析";
assert.equal(validate(unparseableRange).ok, true);

const wrongFormula = loadFixture();
wrongFormula.candidates[0].tr_estimate = 0.2;
assertHasError(validate(wrongFormula), /tr_estimate=.*区间中点公式结果/);

const lazyNull = loadFixture();
lazyNull.candidates[0].tr_estimate = null;
lazyNull.candidates[0].tr_unavailable_reason = "未计算";
assertHasError(validate(lazyNull), /tr_estimate 必须按广告消耗区间中点除以总 GMV 区间中点计算/);

const missingReason = loadFixture();
missingReason.candidates[0].ads_cost_range = "USD 1K+";
missingReason.candidates[0].tr_estimate = null;
assertHasError(validate(missingReason), /tr_unavailable_reason 缺失/);

const missingAveragePrice = loadFixture();
delete missingAveragePrice.candidates[0].average_price;
assertHasError(validate(missingAveragePrice), /average_price/);

const unknownCandidateField = loadFixture();
unknownCandidateField.candidates[0].unexpected_metric = "unexpected";
assertHasError(validate(unknownCandidateField), /证据合同未声明的字段/);

const missingLevelTwoAttempt = loadFixture();
missingLevelTwoAttempt.queries[0].l2_attempted = false;
assertHasError(validate(missingLevelTwoAttempt), /l2_attempted 必须为 true/);

const missingLevelTwoReason = loadFixture();
delete missingLevelTwoReason.queries[2].l2_status_reason;
assertHasError(validate(missingLevelTwoReason), /l2_status_reason 缺失/);

const missingSessionMode = loadFixture();
delete missingSessionMode.browser.session_mode;
assertHasError(validate(missingSessionMode), /session_mode/);

const unknownBrowserPath = loadFixture();
unknownBrowserPath.browser.attempted_paths = ["unknown_path"];
assertHasError(validate(unknownBrowserPath), /合同允许的自动浏览器路径/);

const emptyCompletedPaths = loadFixture();
emptyCompletedPaths.browser.attempted_paths = [];
assertHasError(validate(emptyCompletedPaths), /至少 1 条合同允许的自动浏览器路径/);

const nonLocalAdapter = loadFixture();
nonLocalAdapter.browser.adapter = "Remote Browser";
nonLocalAdapter.browser.adapter_type = "other_local";
assertHasError(validate(nonLocalAdapter), /不能使用非本地会话/);

const otherLocalAdapter = loadFixture();
otherLocalAdapter.browser.adapter = "Mira Local Chrome";
otherLocalAdapter.browser.adapter_type = "other_local";
assert.equal(validate(otherLocalAdapter).ok, true);

const filterPlan = spawnSync(
  process.execPath,
  [
    filterPlanPath,
    "--country",
    "MY",
    "--category",
    "美妆个护",
    "--l2",
    "美容、个护电器",
  ],
  { encoding: "utf8" },
);
assert.equal(filterPlan.status, 0, filterPlan.stderr);
const parsedFilterPlan = JSON.parse(filterPlan.stdout);
assert.equal(parsedFilterPlan.schema_version, "1.3.0");
assert.equal(parsedFilterPlan.level_two_selection.requested, true);
assert.match(
  parsedFilterPlan.level_two_selection.level_two_menu_selector,
  /nth-of-type\(2\)/,
);
assert.match(
  parsedFilterPlan.level_two_selection.target_checkbox_selector,
  /美容、个护电器/,
);

const filterPlanWithoutLevelTwo = spawnSync(
  process.execPath,
  [filterPlanPath, "--country", "MY", "--category", "美妆个护"],
  { encoding: "utf8" },
);
assert.equal(filterPlanWithoutLevelTwo.status, 0, filterPlanWithoutLevelTwo.stderr);
assert.equal(
  JSON.parse(filterPlanWithoutLevelTwo.stdout).level_two_selection
    .evaluation_required,
  true,
);

const validatorCli = path.join(
  here,
  "..",
  "dependencies",
  "gcrm-core",
  "validate-evidence.mjs",
);
const help = spawnSync(process.execPath, [validatorCli, "--help"], {
  encoding: "utf8",
});
assert.equal(help.status, 0);
assert.match(help.stdout, /--report-window/);
assert.doesNotMatch(`${help.stdout}\n${help.stderr}`, /缺少 --evidence/);

const invalidWindow = spawnSync(
  process.execPath,
  [
    validatorCli,
    "--evidence",
    fixturePath,
    "--report-window",
    "invalid",
    "--expected-themes",
    "3",
    "--json",
  ],
  { encoding: "utf8" },
);
assert.equal(invalidWindow.status, 1);
assert.match(invalidWindow.stdout, /--report-window 必须是有效的/);
assert.doesNotMatch(invalidWindow.stdout, /--gcrm-window 必须是有效的/);

process.stdout.write("GCRM 指标与浏览器自动化合同测试通过。\n");
