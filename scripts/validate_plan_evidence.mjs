#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  parseWindow,
  printResult,
  requireOptions,
  resolveReportWindowArgs,
} from "./lib.mjs";

const CLASSIFICATIONS = new Set(["reorganization", "refinement"]);
const OVERRIDE_REASON_CODES = new Set([
  "theme_coherence",
  "operating_strength",
  "execution_feasibility",
]);
const SHARE_TOLERANCE = 0.002;

const HELP = `
验证精品店方案的结构化重组价值证据。

用法：
  node scripts/validate_plan_evidence.mjs \\
    --evidence <plan-evidence.json> \\
    --report-window 2026-07-01..2026-07-26 \\
    [--expected-plans 3] [--json]

固定判定：
  - 承接店内已有 GMV 占比 > 50%，或店外占比 < 50%，必须标为 refinement；
  - 承接店已有商品原型占比 > 50%，必须标为 refinement；
  - 其他方案标为 reorganization；
  - reorganization 默认排在 refinement 之前；
  - refinement 需要前置时，必须使用结构化 ranking_override，
    reason_code 仅允许 theme_coherence / operating_strength /
    execution_feasibility，并明确 explanation 与被越过的重组方案 rank。
`.trim();

function readJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`方案证据不存在：${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`方案证据不是有效 JSON：${error.message}`);
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function integerInRange(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return (
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function nearlyEqual(left, right, tolerance) {
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= tolerance
  );
}

function amountTolerance(value) {
  return Math.max(0.01, Math.abs(value) * 0.000001);
}

function planLabel(plan, index) {
  return `方案 ${plan?.rank ?? index + 1}`;
}

function validatePlanFields(plan, index, errors) {
  const label = planLabel(plan, index);
  for (const field of [
    "theme_name",
    "country",
    "target_shop_id",
    "target_shop_name",
    "priority_reason",
  ]) {
    if (!nonEmpty(plan?.[field])) {
      errors.push(`${label}.${field} 不能为空。`);
    }
  }
  if (
    nonEmpty(plan?.priority_reason) &&
    plan.priority_reason.trim().length < 8
  ) {
    errors.push(`${label}.priority_reason 必须明确说明排序依据。`);
  }
  if (!integerInRange(plan?.rank, 1, 100)) {
    errors.push(`${label}.rank 必须是正整数。`);
  }
  if (!CLASSIFICATIONS.has(plan?.classification)) {
    errors.push(
      `${label}.classification 必须是 reorganization 或 refinement。`,
    );
  }
  for (const field of [
    "candidate_gmv",
    "target_shop_existing_gmv",
    "outside_shop_gmv",
  ]) {
    if (!finiteNonNegative(plan?.[field])) {
      errors.push(`${label}.${field} 必须是非负有限数字。`);
    }
  }
  if (
    typeof plan?.candidate_gmv === "number" &&
    Number.isFinite(plan.candidate_gmv) &&
    plan.candidate_gmv <= 0
  ) {
    errors.push(`${label}.candidate_gmv 必须大于 0。`);
  }
  for (const field of [
    "target_shop_existing_gmv_share",
    "outside_shop_gmv_share",
    "existing_archetype_share",
  ]) {
    if (
      typeof plan?.[field] !== "number" ||
      !Number.isFinite(plan[field]) ||
      plan[field] < 0 ||
      plan[field] > 1
    ) {
      errors.push(`${label}.${field} 必须是 0–1 的数字。`);
    }
  }
  if (!integerInRange(plan?.source_shop_count, 1)) {
    errors.push(`${label}.source_shop_count 必须是大于等于 1 的整数。`);
  }
  if (!integerInRange(plan?.archetype_count, 1)) {
    errors.push(`${label}.archetype_count 必须是大于等于 1 的整数。`);
  }
  if (!Array.isArray(plan?.current_products) || plan.current_products.length === 0) {
    errors.push(`${label}.current_products 必须至少包含一个现有好品。`);
  } else {
    const seenProductKeys = new Set();
    for (const [productIndex, product] of plan.current_products.entries()) {
      const productLabel = `${label}.current_products[${productIndex}]`;
      for (const field of [
        "product_id",
        "display_name",
        "source_shop_id",
        "source_shop_name",
        "combination_note",
      ]) {
        if (!nonEmpty(product?.[field])) {
          errors.push(`${productLabel}.${field} 不能为空。`);
        }
      }
      if (!finiteNonNegative(product?.gmv)) {
        errors.push(`${productLabel}.gmv 必须是非负有限数字。`);
      }
      if (
        product?.roas !== null &&
        product?.roas !== undefined &&
        !finiteNonNegative(product.roas)
      ) {
        errors.push(`${productLabel}.roas 必须是非负有限数字或 null。`);
      }
      if (typeof product?.in_target_shop !== "boolean") {
        errors.push(`${productLabel}.in_target_shop 必须是布尔值。`);
      }
      const key = `${String(product?.source_shop_id ?? "")}\u001f${String(product?.product_id ?? "")}`;
      if (seenProductKeys.has(key)) {
        errors.push(`${productLabel} 与同方案内其他现有好品重复。`);
      }
      seenProductKeys.add(key);
    }
  }
  if (
    !integerInRange(
      plan?.archetypes_already_in_target_shop,
      0,
      Number.isInteger(plan?.archetype_count)
        ? plan.archetype_count
        : Number.MAX_SAFE_INTEGER,
    )
  ) {
    errors.push(
      `${label}.archetypes_already_in_target_shop 必须是 0 到 archetype_count 之间的整数。`,
    );
  }
}

function validatePlanMath(plan, index, errors) {
  const label = planLabel(plan, index);
  if (
    finiteNonNegative(plan.candidate_gmv) &&
    finiteNonNegative(plan.target_shop_existing_gmv) &&
    finiteNonNegative(plan.outside_shop_gmv) &&
    !nearlyEqual(
      plan.candidate_gmv,
      plan.target_shop_existing_gmv + plan.outside_shop_gmv,
      amountTolerance(plan.candidate_gmv),
    )
  ) {
    errors.push(
      `${label} GMV 不守恒：candidate_gmv 必须等于店内 GMV + 店外 GMV。`,
    );
  }
  if (
    plan.target_shop_existing_gmv > 0 &&
    plan.outside_shop_gmv > 0 &&
    integerInRange(plan.source_shop_count, 1) &&
    plan.source_shop_count < 2
  ) {
    errors.push(
      `${label}.source_shop_count 与店内及店外同时存在 GMV 的证据不一致。`,
    );
  }
  if (finiteNonNegative(plan.candidate_gmv) && plan.candidate_gmv > 0) {
    const expectedInside =
      plan.target_shop_existing_gmv / plan.candidate_gmv;
    const expectedOutside = plan.outside_shop_gmv / plan.candidate_gmv;
    if (
      !nearlyEqual(
        plan.target_shop_existing_gmv_share,
        expectedInside,
        SHARE_TOLERANCE,
      )
    ) {
      errors.push(`${label} 承接店内已有 GMV 占比与金额不一致。`);
    }
    if (
      !nearlyEqual(
        plan.outside_shop_gmv_share,
        expectedOutside,
        SHARE_TOLERANCE,
      )
    ) {
      errors.push(`${label} 店外 GMV 占比与金额不一致。`);
    }
  }
  if (
    Number.isInteger(plan.archetype_count) &&
    plan.archetype_count > 0 &&
    Number.isInteger(plan.archetypes_already_in_target_shop)
  ) {
    const expectedShare =
      plan.archetypes_already_in_target_shop / plan.archetype_count;
    if (
      !nearlyEqual(
        plan.existing_archetype_share,
        expectedShare,
        SHARE_TOLERANCE,
      )
    ) {
      errors.push(`${label} 承接店已有商品原型占比与原型数量不一致。`);
    }
  }
}

export function deriveClassification(plan) {
  const insideShare =
    finiteNonNegative(plan.target_shop_existing_gmv) &&
    finiteNonNegative(plan.candidate_gmv) &&
    plan.candidate_gmv > 0
      ? plan.target_shop_existing_gmv / plan.candidate_gmv
      : plan.target_shop_existing_gmv_share;
  const outsideShare =
    finiteNonNegative(plan.outside_shop_gmv) &&
    finiteNonNegative(plan.candidate_gmv) &&
    plan.candidate_gmv > 0
      ? plan.outside_shop_gmv / plan.candidate_gmv
      : plan.outside_shop_gmv_share;
  const archetypeShare =
    Number.isInteger(plan.archetypes_already_in_target_shop) &&
    Number.isInteger(plan.archetype_count) &&
    plan.archetype_count > 0
      ? plan.archetypes_already_in_target_shop / plan.archetype_count
      : plan.existing_archetype_share;
  const gmvRefinement =
    insideShare > 0.5 || outsideShare < 0.5;
  const archetypeRefinement = archetypeShare > 0.5;
  return {
    classification:
      gmvRefinement || archetypeRefinement
        ? "refinement"
        : "reorganization",
    triggers: [
      ...(gmvRefinement ? ["majority_gmv_already_in_target_shop"] : []),
      ...(archetypeRefinement
        ? ["majority_archetypes_already_in_target_shop"]
        : []),
    ],
    derived_shares: {
      target_shop_existing_gmv_share: insideShare,
      outside_shop_gmv_share: outsideShare,
      existing_archetype_share: archetypeShare,
    },
  };
}

function validateOverride(plan, lowerReorganizationRanks, errors, warnings) {
  const label = `方案 ${plan.rank}`;
  const override = plan.ranking_override;
  if (lowerReorganizationRanks.length === 0) {
    if (override?.enabled === true) {
      warnings.push(`${label} 不需要排序例外，但提供了 ranking_override。`);
    }
    return;
  }
  if (!override || override.enabled !== true) {
    errors.push(
      `${label} 为精修型却排在重组型方案 ${lowerReorganizationRanks.join(
        "、",
      )} 之前；必须提供结构化 ranking_override。`,
    );
    return;
  }
  if (!OVERRIDE_REASON_CODES.has(override.reason_code)) {
    errors.push(
      `${label}.ranking_override.reason_code 只允许 theme_coherence、operating_strength、execution_feasibility。`,
    );
  }
  if (!nonEmpty(override.explanation) || override.explanation.trim().length < 8) {
    errors.push(
      `${label}.ranking_override.explanation 必须明确解释精修型为何应前置。`,
    );
  }
  if (!Array.isArray(override.over_reorganization_ranks)) {
    errors.push(
      `${label}.ranking_override.over_reorganization_ranks 必须列出被越过的重组方案 rank。`,
    );
    return;
  }
  const declared = new Set(override.over_reorganization_ranks);
  const missing = lowerReorganizationRanks.filter((rank) => !declared.has(rank));
  if (missing.length > 0) {
    errors.push(
      `${label}.ranking_override 未覆盖被越过的重组方案 rank：${missing.join("、")}。`,
    );
  }
}

export function validatePlanEvidence(
  evidence,
  reportWindow,
  options = {},
) {
  const errors = [];
  const warnings = [];
  const expectedPlans = options.expectedPlans ?? null;

  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {
      ok: false,
      errors: ["方案证据必须是 JSON 对象。"],
      warnings,
      checks: {},
    };
  }
  if (evidence.schema_version !== "1.1.0") {
    errors.push("schema_version 必须是 1.1.0。");
  }
  if (
    evidence.window?.start !== reportWindow.start ||
    evidence.window?.end !== reportWindow.end
  ) {
    errors.push(
      `方案证据周期必须等于报告周期 ${reportWindow.start} 至 ${reportWindow.end}。`,
    );
  }
  if (!Array.isArray(evidence.plans) || evidence.plans.length === 0) {
    errors.push("plans 必须是非空数组。");
  }
  const plans = Array.isArray(evidence.plans) ? evidence.plans : [];
  if (expectedPlans !== null && plans.length !== expectedPlans) {
    errors.push(
      `方案证据数量 ${plans.length} 与 expected-plans=${expectedPlans} 不一致。`,
    );
  }

  for (const [index, plan] of plans.entries()) {
    validatePlanFields(plan, index, errors);
    validatePlanMath(plan, index, errors);
    const derived = deriveClassification(plan);
    if (
      CLASSIFICATIONS.has(plan.classification) &&
      plan.classification !== derived.classification
    ) {
      errors.push(
        `方案 ${plan.rank ?? index + 1} 类型错误：结构化证据应归类为 ${derived.classification}，实际为 ${plan.classification}。`,
      );
    }
  }

  const ranks = plans.map((plan) => plan.rank);
  if (new Set(ranks).size !== ranks.length) {
    errors.push("plans.rank 不能重复。");
  }
  const sortedRanks = [...ranks].sort((left, right) => left - right);
  for (let index = 0; index < sortedRanks.length; index += 1) {
    if (sortedRanks[index] !== index + 1) {
      errors.push(`plans.rank 必须从 1 连续排列，缺少 ${index + 1}。`);
      break;
    }
  }

  const sortedPlans = [...plans].sort((left, right) => left.rank - right.rank);
  for (const plan of sortedPlans) {
    if (plan.classification !== "refinement") continue;
    const lowerReorganizationRanks = sortedPlans
      .filter(
        (candidate) =>
          candidate.rank > plan.rank &&
          candidate.classification === "reorganization",
      )
      .map((candidate) => candidate.rank);
    validateOverride(plan, lowerReorganizationRanks, errors, warnings);
  }

  const derivedPlans = sortedPlans.map((plan) => {
    const derived = deriveClassification(plan);
    return {
      rank: plan.rank,
      theme_name: plan.theme_name,
      classification: plan.classification,
      derived_classification: derived.classification,
      refinement_triggers: derived.triggers,
      derived_shares: derived.derived_shares,
      ranking_override: plan.ranking_override ?? null,
    };
  });
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    checks: {
      plan_count: plans.length,
      reorganization_count: plans.filter(
        (plan) => plan.classification === "reorganization",
      ).length,
      refinement_count: plans.filter(
        (plan) => plan.classification === "refinement",
      ).length,
      derived_plans: derivedPlans,
    },
  };
}

const isMain =
  process.argv[1] &&
  fs.realpathSync(fileURLToPath(import.meta.url)) ===
    fs.realpathSync(process.argv[1]);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  try {
    requireOptions(args, ["evidence"]);
    const reportWindowRaw = resolveReportWindowArgs(args);
    const expectedPlans =
      args["expected-plans"] === undefined
        ? null
        : Number(args["expected-plans"]);
    if (
      expectedPlans !== null &&
      (!Number.isInteger(expectedPlans) || expectedPlans < 1 || expectedPlans > 10)
    ) {
      throw new Error("--expected-plans 必须是 1–10 的整数。");
    }
    const reportWindow = parseWindow(reportWindowRaw, "报告周期");
    const evidence = readJson(args.evidence);
    const result = validatePlanEvidence(evidence, reportWindow, {
      expectedPlans,
    });
    printResult(result, Boolean(args.json));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    printResult(
      { ok: false, errors: [error.message], warnings: [], checks: {} },
      Boolean(args.json),
    );
    process.exit(1);
  }
}
