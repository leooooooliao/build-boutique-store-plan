#!/usr/bin/env node

import fs from "node:fs";
import {
  parseArgs,
  parseWindow,
  printResult,
  requireOptions,
} from "./lib.mjs";

const HELP = `
检查精品大店报告是否满足稳定交付底线。

用法：
  node scripts/validate_report.mjs \\
    --report <report.md|html|xml|txt|-> \\
    --merchant-window 2026-07-01..2026-07-26 \\
    --gcrm-window 2026-06-29..2026-07-28 \\
    --generated-date 2026-07-29 \\
    --gcrm-mode <verified|no-candidate|unavailable> \\
    --expected-gcrm-products <数量> \\
    [--expected-top 3] [--json]

检查：
  1. 全文明确展示客户货盘与营销参谋两个完整周期及生成日；
  2. 有 Top 3 精品店方案（数据不足时应在正文解释，校验仍需显式调整 expected-top）；
  3. verified 模式下，每个营销参谋/GCRM 补品都有 Product ID、榜单原店铺名、GMV、来源链接和图片；
     no-candidate / unavailable 模式下有明确降级说明，不强行补品；
  4. 不出现“只保留 1 个主推款”“最多 3 档”“固定 1 个尺寸”等硬性数量指令。

--report - 可从标准输入读取。
`.trim();

function readReport(reportPath) {
  if (reportPath === "-") return fs.readFileSync(0, "utf8");
  if (!fs.existsSync(reportPath)) throw new Error(`报告不存在：${reportPath}`);
  return fs.readFileSync(reportPath, "utf8");
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

function countUniqueMatches(text, pattern) {
  return new Set([...text.matchAll(pattern)].map((match) => match[0])).size;
}

function rankEvidence(text) {
  const patterns = [
    /(?:精品店|店铺方案|方案|优先级|top)\s*[#：:－—-]*\s*(1|2|3|一|二|三)(?=\s|[｜|:：.、）)\-—]|$)/gi,
    /(?:^|\n)\s*(?:#{1,6}\s*)?(1|2|3|一|二|三)[.、）)]\s*[^\n]{0,30}(?:店|方案)/gim,
  ];
  const ranks = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      ranks.add(raw === "一" ? "1" : raw === "二" ? "2" : raw === "三" ? "3" : raw);
    }
  }
  return ranks;
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

function decodeText(value) {
  return String(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function isShopNameMissing(value) {
  const normalized = decodeText(value).toLowerCase();
  return (
    normalized === "" ||
    /^(?:[-—]|未知|待补|待定位|n\/?a|空|null|none)$/.test(normalized) ||
    normalized.includes("{{") ||
    normalized.includes("shop name原文")
  );
}

function extractMarkdownEvidenceRows(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let index = 0; index < lines.length - 2; index += 1) {
    const headerLine = lines[index];
    if (
      !headerLine.includes("|") ||
      !/(?:Product\s*ID|商品\s*ID)/i.test(headerLine) ||
      !/(?:榜单原店铺名|原店铺名|榜单店铺名|shop[_\s-]*name)/i.test(headerLine) ||
      !/\bGMV\b/i.test(headerLine)
    ) {
      continue;
    }
    const separator = lines[index + 1];
    if (!/^\s*\|?\s*:?-{3,}/.test(separator)) continue;
    const headers = headerLine
      .replace(/^\s*\||\|\s*$/g, "")
      .split("|")
      .map(decodeText);
    const productIndex = headers.findIndex((value) => /(?:Product\s*ID|商品\s*ID)/i.test(value));
    const shopIndex = headers.findIndex((value) =>
      /(?:榜单原店铺名|原店铺名|榜单店铺名|shop[_\s-]*name)/i.test(value),
    );
    const gmvIndex = headers.findIndex((value) => /\bGMV\b/i.test(value));
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex];
      if (!line.includes("|") || /^\s*$/.test(line)) break;
      const cells = line
        .replace(/^\s*\||\|\s*$/g, "")
        .split("|")
        .map(decodeText);
      const productId = cells[productIndex]?.match(/\b1\d{18}\b/)?.[0];
      if (!productId) continue;
      rows.push({
        productId,
        shopName: cells[shopIndex] ?? "",
        gmv: cells[gmvIndex] ?? "",
        source: "markdown-table",
      });
    }
  }
  return rows;
}

function extractHtmlEvidenceRows(text) {
  const evidence = [];
  for (const tableMatch of text.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const table = tableMatch[0];
    if (
      !/(?:Product\s*ID|商品\s*ID)/i.test(table) ||
      !/(?:榜单原店铺名|原店铺名|榜单店铺名|shop[_\s-]*name)/i.test(table) ||
      !/\bGMV\b/i.test(table)
    ) {
      continue;
    }
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
      [...match[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) =>
        decodeText(cell[1]),
      ),
    );
    const headerIndex = rows.findIndex(
      (row) =>
        row.some((value) => /(?:Product\s*ID|商品\s*ID)/i.test(value)) &&
        row.some((value) =>
          /(?:榜单原店铺名|原店铺名|榜单店铺名|shop[_\s-]*name)/i.test(value),
        ),
    );
    if (headerIndex === -1) continue;
    const headers = rows[headerIndex];
    const productIndex = headers.findIndex((value) => /(?:Product\s*ID|商品\s*ID)/i.test(value));
    const shopIndex = headers.findIndex((value) =>
      /(?:榜单原店铺名|原店铺名|榜单店铺名|shop[_\s-]*name)/i.test(value),
    );
    const gmvIndex = headers.findIndex((value) => /\bGMV\b/i.test(value));
    for (const row of rows.slice(headerIndex + 1)) {
      const productId = row[productIndex]?.match(/\b1\d{18}\b/)?.[0];
      if (!productId) continue;
      evidence.push({
        productId,
        shopName: row[shopIndex] ?? "",
        gmv: row[gmvIndex] ?? "",
        source: "html-table",
      });
    }
  }
  return evidence;
}

function extractLabeledEvidenceRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (
      !/(?:营销参谋|GCRM|补品)/i.test(line) ||
      !/(?:榜单原店铺名|原店铺名|榜单店铺名|shop[_\s-]*name)/i.test(line)
    ) {
      continue;
    }
    const productId = line.match(/\b1\d{18}\b/)?.[0];
    if (!productId) continue;
    const shopName =
      line.match(
        /(?:榜单原店铺名|原店铺名|榜单店铺名|shop[_\s-]*name)\s*[:：]\s*([^，,。；;|<\n]+)/i,
      )?.[1] ?? "";
    const gmv = line.match(/\bGMV\b\s*[:：]?\s*([^，,。；;|<\n]+)/i)?.[1] ?? "";
    rows.push({ productId, shopName, gmv, source: "labeled-line" });
  }
  return rows;
}

function extractGcrmEvidenceRows(text) {
  const combined = [
    ...extractMarkdownEvidenceRows(text),
    ...extractHtmlEvidenceRows(text),
    ...extractLabeledEvidenceRows(text),
  ];
  const seen = new Set();
  return combined.filter((row) => {
    const key = row.productId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateReport(
  text,
  merchantWindow,
  gcrmWindow,
  generatedDate,
  expectedTop,
  gcrmMode,
  expectedGcrmProducts,
) {
  const errors = [];
  const warnings = [];
  const normalized = canonicalizeDates(text);

  const periodChecks = [
    ["客户货盘周期", merchantWindow],
    ["营销参谋周期", gcrmWindow],
  ];
  for (const [label, window] of periodChecks) {
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
  const enoughRanks = Array.from({ length: expectedTop }, (_, index) => String(index + 1)).every(
    (rank) => ranks.has(rank),
  );
  if (!enoughRanks && !topPhrase) {
    errors.push(
      `未识别到完整 Top ${expectedTop} 精品店结构；需明确标出 1–${expectedTop}。`,
    );
  }
  if (shopIds < expectedTop) {
    errors.push(
      `承接店 Shop ID 不足：期望至少 ${expectedTop} 个唯一 19 位 Shop ID，实际 ${shopIds} 个。`,
    );
  }

  if (!/(营销参谋|GCRM)/i.test(text)) {
    errors.push("未识别到营销参谋/GCRM 证据区。");
  }
  const evidenceRows = extractGcrmEvidenceRows(text);
  const invalidShopRows = evidenceRows.filter((row) => isShopNameMissing(row.shopName));
  const invalidGmvRows = evidenceRows.filter(
    (row) => decodeText(row.gmv) === "" || /\{\{|待补|未知|n\/?a/i.test(row.gmv),
  );

  if (gcrmMode === "verified") {
    if (expectedGcrmProducts < 1) {
      errors.push("verified 模式的 --expected-gcrm-products 必须至少为 1。");
    }
    if (evidenceRows.length !== expectedGcrmProducts) {
      errors.push(
        `营销参谋补品证据行数不一致：期望 ${expectedGcrmProducts}，实际识别 ${evidenceRows.length}。每个补品都必须在含 Product ID、原店铺名和 GMV 的结构化行中出现。`,
      );
    }
    if (invalidShopRows.length > 0) {
      errors.push(`发现 ${invalidShopRows.length} 个缺失的榜单原店铺名，请回到榜单补全。`);
    }
    if (invalidGmvRows.length > 0) {
      errors.push(`发现 ${invalidGmvRows.length} 个缺失的营销参谋 GMV 证据，请回到榜单补全。`);
    }
  } else if (gcrmMode === "no-candidate") {
    if (expectedGcrmProducts !== 0) {
      errors.push("no-candidate 模式的 --expected-gcrm-products 必须为 0。");
    }
    if (!/(?:无|没有|暂无|未找到)[^。\n]{0,20}(?:合格|有效|适配)[^。\n]{0,12}(?:补品|候选)|本主题暂不补品/i.test(text)) {
      errors.push("no-candidate 模式必须明确写明没有合格补品候选及原因。");
    }
  } else if (gcrmMode === "unavailable") {
    if (expectedGcrmProducts !== 0) {
      errors.push("unavailable 模式的 --expected-gcrm-products 必须为 0。");
    }
    if (!/(?:未登录|无权限|无法访问|访问受限|待登录营销参谋后补充|营销参谋[^。\n]{0,20}未验证)/i.test(text)) {
      errors.push("unavailable 模式必须明确披露营销参谋未访问/未验证，不能伪装已查询。");
    }
  }

  if (gcrmMode === "verified" && !/(涨幅|增长|growth|环比|同比|暂无可靠涨幅)/i.test(text)) {
    warnings.push("未识别到涨幅/增长信息；若榜单未提供，应在报告中明确写“暂无可靠涨幅”。");
  }

  const urls = [
    ...text.matchAll(/https?:\/\/[^\s"'<>）)\]}]+/gi),
  ].map((match) => match[0].replace(/&amp;/g, "&"));
  const sourceUrls = urls.filter((url) =>
    /(tiktok-row\.net|tiktokshop|tiktok\.com|analytics|gcrm)/i.test(url),
  );
  if (gcrmMode === "verified" && sourceUrls.length < expectedGcrmProducts) {
    errors.push(
      `营销参谋来源链接不足：期望每个补品 1 个，实际识别 ${sourceUrls.length}/${expectedGcrmProducts}。`,
    );
  }

  const markdownImages = [...text.matchAll(/!\[[^\]]*]\(([^)]*)\)/g)].filter(
    (match) => {
      const target = decodeText(match[1]);
      return target !== "" && !/\{\{|待补|占位|placeholder/i.test(target);
    },
  );
  const htmlImages = [...text.matchAll(/<(?:img|image)\b[^>]*>/gi)].filter((match) => {
    const tag = match[0];
    const target =
      tag.match(/\b(?:src|href|token)\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    return target !== "" && !/\{\{|待补|占位|placeholder/i.test(target);
  });
  const imageCount = markdownImages.length + htmlImages.length;
  if (gcrmMode === "verified" && imageCount < expectedGcrmProducts) {
    errors.push(
      `营销参谋图片不足：期望每个补品 1 张，实际识别 ${imageCount}/${expectedGcrmProducts}。`,
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
    errors,
    warnings,
    messages: [
      `周期：客户货盘 ${merchantWindow.display}；营销参谋 ${gcrmWindow.display}；生成日 ${generatedDate}`,
      `Top ${expectedTop} 结构：${enoughRanks || (topPhrase && shopIds >= expectedTop) ? "已识别" : "未识别"}`,
      `营销参谋模式：${gcrmMode}；结构化补品 ${evidenceRows.length}/${expectedGcrmProducts}；来源链接 ${sourceUrls.length}；图片 ${imageCount}。`,
    ],
    checks: {
      expected_top: expectedTop,
      explicit_ranks: [...ranks].sort(),
      unique_19_digit_ids: shopIds,
      gcrm_mode: gcrmMode,
      expected_gcrm_products: expectedGcrmProducts,
      gcrm_evidence_rows: evidenceRows.length,
      invalid_gcrm_shop_names: invalidShopRows.length,
      invalid_gcrm_gmv_rows: invalidGmvRows.length,
      generated_date: generatedDate,
      source_link_count: sourceUrls.length,
      image_count: imageCount,
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
    "gcrm-mode",
    "expected-gcrm-products",
  ]);
  const expectedTop = Number(args["expected-top"] ?? 3);
  if (!Number.isInteger(expectedTop) || expectedTop < 1 || expectedTop > 10) {
    throw new Error("--expected-top 必须是 1–10 的整数。");
  }
  const gcrmMode = String(args["gcrm-mode"]);
  if (!["verified", "no-candidate", "unavailable"].includes(gcrmMode)) {
    throw new Error("--gcrm-mode 必须是 verified、no-candidate 或 unavailable。");
  }
  const expectedGcrmProducts = Number(args["expected-gcrm-products"]);
  if (
    !Number.isInteger(expectedGcrmProducts) ||
    expectedGcrmProducts < 0 ||
    expectedGcrmProducts > 100
  ) {
    throw new Error("--expected-gcrm-products 必须是 0–100 的整数。");
  }
  const merchantWindow = parseWindow(args["merchant-window"], "客户货盘周期");
  const gcrmWindow = parseWindow(args["gcrm-window"], "营销参谋周期");
  const generatedDate = parseWindow(
    `${args["generated-date"]}..${args["generated-date"]}`,
    "生成日",
  ).start;
  const text = readReport(args.report);
  const result = validateReport(
    text,
    merchantWindow,
    gcrmWindow,
    generatedDate,
    expectedTop,
    gcrmMode,
    expectedGcrmProducts,
  );
  printResult(result, Boolean(args.json));
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  printResult({ ok: false, errors: [error.message], warnings: [] }, Boolean(args.json));
  process.exit(1);
}
