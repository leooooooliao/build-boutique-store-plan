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
const RECOVERY_REQUIRED_BROWSER_STATES = new Set([
  "capability_blocked",
  "filter_failed",
  "unavailable",
]);
const PLACEHOLDER_PATTERN =
  /^(?:[-—–]|未知|待补|待定位|待查询|空|null|none|n\/?a|unavailable|placeholder)$/i;
const FORBIDDEN_MANUAL_PATH_PATTERN =
  /(?:user[_ -]?manual|manual[_ -]?(?:filter|select|handoff)|handoff|用户.*(?:手选|切换|切好|代选)|人工.*(?:筛选|切换|代选))/i;

function parseArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    if (key === "json") {
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
    throw new Error("--gcrm-window 必须是有效的 YYYY-MM-DD..YYYY-MM-DD。");
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
      `${label}.window 必须与营销参谋周期 ${expectedWindow.start}..${expectedWindow.end} 一致。`,
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
  validateProof(query.proof, label, errors);
}

function categoryMatches(candidate, query) {
  return (
    candidate?.l1 === query?.l1 &&
    candidate?.l2_status === query?.l2_status &&
    String(candidate?.l2 ?? "") === String(query?.l2 ?? "")
  );
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

  if (evidence.schema_version !== "1.0.0") {
    errors.push("schema_version 必须是 1.0.0。");
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
    }
  }
  if (RECOVERY_REQUIRED_BROWSER_STATES.has(browser.state)) {
    if (
      !Array.isArray(browser.attempted_paths) ||
      browser.attempted_paths.filter(nonPlaceholder).length < 2
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
      "用法：node dependencies/gcrm-core/validate-evidence.mjs --evidence <gcrm-evidence.json> --gcrm-window YYYY-MM-DD..YYYY-MM-DD --expected-themes <实际方案数> [--json]\n",
    );
    process.exit(0);
  }
  try {
    if (!args.evidence) throw new Error("缺少 --evidence。");
    if (!args["gcrm-window"]) throw new Error("缺少 --gcrm-window。");
    if (!args["expected-themes"]) throw new Error("缺少 --expected-themes。");
    const expectedWindow = parseWindow(args["gcrm-window"]);
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
