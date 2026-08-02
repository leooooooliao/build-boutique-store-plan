#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const taxonomy = JSON.parse(
  fs.readFileSync(path.join(here, "filter-taxonomy.json"), "utf8"),
);

const COMPLETE_BROWSER_STATES = new Set([
  "evidence_collected",
  "evidence_validated",
]);
const KNOWN_BROWSER_STATES = new Set([
  "not_checked",
  "permission_needed",
  "browser_ready",
  "page_ready",
  "filters_verified",
  ...COMPLETE_BROWSER_STATES,
  "auth_required",
  "capability_blocked",
  "filter_failed",
  "user_skipped",
  "unavailable",
]);
const QUERY_STATUSES = new Set([
  "success",
  "auth_required",
  "capability_blocked",
  "filter_failed",
  "unavailable",
]);
const L2_STATUSES = new Set(["selected", "not_available", "not_supported"]);
const CAPTURE_METHODS = new Set(["xhr", "dom", "export", "visible_table"]);
const BROWSER_ADAPTER_TYPES = new Set(["aime_chrome", "other_local"]);
const LOCAL_SESSION_MODE = "local_authenticated_browser";
const AUTOMATED_BROWSER_PATHS = new Set([
  "direct_url_then_verify",
  "tree_select_expand_sea_if_needed",
  "dom_locator_auto_scroll",
  "level_two_dom_locator_auto_scroll",
  "popup_scoped_visual_scroll",
  "same_authenticated_session_xhr_or_api",
  "page_export",
  "visible_table_read",
]);
const CANDIDATE_ALLOWED_FIELDS = new Set([
  "query_id",
  "theme_rank",
  "theme_name",
  "product_id",
  "original_title",
  "chinese_name",
  "original_shop_name",
  "country",
  "category",
  "window",
  "gmv_range",
  "average_price",
  "ads_cost_range",
  "tr_estimate",
  "tr_unavailable_reason",
  "growth_range",
  "channel_ranges",
  "image_url",
  "screenshot_ref",
  "filter_url",
  "captured_at",
]);
const RECOVERY_REQUIRED_BROWSER_STATES = new Set([
  "capability_blocked",
  "filter_failed",
  "unavailable",
]);
const PLACEHOLDER_PATTERN =
  /^(?:[-—–]|未知|待补|待定位|待查询|空|null|none|n\/?a|unavailable|placeholder)$/i;
const FORBIDDEN_MANUAL_PATH_PATTERN =
  /(?:user[_ -]?(?:manual|select)|ask[_ -]?user|manual[_ -]?(?:filter|select|handoff)|handoff|用户.*(?:手选|切换|切好|代选)|人工.*(?:筛选|切换|代选)|请用户.*(?:选择|切换|切好|回复))/i;
const NONLOCAL_ADAPTER_PATTERN = /(?:cloud|remote|sandbox|headless|云端|远程|沙箱)/i;
const OPEN_AMOUNT_RANGE_PATTERN =
  /[<>≤≥]|\d\s*\+\s*$|以上|以下|起步|起|低于|高于|不低于|不高于|(?:^|\s)(?:under|over|above|below|up\s+to|more\s+than|less\s+than)(?:\s|$)/i;
const TR_ABSOLUTE_TOLERANCE = 0.001;
const TR_RELATIVE_TOLERANCE = 0.001;

function parseArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    if (["json", "help", "h"].includes(key)) {
      args[key] = true;
      continue;
    }
    args[key] = argv[index + 1] ?? "";
    index += 1;
  }
  return args;
}

