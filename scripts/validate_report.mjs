#!/usr/bin/env node

import fs from "node:fs";
import {
  parseArgs,
  parseWindow,
  printResult,
  requireOptions,
} from "./lib.mjs";
import { validatePlanEvidence } from "./validate_plan_evidence.mjs";
import { validateGcrmEvidence } from "../dependencies/gcrm-core/validate-evidence.mjs";

const HELP = `
检查精品大店报告是否满足完整交付底线。

用法：
  node scripts/validate_report.mjs \\
    --report <report.md|html|xml|txt|-> \\
    --merchant-window 2026-07-01..2026-07-26 \\
    --gcrm-window 2026-06-29..2026-07-28 \\
    --generated-date 2026-07-29 \\
    --plan-evidence <plan-evidence.json> \\
    --gcrm-evidence <gcrm-evidence.json> \\
    [--expected-gcrm-products <数量>] [--expected-top 3] [--json]

完整交付必须读取结构化 gcrm-evidence.json，并由证据自动推导：
  - verified：真实查询完成，且所有候选证据完整；
  - verified_no_candidate：真实查询完成、读取行数可证，但没有合格候选；
  - partial：未查询、授权/能力/筛选失败、用户跳过或证据不完整，只能生成部分草稿。

--gcrm-mode 已废弃。模型不能自行选择状态，也不能用 unavailable 绕过营销参谋。
完整交付还必须读取 plan-evidence.json，由程序核算重组型/精修型与默认排序。
--report - 可从标准输入读取。
`.trim();