function parseWindow(value) {
  const match = String(value ?? "").match(
    /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/,
  );
  if (!match || !validDate(match[1]) || !validDate(match[2]) || match[1] > match[2]) {
    throw new Error("--report-window 必须是有效的 YYYY-MM-DD..YYYY-MM-DD。");
  }
  return { start: match[1], end: match[2] };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function validDateTime(value) {
  if (
    typeof value !== "string" ||
    !/[T ]/.test(value) ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return false;
  }
  return Number.isFinite(new Date(value).getTime());
}

function nonPlaceholder(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return (
    normalized !== "" &&
    !PLACEHOLDER_PATTERN.test(normalized) &&
    !normalized.includes("{{") &&
    !normalized.includes("}}")
  );
}

function validUrl(value, requireGcrm = false) {
  try {
    const url = new URL(String(value ?? ""));
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (!requireGcrm) return true;
    return (
      /(?:^|\.)tiktok-row\.net$/i.test(url.hostname) &&
      /marketing-advisor\/product-insights\/top-product/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function sameWindow(left, right) {
  return left?.start === right.start && left?.end === right.end;
}

function normalizeCountry(value) {
  const raw = String(value ?? "").trim();
  const validCountries = [
    ...taxonomy.countries.top_level,
    ...taxonomy.countries.sea_children,
  ];
  const direct = validCountries.find(
    (country) => country.toLowerCase() === raw.toLowerCase(),
  );
  if (direct) return direct;
  const alias = Object.entries(taxonomy.country_aliases).find(
    ([key]) => key.toLowerCase() === raw.toLowerCase(),
  );
  return alias?.[1] ?? null;
}

function validateCategory(category, label, errors) {
  if (!category || typeof category !== "object" || Array.isArray(category)) {
    errors.push(`${label}.category 必须是对象。`);
    return;
  }
  if (!taxonomy.level_1_categories.includes(category.l1)) {
    errors.push(
      `${label}.category.l1“${String(category.l1 ?? "")}”不在 taxonomy ${taxonomy.taxonomy_snapshot} 中。`,
    );
  }
  if (!L2_STATUSES.has(category.l2_status)) {
    errors.push(
      `${label}.category.l2_status 必须是 selected、not_available 或 not_supported。`,
    );
  }
  if (category.l2_status === "selected" && !nonPlaceholder(category.l2)) {
    errors.push(`${label}.category.l2_status=selected 时必须保留二级类目原文。`);
  }
  if (
    ["not_available", "not_supported"].includes(category.l2_status) &&
    category.l2 !== null &&
    String(category.l2 ?? "").trim() !== ""
  ) {
    errors.push(`${label}.category 未选择二级类目时 l2 必须为 null。`);
  }
}

function validateWindow(window, expectedWindow, label, errors) {
  if (
    !window ||
    !validDate(window.start) ||
    !validDate(window.end) ||
    window.start > window.end
  ) {
    errors.push(`${label}.window 必须包含有效的 start/end。`);
    return;
  }
  if (!sameWindow(window, expectedWindow)) {
    errors.push(
      `${label}.window 必须与报告周期 ${expectedWindow.start}..${expectedWindow.end} 一致。`,
    );
  }
}

function validateProof(proof, label, errors) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    errors.push(`${label}.proof 缺失。`);
    return;
  }
  if (!CAPTURE_METHODS.has(proof.capture_method)) {
    errors.push(
      `${label}.proof.capture_method 必须是 xhr、dom、export 或 visible_table。`,
    );
  }
  const references = [
    proof.screenshot_ref,
    proof.dom_snapshot_ref,
    proof.export_ref,
  ].filter(nonPlaceholder);
  if (references.length === 0) {
    errors.push(
      `${label}.proof 必须包含 screenshot_ref、dom_snapshot_ref 或 export_ref 中至少一项。`,
    );
  }
}

function validateQuery(query, index, expectedWindow, errors) {
  const label = `queries[${index}]`;
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    errors.push(`${label} 必须是对象。`);
    return;
  }
  if (!nonPlaceholder(query.query_id)) errors.push(`${label}.query_id 缺失。`);
  if (!Number.isInteger(query.theme_rank) || query.theme_rank < 1 || query.theme_rank > 10) {
    errors.push(`${label}.theme_rank 必须是 1–10 的整数。`);
  }
  if (!nonPlaceholder(query.theme_name)) {
    errors.push(`${label}.theme_name 缺失。`);
  }
  if (!normalizeCountry(query.country)) {
    errors.push(`${label}.country“${String(query.country ?? "")}”不是当前有效国家。`);
  }
  validateCategory(query.category, label, errors);
  validateWindow(query.window, expectedWindow, label, errors);
  if (!validUrl(query.filter_url, true)) {
    errors.push(`${label}.filter_url 必须是筛选后的 GCRM Top Product 页面 URL。`);
  }
  if (!validDateTime(query.captured_at)) {
    errors.push(`${label}.captured_at 必须是含时区的有效时间。`);
  }
  if (!QUERY_STATUSES.has(query.result_status)) {
    errors.push(`${label}.result_status 无效。`);
  }
  if (!Number.isInteger(query.row_count) || query.row_count < 0) {
    errors.push(`${label}.row_count 必须是大于等于 0 的整数。`);
  }
  if (typeof query.l2_attempted !== "boolean") {
    errors.push(`${label}.l2_attempted 必须是布尔值。`);
  }
  if (
    (query.result_status === "success" ||
      query.category?.l2_status === "selected") &&
    query.l2_attempted !== true
  ) {
    errors.push(`${label} 成功查询或已选二级类目时 l2_attempted 必须为 true。`);
  }
  if (
    ["not_available", "not_supported"].includes(query.category?.l2_status) &&
    !nonPlaceholder(query.l2_status_reason)
  ) {
    errors.push(
      `${label}.l2_status_reason 缺失；二级类目不可用或页面不支持时必须保留核验原因。`,
    );
  }
  validateProof(query.proof, label, errors);
}

function categoryMatches(candidate, query) {
  return (
    candidate?.l1 === query?.l1 &&
    candidate?.l2_status === query?.l2_status &&
    String(candidate?.l2 ?? "") === String(query?.l2 ?? "")
  );
}

function amountMultiplier(unit) {
  const normalized = String(unit ?? "").toUpperCase();
  if (normalized === "K") return 1_000;
  if (normalized === "M") return 1_000_000;
  if (normalized === "B") return 1_000_000_000;
  return 1;
}

export function parseAmountRange(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return { lower: value, upper: value, midpoint: value };
  }

  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw || OPEN_AMOUNT_RANGE_PATTERN.test(raw)) return null;

  const tokenPattern = /(\d+(?:\.\d+)?)\s*([KMB])?/gi;
  const matches = [...raw.matchAll(tokenPattern)];
  if (matches.length < 1 || matches.length > 2) return null;

  const residual = raw
    .replace(/(\d+(?:\.\d+)?)\s*([KMB])?/gi, "")
    .replace(/\b(?:USD|MYR|RM|PHP|VND|IDR|THB|SGD|EUR|GBP)\b/gi, "")
    .replace(/[\s$€£¥₫₱₹()\[\]{}:：/–—~～至-]/g, "")
    .replace(/\bto\b/gi, "");
  if (residual !== "") return null;

  if (matches.length === 2) {
    const between = raw.slice(
      (matches[0].index ?? 0) + matches[0][0].length,
      matches[1].index ?? raw.length,
    );
    if (!/(?:-|–|—|~|～|至|\bto\b)/i.test(between)) return null;
  }

  const parsed = matches.map((match) => ({
    rawNumber: Number(match[1]),
    unit: String(match[2] ?? "").toUpperCase(),
  }));
  if (parsed.some((item) => !Number.isFinite(item.rawNumber))) return null;

  if (parsed.length === 2) {
    const [left, right] = parsed;
    if (!left.unit && right.unit && left.rawNumber < right.rawNumber) {
      left.unit = right.unit;
    }
    if (left.unit && !right.unit) {
      const rawUpper = right.rawNumber;
      const scaledLower = left.rawNumber * amountMultiplier(left.unit);
      if (rawUpper < scaledLower) right.unit = left.unit;
    }
  }

  const lower = parsed[0].rawNumber * amountMultiplier(parsed[0].unit);
  const upperItem = parsed[1] ?? parsed[0];
  const upper = upperItem.rawNumber * amountMultiplier(upperItem.unit);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || upper < lower) {
    return null;
  }
  return { lower, upper, midpoint: (lower + upper) / 2 };
}

function validAveragePrice(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    /\d/.test(value)
  );
}

function validateCandidateMetrics(candidate, label, errors) {
  if (!validAveragePrice(candidate.average_price)) {
    errors.push(`${label}.average_price 必须保留页面展示的数值客单价。`);
  }
  if (
    typeof candidate.ads_cost_range !== "string" ||
    candidate.ads_cost_range.trim() === ""
  ) {
    errors.push(`${label}.ads_cost_range 必须保留页面展示的广告消耗原值。`);
  }
  if (!Object.hasOwn(candidate, "tr_estimate")) {
    errors.push(`${label}.tr_estimate 缺失。`);
    return;
  }

  const gmv = parseAmountRange(candidate.gmv_range);
  const adsCost = parseAmountRange(candidate.ads_cost_range);
  const canCalculate = gmv && adsCost && gmv.midpoint > 0;

  if (!canCalculate) {
    if (candidate.tr_estimate !== null) {
      errors.push(
        `${label}.tr_estimate 在总 GMV 或广告消耗无法形成有效闭区间中点时必须为 null。`,
      );
    }
    if (!nonPlaceholder(candidate.tr_unavailable_reason)) {
      errors.push(
        `${label}.tr_unavailable_reason 缺失；TR（估）不可计算时必须说明原因。`,
      );
    }
    return;
  }

  if (
    typeof candidate.tr_estimate !== "number" ||
    !Number.isFinite(candidate.tr_estimate) ||
    candidate.tr_estimate < 0
  ) {
    errors.push(
      `${label}.tr_estimate 必须按广告消耗区间中点除以总 GMV 区间中点计算。`,
    );
    return;
  }

  const expected = adsCost.midpoint / gmv.midpoint;
  const tolerance = Math.max(
    TR_ABSOLUTE_TOLERANCE,
    Math.abs(expected) * TR_RELATIVE_TOLERANCE,
  );
  if (Math.abs(candidate.tr_estimate - expected) > tolerance) {
    errors.push(
      `${label}.tr_estimate=${candidate.tr_estimate} 与区间中点公式结果 ${expected.toFixed(6)} 不一致。`,
    );
  }
}