function readText(filePath, label) {
  if (filePath === "-") return fs.readFileSync(0, "utf8");
  if (!fs.existsSync(filePath)) throw new Error(`${label}不存在：${filePath}`);
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label}不存在：${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error.message}`);
  }
}

function canonicalizeDates(text) {
  return text
    .replace(
      /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g,
      (_, year, month, day) =>
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    )
    .replace(
      /(\d{4})[/.](\d{1,2})[/.](\d{1,2})/g,
      (_, year, month, day) =>
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    );
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(
      /<(?:img|image)\b[^>]*\b(?:src|href|token)\s*=\s*["']([^"']+)["'][^>]*>/gi,
      " $1 ",
    )
    .replace(
      /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      " $1 $2 ",
    )
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)]\(([^)]*)\)/g, "$1 $2")
    .replace(/\[([^\]]+)]\(([^)]*)\)/g, "$1 $2")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function reportContains(text, value) {
  const needle = normalizeText(value);
  return needle !== "" && normalizeText(text).includes(needle);
}

function reportContainsCategoryState(text, category) {
  if (category?.l2_status === "selected") {
    return reportContains(text, category.l2);
  }
  if (reportContains(text, category?.l2_status)) return true;
  const normalized = normalizeText(text);
  if (category?.l2_status === "not_available") {
    return /二级类目[^。；;\n]{0,12}(?:不可用|无可用选项|未提供)/i.test(
      normalized,
    );
  }
  if (category?.l2_status === "not_supported") {
    return /二级类目[^。；;\n]{0,12}(?:不支持|未支持)/i.test(normalized);
  }
  return false;
}

function countUniqueMatches(text, pattern) {
  return new Set([...text.matchAll(pattern)].map((match) => match[0])).size;
}

function rankEvidence(text) {
  const patterns = [
    /(?:精品店|店铺方案|方案|优先级|top)\s*[#：:－—-]*\s*(10|[1-9]|一|二|三|四|五|六|七|八|九|十)(?=\s|[｜|:：.、）)\-—]|$)/gi,
    /(?:^|\n)\s*(?:#{1,6}\s*)?(10|[1-9]|一|二|三|四|五|六|七|八|九|十)[.、）)]\s*[^\n]{0,30}(?:店|方案)/gim,
  ];
  const ranks = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      ranks.add(String(rankNumber(raw)));
    }
  }
  return ranks;
}

function rankNumber(value) {
  const chineseRanks = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  return chineseRanks[value] ?? Number(value);
}

function cleanThemeName(value) {
  return String(value ?? "")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[｜|:：.、）)\-—]+\s*$/g, "")
    .trim();
}

function extractThemeHeadings(text) {
  const readable = String(text)
    .replace(/<\/h[1-6]\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const byRank = new Map();
  const patterns = [
    /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:精品店|店铺方案|方案)\s*(10|[1-9]|一|二|三|四|五|六|七|八|九|十)\s*[｜|:：.、）)\-—]+\s*(.+?)\s*$/i,
    /^\s*(?:#{1,6}\s*)?(?:\*\*)?(10|[1-9]|一|二|三|四|五|六|七|八|九|十)[.、）)]\s*(.+?(?:店|方案))\s*$/i,
  ];
  for (const line of readable.split(/\r?\n/)) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const rank = rankNumber(match[1]);
      const name = cleanThemeName(match[2]);
      if (!name) break;
      const names = byRank.get(rank) ?? new Set();
      names.add(name);
      byRank.set(rank, names);
      break;
    }
  }
  return byRank;
}

function themeNameMatches(reportName, evidenceName) {
  const compactSeparators = (value) =>
    normalizeText(cleanThemeName(value)).replace(
      /\s*([·｜|—-])\s*/g,
      "$1",
    );
  const reportValue = compactSeparators(reportName);
  const evidenceValue = compactSeparators(evidenceName);
  if (!reportValue || !evidenceValue) return false;
  if (reportValue === evidenceValue) return true;
  return ["·", "｜", "|", "—", "-"].some((separator) =>
    reportValue.endsWith(`${separator}${evidenceValue}`),
  );
}

function validateThemeRendering(
  text,
  evidence,
  expectedTop,
  errors,
) {
  const reportThemes = extractThemeHeadings(text);
  const successfulQueries = (Array.isArray(evidence.queries)
    ? evidence.queries
    : []
  ).filter((query) => query?.result_status === "success");

  for (let rank = 1; rank <= expectedTop; rank += 1) {
    const evidenceNames = [
      ...new Set(
        successfulQueries
          .filter((query) => query?.theme_rank === rank)
          .map((query) => query?.theme_name)
          .filter((name) => String(name ?? "").trim() !== ""),
      ),
    ];
    const reportNames = [...(reportThemes.get(rank) ?? [])];
    if (reportNames.length === 0) {
      errors.push(
        `报告未识别到精品店主题 ${rank} 的明确标题，无法核对 GCRM 主题映射。`,
      );
      continue;
    }
    if (reportNames.length > 1) {
      errors.push(
        `报告中的精品店主题 ${rank} 出现多个标题：${reportNames.join(" / ")}。`,
      );
    }
    for (const evidenceName of evidenceNames) {
      if (
        !reportNames.some((reportName) =>
          themeNameMatches(reportName, evidenceName),
        )
      ) {
        errors.push(
          `主题序号 ${rank} 的 GCRM theme_name“${evidenceName}”与报告标题“${reportNames.join(" / ")}”不一致。`,
        );
      }
    }
  }

  return reportThemes;
}

function findHardCountDirectives(text) {
  const patterns = [
    /(?:只|仅)\s*保留\s*[一二三四五六七八九十\d]+(?:\s*[–—~-]\s*[一二三四五六七八九十\d]+)?\s*(?:个|款|档|种)/gi,
    /(?:只|仅)\s*保留[^。；;\n]{0,45}[一二三四五六七八九十\d]+(?:\s*[–—~-]\s*[一二三四五六七八九十\d]+)?\s*(?:个|款|档|种)/gi,
    /最多\s*(?:(?:只|仅)\s*)?(?:保留\s*)?[一二三四五六七八九十\d]+(?:\s*[–—~-]\s*[一二三四五六七八九十\d]+)?\s*(?:个|款|档|种)/gi,
    /保留\s*[一二三四五六七八九十\d]+(?:\s*[–—~-]\s*[一二三四五六七八九十\d]+)?\s*(?:个|款|档|种)[^。；;\n]{0,30}(?:主推|主款|尺寸|规格|价带|套装)/gi,
    /(?:主推款|主款)\s*[+＋]\s*[一二三四五六七八九十\d]+\s*(?:个|款|档|种)?/gi,
    /[一二三四五六七八九十\d]+\s*(?:个|款|档|种)\s*(?:主推款|主款|尺寸|规格)/gi,
    /(?:首批|首屏|每店)\s*(?:只|仅|先)?\s*(?:上|放|保留)\s*[一二三四五六七八九十\d]+(?:\s*[–—~-]\s*[一二三四五六七八九十\d]+)?\s*(?:个|款|档|种)/gi,
    /固定\s*[一二三四五六七八九十\d]+(?:\s*[–—~-]\s*[一二三四五六七八九十\d]+)?\s*(?:个|款|档|种)?\s*(?:主推|主款|尺寸|规格|价带)/gi,
    /keep\s+only\s+\d+\s+(?:hero\s+)?(?:sku|product|size|variant)s?/gi,
  ];
  const matches = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      matches.push(match[0].replace(/\s+/g, " ").trim());
    }
  }
  return [...new Set(matches)];
}

function validateCandidateRendering(text, evidence, errors) {
  const requiredFields = [
    ["theme_name", "对应精品店主题"],
    ["product_id", "Product ID"],
    ["original_title", "原始标题"],
    ["chinese_name", "简洁中文名"],
    ["original_shop_name", "营销参谋原 Shop Name"],
    ["country", "国家"],
    ["gmv_range", "GMV 区间"],
    ["growth_range", "涨幅/增长区间"],
    ["filter_url", "筛选 URL"],
    ["captured_at", "采集时间"],
  ];

  for (const [index, candidate] of evidence.candidates.entries()) {
    for (const [field, label] of requiredFields) {
      if (!reportContains(text, candidate[field])) {
        errors.push(
          `补品 ${candidate.product_id ?? index + 1} 的${label}未在报告中原样展示。`,
        );
      }
    }
    if (!reportContains(text, candidate.category?.l1)) {
      errors.push(
        `补品 ${candidate.product_id ?? index + 1} 的一级类目未在报告中展示。`,
      );
    }
    if (!reportContainsCategoryState(text, candidate.category)) {
      errors.push(
        `补品 ${candidate.product_id ?? index + 1} 的二级类目或筛选状态未在报告中展示。`,
      );
    }
    for (const [channel, range] of Object.entries(
      candidate.channel_ranges ?? {},
    )) {
      if (!reportContains(text, range)) {
        errors.push(
          `补品 ${candidate.product_id ?? index + 1} 的 ${channel} 渠道区间未在报告中展示。`,
        );
      }
    }
    const imageReference = candidate.image_url ?? candidate.screenshot_ref;
    if (!reportContains(text, imageReference)) {
      errors.push(
        `补品 ${candidate.product_id ?? index + 1} 的图片或对应截图未嵌入报告。`,
      );
    }
  }
}

function validateQueriesWithoutCandidatesRendering(text, queries, errors) {
  for (const [index, query] of queries.entries()) {
    const label = query.query_id ?? `查询 ${index + 1}`;
    for (const [value, description] of [
      [query.theme_name, "对应精品店主题"],
      [query.country, "国家"],
      [query.category?.l1, "一级类目"],
      [query.filter_url, "筛选 URL"],
      [query.captured_at, "采集时间"],
      [query.no_candidate_reason, "未入选原因"],
    ]) {
      if (!reportContains(text, value)) {
        errors.push(`${label} 的${description}未在 no-candidate 证据区展示。`);
      }
    }
    if (!reportContainsCategoryState(text, query.category)) {
      errors.push(`${label} 的二级类目或筛选状态未在证据区展示。`);
    }
    const rowCountPattern = new RegExp(
      `(?:读取|读到|行数|row\\s*count)[^。；;\\n]{0,16}${query.row_count}(?:\\s*行)?`,
      "i",
    );
    if (!rowCountPattern.test(text)) {
      errors.push(`${label} 的实际读取行数 ${query.row_count} 未在报告中展示。`);
    }
    const proofReference =
      query.proof?.screenshot_ref ??
      query.proof?.dom_snapshot_ref ??
      query.proof?.export_ref;
    if (!reportContains(text, proofReference)) {
      errors.push(`${label} 的查询证据引用未在报告中展示。`);
    }
  }
}

function validateNoCandidateRendering(text, evidence, errors) {
  if (
    !/(?:无|没有|暂无|未找到)[^。\n]{0,20}(?:合格|有效|适配)[^。\n]{0,12}(?:补品|候选)|本主题暂不补品/i.test(
      text,
    )
  ) {
    errors.push("verified_no_candidate 必须明确写明没有合格补品候选。");
  }
  validateQueriesWithoutCandidatesRendering(
    text,
    Array.isArray(evidence.queries) ? evidence.queries : [],
    errors,
  );
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reportContainsLabeledPercentage(text, labels, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const labelPattern = labels.map(escapeRegularExpression).join("|");
  const normalized = canonicalizeDates(text)
    .replace(/\s+/g, " ")
    .toLowerCase();
  const pattern = new RegExp(
    `(?:${labelPattern})[^\\d%]{0,30}(-?\\d+(?:\\.\\d+)?)\\s*%`,
    "gi",
  );
  return [...normalized.matchAll(pattern)].some(
    (match) => Math.abs(Number(match[1]) / 100 - value) <= 0.005,
  );
}

function reportContainsSourceShopCount(text, value) {
  const normalized = text.replace(/\s+/g, " ");
  return new RegExp(
    `(?:来源店铺数|来源\\s*shop(?:\\s*id)?\\s*数|来源店铺)[^\\d]{0,20}${value}(?!\\d)`,
    "i",
  ).test(normalized);
}

function extractPlanSections(text) {
  const readable = String(text)
    .replace(
      /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi,
      (_match, body) => `\n### ${body.replace(/<[^>]+>/g, " ")}\n`,
    )
    .replace(/<br\s*\/?>/gi, "\n");
  const lines = readable.split(/\r?\n/);
  const headingPattern =
    /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:精品店|店铺方案|方案)\s*(10|[1-9]|一|二|三|四|五|六|七|八|九|十)\s*[｜|:：.、）)\-—]+/i;
  const sections = new Map();
  let activeRank = null;
  let buffer = [];
  const flush = () => {
    if (activeRank === null) return;
    const existing = sections.get(activeRank) ?? "";
    sections.set(
      activeRank,
      `${existing}${existing ? "\n" : ""}${buffer.join("\n")}`,
    );
  };
  for (const line of lines) {
    const match = line.match(headingPattern);
    if (match) {
      flush();
      activeRank = rankNumber(match[1]);
      buffer = [line];
    } else if (activeRank !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function validatePlanRendering(text, planEvidence, errors) {
  const labels = {
    reorganization: "重组型",
    refinement: "精修型",
  };
  const plans = Array.isArray(planEvidence?.plans) ? planEvidence.plans : [];
  const sections = extractPlanSections(text);
  for (const [index, plan] of plans.entries()) {
    const label = `方案 ${plan.rank ?? index + 1}`;
    const section = sections.get(plan.rank);
    if (!section) {
      errors.push(`${label} 缺少可独立核对的带序号方案区块。`);
      continue;
    }
    for (const [field, description] of [
      ["theme_name", "主题名"],
      ["target_shop_id", "承接店 Shop ID"],
      ["target_shop_name", "承接店名"],
      ["priority_reason", "排序理由"],
    ]) {
      if (!reportContains(section, plan[field])) {
        errors.push(`${label} 的${description}未在报告中展示。`);
      }
    }
    const classificationLabel = labels[plan.classification];
    if (!reportContains(section, classificationLabel)) {
      errors.push(`${label} 的方案类型 ${classificationLabel} 未在报告中展示。`);
    }
    if (
      !reportContainsLabeledPercentage(
        section,
        ["承接店内已有 gmv 占比", "店内已有 gmv 占比", "店内占比"],
        plan.target_shop_existing_gmv_share,
      )
    ) {
      errors.push(`${label} 的承接店内已有 GMV 占比未在报告中展示。`);
    }
    if (
      !reportContainsLabeledPercentage(
        section,
        ["店外候选 gmv 占比", "店外 gmv 占比", "店外占比"],
        plan.outside_shop_gmv_share,
      )
    ) {
      errors.push(`${label} 的店外候选 GMV 占比未在报告中展示。`);
    }
    if (!reportContainsSourceShopCount(section, plan.source_shop_count)) {
      errors.push(`${label} 的来源店铺数 ${plan.source_shop_count} 未在报告中展示。`);
    }
    if (
      plan.ranking_override?.enabled === true &&
      !reportContains(section, plan.ranking_override.explanation)
    ) {
      errors.push(`${label} 的精修型前置例外理由未在报告中展示。`);
    }
  }
}

function validateReport(
  text,
  merchantWindow,
  gcrmWindow,
  generatedDate,
  expectedTop,
  planEvidence,
  planResult,
  evidence,
  evidenceResult,
  expectedGcrmProducts,
) {
  const errors = [...planResult.errors, ...evidenceResult.errors];
  const warnings = [...planResult.warnings, ...evidenceResult.warnings];
  const normalized = canonicalizeDates(text);

  for (const [label, window] of [
    ["客户货盘周期", merchantWindow],
    ["营销参谋周期", gcrmWindow],
  ]) {
    if (!normalized.includes(window.start) || !normalized.includes(window.end)) {
      errors.push(`${label}未完整展示 ${window.start} 至 ${window.end}。`);
    }
  }
  if (!normalized.includes(generatedDate)) {
    errors.push(`生成日未展示 ${generatedDate}。`);
  }

  const ranks = rankEvidence(text);
  const topPhrase = new RegExp(`top\\s*${expectedTop}`, "i").test(text);
  const shopIds = countUniqueMatches(text, /\b7\d{18}\b/g);
  const enoughRanks = Array.from(
    { length: expectedTop },
    (_, index) => String(index + 1),
  ).every((rank) => ranks.has(rank));
  if (!enoughRanks && !topPhrase) {
    errors.push(`未识别到完整 Top ${expectedTop} 精品店结构；需明确标出 1–${expectedTop}。`);
  }
  if (shopIds < expectedTop) {
    errors.push(
      `承接店 Shop ID 不足：期望至少 ${expectedTop} 个唯一 19 位 Shop ID，实际 ${shopIds} 个。`,
    );
  }
  const reportThemes = validateThemeRendering(
    text,
    evidence,
    expectedTop,
    errors,
  );
  validatePlanRendering(text, planEvidence, errors);
  const plansByRank = new Map(
    (Array.isArray(planEvidence?.plans) ? planEvidence.plans : []).map(
      (plan) => [plan.rank, plan],
    ),
  );
  for (const query of Array.isArray(evidence.queries) ? evidence.queries : []) {
    if (query?.result_status !== "success") continue;
    const plan = plansByRank.get(query.theme_rank);
    if (!plan) {
      errors.push(
        `GCRM 主题序号 ${query.theme_rank} 在 plan-evidence.json 中没有对应方案。`,
      );
    } else if (!themeNameMatches(plan.theme_name, query.theme_name)) {
      errors.push(
        `方案 ${query.theme_rank} 的 plan theme_name“${plan.theme_name}”与 GCRM theme_name“${query.theme_name}”不一致。`,
      );
    }
  }

  if (!/(营销参谋|GCRM)/i.test(text)) {
    errors.push("未识别到营销参谋/GCRM 证据区。");
  }

  if (!evidenceResult.complete) {
    errors.push(
      "营销参谋证据未达到完整交付状态；当前结果只能标为“部分草稿”，不能作为完整报告交付。",
    );
  } else if (evidenceResult.status === "verified") {
    validateCandidateRendering(text, evidence, errors);
    const candidateQueryIds = new Set(
      (Array.isArray(evidence.candidates) ? evidence.candidates : []).map(
        (candidate) => candidate?.query_id,
      ),
    );
    const queriesWithoutCandidates = (
      Array.isArray(evidence.queries) ? evidence.queries : []
    ).filter(
      (query) =>
        query?.result_status === "success" &&
        !candidateQueryIds.has(query?.query_id),
    );
    validateQueriesWithoutCandidatesRendering(
      text,
      queriesWithoutCandidates,
      errors,
    );
  } else if (evidenceResult.status === "verified_no_candidate") {
    validateNoCandidateRendering(text, evidence, errors);
  }

  if (
    expectedGcrmProducts !== null &&
    expectedGcrmProducts !==
      (Array.isArray(evidence.candidates) ? evidence.candidates.length : 0)
  ) {
    errors.push(
      `--expected-gcrm-products=${expectedGcrmProducts} 与证据候选数 ${Array.isArray(evidence.candidates) ? evidence.candidates.length : 0} 不一致。`,
    );
  }

  const hardDirectives = findHardCountDirectives(text);
  if (hardDirectives.length > 0) {
    errors.push(
      `发现硬性限定主推款/尺寸/规格数量的措辞：${hardDirectives
        .slice(0, 5)
        .map((value) => `“${value}”`)
        .join("、")}。请改为“标注重叠与候选组合，由商家结合库存、毛利、供应链和履约决定最终数量/规格”。`,
    );
  }

  return {
    ok: errors.length === 0,
    complete: errors.length === 0,
    delivery_status: errors.length === 0 ? "complete" : "partial_draft",
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    messages: [
      `周期：客户货盘 ${merchantWindow.display}；营销参谋 ${gcrmWindow.display}；生成日 ${generatedDate}`,
      `Top ${expectedTop} 结构：${enoughRanks || (topPhrase && shopIds >= expectedTop) ? "已识别" : "未识别"}`,
      `方案证据：重组型 ${planResult.checks.reorganization_count ?? 0}；精修型 ${planResult.checks.refinement_count ?? 0}`,
      `营销参谋证据推导：${evidenceResult.status}；真实查询 ${evidenceResult.checks.query_count ?? 0}；候选 ${evidenceResult.checks.candidate_count ?? 0}`,
      `交付状态：${errors.length === 0 ? "complete" : "partial_draft"}`,
    ],
    checks: {
      expected_top: expectedTop,
      plan_evidence_valid: planResult.ok,
      plan_count: planResult.checks.plan_count ?? 0,
      reorganization_count:
        planResult.checks.reorganization_count ?? 0,
      refinement_count: planResult.checks.refinement_count ?? 0,
      plan_classifications: planResult.checks.derived_plans ?? [],
      explicit_ranks: [...ranks].sort(),
      unique_19_digit_shop_ids: shopIds,
      gcrm_status: evidenceResult.status,
      gcrm_query_count: evidenceResult.checks.query_count ?? 0,
      gcrm_successful_query_count:
        evidenceResult.checks.successful_query_count ?? 0,
      gcrm_candidate_count: evidenceResult.checks.candidate_count ?? 0,
      report_theme_headings: Object.fromEntries(
        [...reportThemes.entries()].map(([rank, names]) => [
          rank,
          [...names],
        ]),
      ),
      generated_date: generatedDate,
      hard_count_directives: hardDirectives,
    },
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

try {
  requireOptions(args, [
    "report",
    "merchant-window",
    "gcrm-window",
    "generated-date",
    "plan-evidence",
    "gcrm-evidence",
  ]);
  const expectedTop = Number(args["expected-top"] ?? 3);
  if (!Number.isInteger(expectedTop) || expectedTop < 1 || expectedTop > 10) {
    throw new Error("--expected-top 必须是 1–10 的整数。");
  }
  let expectedGcrmProducts = null;
  if (Object.prototype.hasOwnProperty.call(args, "expected-gcrm-products")) {
    expectedGcrmProducts = Number(args["expected-gcrm-products"]);
    if (
      !Number.isInteger(expectedGcrmProducts) ||
      expectedGcrmProducts < 0 ||
      expectedGcrmProducts > 100
    ) {
      throw new Error("--expected-gcrm-products 必须是 0–100 的整数。");
    }
  }

  const merchantWindow = parseWindow(args["merchant-window"], "客户货盘周期");
  const gcrmWindow = parseWindow(args["gcrm-window"], "营销参谋周期");
  const generatedDate = parseWindow(
    `${args["generated-date"]}..${args["generated-date"]}`,
    "生成日",
  ).start;
  const text = readText(args.report, "报告");
  const planEvidence = readJson(args["plan-evidence"], "方案证据文件");
  const planResult = validatePlanEvidence(planEvidence, merchantWindow, {
    expectedPlans: expectedTop,
  });
  const evidence = readJson(args["gcrm-evidence"], "GCRM 证据文件");
  const evidenceResult = validateGcrmEvidence(evidence, gcrmWindow, {
    expectedThemeCount: expectedTop,
  });
  const result = validateReport(
    text,
    merchantWindow,
    gcrmWindow,
    generatedDate,
    expectedTop,
    planEvidence,
    planResult,
    evidence,
    evidenceResult,
    expectedGcrmProducts,
  );
  if (Object.prototype.hasOwnProperty.call(args, "gcrm-mode")) {
    result.warnings.push(
      "--gcrm-mode 已废弃并被忽略；营销参谋状态只由 --gcrm-evidence 推导。",
    );
  }
  printResult(result, Boolean(args.json));
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  printResult(
    {
      ok: false,
      complete: false,
      delivery_status: "partial_draft",
      errors: [error.message],
      warnings: [],
    },
    Boolean(args.json),
  );
  process.exit(1);
}