function validateCandidate(
  candidate,
  index,
  queryById,
  expectedWindow,
  errors,
) {
  const label = `candidates[${index}]`;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    errors.push(`${label} 必须是对象。`);
    return;
  }
  if (Object.keys(candidate).some((field) => !CANDIDATE_ALLOWED_FIELDS.has(field))) {
    errors.push(
      `${label} 包含证据合同未声明的字段；候选只能使用 schema 明确列出的字段。`,
    );
  }
  const requiredTextFields = [
    ["theme_name", "对应精品店主题"],
    ["original_title", "原始标题"],
    ["chinese_name", "简洁中文名"],
    ["original_shop_name", "营销参谋原 Shop Name"],
    ["gmv_range", "GMV 区间"],
    ["growth_range", "涨幅/增长区间"],
  ];
  if (!/^1\d{18}$/.test(String(candidate.product_id ?? ""))) {
    errors.push(`${label}.product_id 必须是以 1 开头的 19 位字符串。`);
  }
  if (
    !Number.isInteger(candidate.theme_rank) ||
    candidate.theme_rank < 1 ||
    candidate.theme_rank > 10
  ) {
    errors.push(`${label}.theme_rank 必须是 1–10 的整数。`);
  }
  for (const [field, description] of requiredTextFields) {
    if (!nonPlaceholder(candidate[field])) {
      errors.push(`${label}.${field} 缺失（${description}）。`);
    }
  }
  if (
    nonPlaceholder(candidate.gmv_range) &&
    !/\d/.test(String(candidate.gmv_range))
  ) {
    errors.push(`${label}.gmv_range 必须保留页面数值或数值区间。`);
  }
  validateCandidateMetrics(candidate, label, errors);
  if (
    nonPlaceholder(candidate.growth_range) &&
    !/\d/.test(String(candidate.growth_range)) &&
    String(candidate.growth_range).trim() !== "暂无可靠涨幅"
  ) {
    errors.push(
      `${label}.growth_range 必须保留数值区间；页面无可靠数据时明确写“暂无可靠涨幅”。`,
    );
  }
  if (
    nonPlaceholder(candidate.chinese_name) &&
    !/[\u3400-\u9fff]/u.test(candidate.chinese_name)
  ) {
    errors.push(`${label}.chinese_name 必须包含中文，不能只复制原始标题。`);
  }
  const country = normalizeCountry(candidate.country);
  if (!country) {
    errors.push(`${label}.country“${String(candidate.country ?? "")}”不是当前有效国家。`);
  }
  validateCategory(candidate.category, label, errors);
  validateWindow(candidate.window, expectedWindow, label, errors);
  if (!validUrl(candidate.filter_url, true)) {
    errors.push(`${label}.filter_url 必须是筛选后的 GCRM Top Product 页面 URL。`);
  }
  if (!validDateTime(candidate.captured_at)) {
    errors.push(`${label}.captured_at 必须是有效时间。`);
  }
  if (
    !candidate.channel_ranges ||
    typeof candidate.channel_ranges !== "object" ||
    Array.isArray(candidate.channel_ranges) ||
    Object.keys(candidate.channel_ranges).length === 0 ||
    Object.values(candidate.channel_ranges).some(
      (value) => !nonPlaceholder(value) || !/\d/.test(String(value)),
    )
  ) {
    errors.push(`${label}.channel_ranges 必须至少包含一个带数值的真实渠道区间。`);
  }
  if (!validUrl(candidate.image_url) && !nonPlaceholder(candidate.screenshot_ref)) {
    errors.push(`${label} 必须包含真实 image_url 或对应 screenshot_ref。`);
  }

  const query = queryById.get(candidate.query_id);
  if (!query) {
    errors.push(`${label}.query_id 未关联到 queries。`);
    return;
  }
  if (query.result_status !== "success") {
    errors.push(`${label} 不能关联到 result_status=${query.result_status} 的查询。`);
  }
  if (query.row_count < 1) {
    errors.push(`${label} 关联查询 row_count=0，无法证明该候选来自读取结果。`);
  }
  if (country && country !== normalizeCountry(query.country)) {
    errors.push(`${label}.country 与关联查询不一致。`);
  }
  if (!categoryMatches(candidate.category, query.category)) {
    errors.push(`${label}.category 与关联查询不一致。`);
  }
  if (!sameWindow(candidate.window, query.window)) {
    errors.push(`${label}.window 与关联查询不一致。`);
  }
  if (candidate.filter_url !== query.filter_url) {
    errors.push(`${label}.filter_url 与关联查询不一致。`);
  }
  if (
    candidate.theme_rank !== query.theme_rank ||
    candidate.theme_name !== query.theme_name
  ) {
    errors.push(`${label} 的主题映射与关联查询不一致。`);
  }
}

export function validateGcrmEvidence(
  evidence,
  expectedWindow,
  { expectedThemeCount = null } = {},
) {
  const errors = [];
  const warnings = [];

  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {
      ok: false,
      complete: false,
      status: "partial",
      errors: ["证据根节点必须是 JSON 对象。"],
      warnings,
      checks: {},
    };
  }

  if (evidence.schema_version !== "1.1.0") {
    errors.push("schema_version 必须是 1.1.0。");
  }
  if (evidence.source?.system !== "GCRM Marketing Advisor") {
    errors.push("source.system 必须是 GCRM Marketing Advisor。");
  }
  if (!validUrl(evidence.source?.page_url, true)) {
    errors.push("source.page_url 必须是 GCRM Top Product 页面。");
  }
  if (!validDate(evidence.source?.taxonomy_snapshot)) {
    errors.push("source.taxonomy_snapshot 必须是 YYYY-MM-DD。");
  } else if (
    evidence.source.taxonomy_snapshot !== taxonomy.taxonomy_snapshot
  ) {
    warnings.push(
      `证据 taxonomy_snapshot=${evidence.source.taxonomy_snapshot}，内置快照=${taxonomy.taxonomy_snapshot}；请确认页面类目未变更。`,
    );
  }

  const browser = evidence.browser ?? {};
  if (!KNOWN_BROWSER_STATES.has(browser.state)) {
    errors.push("browser.state 无效。");
  }
  if (!nonPlaceholder(browser.adapter)) {
    errors.push("browser.adapter 缺失。");
  }
  if (!BROWSER_ADAPTER_TYPES.has(browser.adapter_type)) {
    errors.push("browser.adapter_type 必须是 aime_chrome 或 other_local。");
  }
  if (browser.session_mode !== LOCAL_SESSION_MODE) {
    errors.push("browser.session_mode 必须是 local_authenticated_browser。");
  }
  if (
    browser.adapter_type === "aime_chrome" &&
    String(browser.adapter ?? "").trim().toLowerCase() !== "aime chrome"
  ) {
    errors.push("browser.adapter_type=aime_chrome 时 adapter 必须是 Aime Chrome。");
  }
  if (NONLOCAL_ADAPTER_PATTERN.test(String(browser.adapter ?? ""))) {
    errors.push("browser.adapter 必须指向当前本地浏览器，不能使用非本地会话。");
  }
  if (browser.local_authenticated_session !== true) {
    errors.push("必须使用本地已登录浏览器；local_authenticated_session 必须为 true。");
  }
  if (browser.attempted_paths !== undefined) {
    if (!Array.isArray(browser.attempted_paths)) {
      errors.push("browser.attempted_paths 必须是数组。");
    } else {
      const validAttemptedPaths = browser.attempted_paths.filter(nonPlaceholder);
      if (validAttemptedPaths.length !== browser.attempted_paths.length) {
        errors.push("browser.attempted_paths 不能包含空值或占位值。");
      }
      if (
        new Set(validAttemptedPaths.map((value) => String(value).toLowerCase()))
          .size !== validAttemptedPaths.length
      ) {
        errors.push("browser.attempted_paths 不能重复。");
      }
      const manualPaths = validAttemptedPaths.filter((value) =>
        FORBIDDEN_MANUAL_PATH_PATTERN.test(String(value)),
      );
      if (manualPaths.length > 0) {
        errors.push(
          `browser.attempted_paths 不能把逐组人工筛选或交接用户当作恢复路径：${manualPaths.join("、")}。`,
        );
      }
      const unknownPaths = validAttemptedPaths.filter(
        (value) => !AUTOMATED_BROWSER_PATHS.has(value),
      );
      if (unknownPaths.length > 0) {
        errors.push(
          "browser.attempted_paths 只能记录合同允许的自动浏览器路径，不能使用自定义或人工交接路径。",
        );
      }
    }
  }
  if (
    COMPLETE_BROWSER_STATES.has(browser.state) &&
    (!Array.isArray(browser.attempted_paths) ||
      browser.attempted_paths.filter((value) =>
        AUTOMATED_BROWSER_PATHS.has(value),
      ).length < 1)
  ) {
    errors.push(
      `browser.state=${browser.state} 时必须记录至少 1 条合同允许的自动浏览器路径。`,
    );
  }
  if (RECOVERY_REQUIRED_BROWSER_STATES.has(browser.state)) {
    if (
      !Array.isArray(browser.attempted_paths) ||
      browser.attempted_paths.filter((value) =>
        AUTOMATED_BROWSER_PATHS.has(value),
      ).length < 2
    ) {
      errors.push(
        `browser.state=${browser.state} 时必须记录至少 2 条自动恢复路径到 browser.attempted_paths，不能尝试一次就交给用户。`,
      );
    }
  }

  const queries = Array.isArray(evidence.queries) ? evidence.queries : [];
  const candidates = Array.isArray(evidence.candidates)
    ? evidence.candidates
    : [];
  if (!Array.isArray(evidence.queries)) errors.push("queries 必须是数组。");
  if (!Array.isArray(evidence.candidates)) errors.push("candidates 必须是数组。");
  if (queries.length === 0) {
    errors.push("未记录任何真实 GCRM 筛选查询。");
  }

  queries.forEach((query, index) =>
    validateQuery(query, index, expectedWindow, errors),
  );
  const queryIds = queries.map((query) => query?.query_id).filter(nonPlaceholder);
  if (new Set(queryIds).size !== queryIds.length) {
    errors.push("queries.query_id 必须唯一。");
  }
  const queryById = new Map(
    queries
      .filter((query) => nonPlaceholder(query?.query_id))
      .map((query) => [query.query_id, query]),
  );
  candidates.forEach((candidate, index) =>
    validateCandidate(candidate, index, queryById, expectedWindow, errors),
  );

  const candidateKeys = candidates.map(
    (candidate) => `${candidate?.query_id ?? ""}:${candidate?.product_id ?? ""}`,
  );
  if (new Set(candidateKeys).size !== candidateKeys.length) {
    errors.push("同一 query_id 下不能重复记录相同 product_id。");
  }

  const browserComplete = COMPLETE_BROWSER_STATES.has(browser.state);
  const successfulQueries = queries.filter(
    (query) => query?.result_status === "success",
  );
  const failedQueries = queries.filter(
    (query) => query?.result_status !== "success",
  );

  if (!browserComplete) {
    errors.push(
      `browser.state=${String(browser.state ?? "missing")}，尚未完成证据采集。`,
    );
  }
  if (failedQueries.length > 0) {
    errors.push(
      `有 ${failedQueries.length} 个查询未成功；授权失败、控件失败或能力不足只能生成部分草稿。`,
    );
  }
  if (
    !Number.isInteger(expectedThemeCount) ||
    expectedThemeCount < 1 ||
    expectedThemeCount > 10
  ) {
    errors.push(
      "expectedThemeCount 必须是 1–10 的整数；完整验证不能省略实际精品店方案数。",
    );
  } else {
    const successfulThemeRanks = new Set(
      successfulQueries.map((query) => query?.theme_rank),
    );
    const missingThemeRanks = Array.from(
      { length: expectedThemeCount },
      (_, index) => index + 1,
    ).filter((rank) => !successfulThemeRanks.has(rank));
    if (missingThemeRanks.length > 0) {
      errors.push(
        `营销参谋未覆盖全部精品店主题；缺少主题序号 ${missingThemeRanks.join("、")} 的成功查询。`,
      );
    }
    const outOfScopeRanks = queries
      .map((query) => query?.theme_rank)
      .filter(
        (rank) =>
          Number.isInteger(rank) &&
          (rank < 1 || rank > expectedThemeCount),
      );
    if (outOfScopeRanks.length > 0) {
      errors.push(
        `queries 包含超出 Top ${expectedThemeCount} 的主题序号：${[...new Set(outOfScopeRanks)].join("、")}。`,
      );
    }

    const themeNameByRank = new Map();
    for (const query of queries) {
      if (!Number.isInteger(query?.theme_rank) || !nonPlaceholder(query?.theme_name)) {
        continue;
      }
      const normalizedName = String(query.theme_name)
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const names = themeNameByRank.get(query.theme_rank) ?? new Set();
      names.add(normalizedName);
      themeNameByRank.set(query.theme_rank, names);
    }
    const inconsistentRanks = [...themeNameByRank.entries()]
      .filter(([, names]) => names.size > 1)
      .map(([rank]) => rank);
    if (inconsistentRanks.length > 0) {
      errors.push(
        `同一主题序号出现多个 theme_name：${inconsistentRanks.join("、")}。所有查询必须复制报告中的同一主题名。`,
      );
    }

    const rankByThemeName = new Map();
    for (const [rank, names] of themeNameByRank.entries()) {
      for (const name of names) {
        const ranks = rankByThemeName.get(name) ?? new Set();
        ranks.add(rank);
        rankByThemeName.set(name, ranks);
      }
    }
    const duplicatedThemeNames = [...rankByThemeName.entries()]
      .filter(([, ranks]) => ranks.size > 1)
      .map(([name]) => name);
    if (duplicatedThemeNames.length > 0) {
      errors.push(
        `不同主题序号不能复用同一个 theme_name：${duplicatedThemeNames.join("、")}。`,
      );
    }
  }

  const candidateQueryIds = new Set(
    candidates.map((candidate) => candidate?.query_id).filter(nonPlaceholder),
  );
  const queriesWithoutCandidates = successfulQueries.filter(
    (query) => !candidateQueryIds.has(query?.query_id),
  );
  const missingNoCandidateReasons = queriesWithoutCandidates.filter(
    (query) => !nonPlaceholder(query?.no_candidate_reason),
  );
  if (missingNoCandidateReasons.length > 0) {
    errors.push(
      `有 ${missingNoCandidateReasons.length} 个成功查询没有入选候选，也没有 no_candidate_reason。`,
    );
  }

  let status = "partial";
  if (
    errors.length === 0 &&
    browserComplete &&
    successfulQueries.length === queries.length
  ) {
    if (candidates.length > 0) {
      status = "verified";
    } else {
      status = "verified_no_candidate";
    }
  }

  const complete =
    errors.length === 0 &&
    (status === "verified" || status === "verified_no_candidate");

  return {
    ok: complete,
    complete,
    status: complete ? status : "partial",
    errors,
    warnings,
    messages: [
      `GCRM 状态：${complete ? status : "partial"}`,
      `真实查询：${queries.length}；成功：${successfulQueries.length}；候选：${candidates.length}`,
      `浏览器状态：${String(browser.state ?? "missing")}；本地登录态：${browser.local_authenticated_session === true ? "是" : "否"}`,
    ],
    checks: {
      schema_version: evidence.schema_version ?? null,
      browser_state: browser.state ?? null,
      local_authenticated_session: browser.local_authenticated_session === true,
      query_count: queries.length,
      successful_query_count: successfulQueries.length,
      failed_query_count: failedQueries.length,
      candidate_count: candidates.length,
      tr_available_candidate_count: candidates.filter(
        (candidate) => typeof candidate?.tr_estimate === "number",
      ).length,
      tr_unavailable_candidate_count: candidates.filter(
        (candidate) => candidate?.tr_estimate === null,
      ).length,
      expected_theme_count: expectedThemeCount,
      successful_theme_ranks: [
        ...new Set(successfulQueries.map((query) => query?.theme_rank)),
      ]
        .filter(Number.isInteger)
        .sort((left, right) => left - right),
      taxonomy_snapshot: evidence.source?.taxonomy_snapshot ?? null,
    },
  };
}

function printResult(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const message of result.messages ?? []) process.stdout.write(`✓ ${message}\n`);
  for (const warning of result.warnings ?? []) process.stdout.write(`⚠ ${warning}\n`);
  for (const error of result.errors ?? []) process.stderr.write(`✗ ${error}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = parseArguments(process.argv.slice(2));
  if (args.help || args.h) {
    process.stdout.write(
      "用法：node dependencies/gcrm-core/validate-evidence.mjs --evidence <gcrm-evidence.json> --report-window YYYY-MM-DD..YYYY-MM-DD --expected-themes <实际方案数> [--json]\n",
    );
    process.exit(0);
  }
  try {
    if (!args.evidence) throw new Error("缺少 --evidence。");
    const rawWindows = [
      ["--report-window", args["report-window"]],
      ["--merchant-window", args["merchant-window"]],
      ["--gcrm-window", args["gcrm-window"]],
    ].filter(([, value]) => value);
    if (rawWindows.length === 0) throw new Error("缺少 --report-window。");
    if (!args["expected-themes"]) throw new Error("缺少 --expected-themes。");
    const parsedWindows = rawWindows.map(([name, value]) => [
      name,
      value,
      parseWindow(value),
    ]);
    const expectedWindow = parsedWindows[0][2];
    if (
      parsedWindows.some(
        ([, , window]) =>
          window.start !== expectedWindow.start || window.end !== expectedWindow.end,
      )
    ) {
      throw new Error(
        `全文只支持一个报告周期；同时提供的 ${parsedWindows
          .map(([name, value]) => `${name}=${value}`)
          .join("、")} 不一致。`,
      );
    }
    const expectedThemeCount = Number(args["expected-themes"]);
    const evidence = JSON.parse(fs.readFileSync(args.evidence, "utf8"));
    const result = validateGcrmEvidence(evidence, expectedWindow, {
      expectedThemeCount,
    });
    printResult(result, Boolean(args.json));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    printResult(
      {
        ok: false,
        complete: false,
        status: "partial",
        errors: [error.message],
        warnings: [],
      },
      Boolean(args.json),
    );
    process.exit(1);
  }
}
