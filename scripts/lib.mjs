import fs from "node:fs";
import path from "node:path";

const ID_PATTERN = /^\d{19}$/;

export const FIELD_ALIASES = {
  product_id: ["product_id", "product id", "商品id", "商品 id"],
  product_name: ["product_name", "product name", "商品名", "商品名称"],
  shop_operation_country: [
    "shop_operation_country",
    "shop operation country",
    "国家",
    "运营国家",
  ],
  shop_name: ["shop_name", "shop name", "店铺名", "店铺名称"],
  shop_id: ["shop_id", "shop id", "店铺id", "店铺 id"],
  product_new_cbec_industry_l3: [
    "product_new_cbec_industry_l3",
    "industry_l3",
    "l3",
    "三级类目",
  ],
  payment_1d: ["payment_1d", "payment", "gmv", "支付gmv", "支付金额"],
  dollar_cost: ["dollar_cost", "cost", "ad_cost", "广告消耗", "消耗"],
  ads_ctr: ["ads_ctr", "ctr"],
  ads_cvr: ["ads_cvr", "cvr"],
  ads_cpm: ["ads_cpm", "cpm"],
  roas: ["roas"],
  ads_show_count: ["ads_show_count", "impressions", "show_count", "广告曝光"],
};

export const ID_DATA_REQUIRED = [
  "product_id",
  "shop_operation_country",
  "shop_id",
  "product_new_cbec_industry_l3",
  "payment_1d",
  "dollar_cost",
];

export const NAME_DATA_REQUIRED = [
  "product_id",
  "product_name",
  "shop_operation_country",
  "shop_name",
  "shop_id",
];

export function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const equalAt = token.indexOf("=");
    if (equalAt !== -1) {
      parsed[token.slice(2, equalAt)] = token.slice(equalAt + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

export function requireOptions(args, names) {
  const missing = names.filter((name) => !args[name] || args[name] === true);
  if (missing.length > 0) {
    throw new Error(`缺少参数：${missing.map((name) => `--${name}`).join("、")}`);
  }
}

function countDelimiter(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === delimiter) {
      count += 1;
    }
  }
  return count;
}

function detectDelimiter(text) {
  const firstRecord = text.split(/\r?\n/, 1)[0] ?? "";
  const tabs = countDelimiter(firstRecord, "\t");
  const commas = countDelimiter(firstRecord, ",");
  if (tabs === 0 && commas === 0) {
    throw new Error("无法识别分隔符：请从 Excel 复制完整表格，或另存为 UTF-8 CSV/TSV。");
  }
  return tabs >= commas ? "\t" : ",";
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === '"') {
      // Excel 复制的 TSV 中，商品名可能直接包含英寸符号双引号；
      // 只有字段开头的双引号才表示 RFC 4180 引用字段。
      field += character;
    } else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new Error("表格包含未闭合的双引号。请重新导出 CSV/TSV。");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim() !== ""));
}

function normalizeHeader(value) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function canonicalField(header) {
  const normalized = normalizeHeader(header);
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
      return canonical;
    }
  }
  return header.trim();
}

export function loadTable(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在：${filePath}`);
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".xlsx" || extension === ".xls") {
    throw new Error(
      `不直接读取 ${extension}：请在 Excel 中“另存为 UTF-8 CSV”，或全选复制为 TSV，以避免 19 位 ID 被科学计数法破坏。`,
    );
  }
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  if (text.trim() === "") {
    throw new Error(`文件为空：${filePath}`);
  }
  const delimiter = detectDelimiter(text);
  const matrix = parseDelimited(text, delimiter);
  if (matrix.length < 2) {
    throw new Error(`文件没有数据行：${filePath}`);
  }
  const rawHeaders = matrix[0].map((value) => value.trim());
  const headers = rawHeaders.map(canonicalField);
  const duplicateHeaders = headers.filter(
    (value, index) => headers.indexOf(value) !== index,
  );
  if (duplicateHeaders.length > 0) {
    throw new Error(`字段名重复：${[...new Set(duplicateHeaders)].join("、")}`);
  }
  const rows = matrix.slice(1).map((values, rowIndex) => {
    const record = { __row: rowIndex + 2 };
    headers.forEach((header, columnIndex) => {
      record[header] = (values[columnIndex] ?? "").trim();
    });
    return record;
  });
  return {
    filePath,
    delimiter: delimiter === "\t" ? "TSV" : "CSV",
    rawHeaders,
    headers,
    rows,
  };
}

export function parseNumber(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (raw === "" || raw === "-" || raw.toLowerCase() === "null") return null;
  const negative = raw.startsWith("(") && raw.endsWith(")");
  const percent = /%\s*$/.test(raw);
  const normalized = raw
    .replace(/[,$￥¥€£\s]/g, "")
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .replace(/%$/, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return Number.NaN;
  const number = Number(normalized) / (percent ? 100 : 1);
  return negative ? -number : number;
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return date;
}

export function parseWindow(raw, label) {
  if (!raw || raw === true) {
    throw new Error(`${label}不能为空，必须明确填写开始日和结束日。`);
  }
  const normalized = String(raw)
    .trim()
    .replace(/[年月]/g, "-")
    .replace(/日/g, "")
    .replace(/\//g, "-")
    .replace(/\s+/g, "");
  const match = /^(\d{4}-\d{2}-\d{2})(?:\.\.|~|至|—|–|:|,)(\d{4}-\d{2}-\d{2})$/.exec(
    normalized,
  );
  if (!match) {
    throw new Error(
      `${label}格式错误：请使用 YYYY-MM-DD..YYYY-MM-DD，例如 2026-07-01..2026-07-26。`,
    );
  }
  const startDate = parseIsoDate(match[1]);
  const endDate = parseIsoDate(match[2]);
  if (!startDate || !endDate) {
    throw new Error(`${label}包含无效日期：${raw}`);
  }
  if (startDate > endDate) {
    throw new Error(`${label}开始日不能晚于结束日：${raw}`);
  }
  return {
    start: match[1],
    end: match[2],
    display: `${match[1]} 至 ${match[2]}`,
  };
}

function checkRequiredHeaders(table, required, label, errors) {
  const missing = required.filter((field) => !table.headers.includes(field));
  if (missing.length > 0) {
    errors.push(`${label}缺少必填字段：${missing.join("、")}`);
  }
}

function checkIds(table, label, errors) {
  for (const field of ["product_id", "shop_id"]) {
    if (!table.headers.includes(field)) continue;
    const invalid = table.rows.filter((row) => !ID_PATTERN.test(row[field] ?? ""));
    if (invalid.length > 0) {
      const samples = invalid
        .slice(0, 3)
        .map((row) => `第${row.__row}行=${row[field] || "空"}`)
        .join("；");
      errors.push(
        `${label}.${field} 必须是原样文本形式的 19 位数字，发现 ${invalid.length} 行异常（${samples}）。请检查 Excel 是否转成科学计数法或截断末位。`,
      );
    }
  }
}

function checkTextFields(table, fields, label, errors) {
  for (const field of fields) {
    if (!table.headers.includes(field)) continue;
    const missing = table.rows.filter((row) => !row[field]?.trim());
    if (missing.length > 0) {
      errors.push(`${label}.${field} 有 ${missing.length} 行为空。`);
    }
  }
}

function checkNumericFields(table, fields, label, errors) {
  for (const field of fields) {
    if (!table.headers.includes(field)) continue;
    const invalid = table.rows.filter((row) => {
      const value = parseNumber(row[field]);
      return value === null || Number.isNaN(value);
    });
    if (invalid.length > 0) {
      errors.push(`${label}.${field} 有 ${invalid.length} 行不是有效数字或为空。`);
    }
  }
}

function pairKey(row) {
  return `${row.shop_operation_country}\u001f${row.shop_id}\u001f${row.product_id}`;
}

export function validateInputs({
  idDataPath,
  nameDataPath,
  merchantWindowRaw,
  gcrmWindowRaw,
}) {
  const errors = [];
  const warnings = [];
  let idTable;
  let nameTable;
  let merchantWindow;
  let gcrmWindow;

  try {
    merchantWindow = parseWindow(merchantWindowRaw, "客户货盘周期");
  } catch (error) {
    errors.push(error.message);
  }
  try {
    gcrmWindow = parseWindow(gcrmWindowRaw, "营销参谋周期");
  } catch (error) {
    errors.push(error.message);
  }
  try {
    idTable = loadTable(idDataPath);
  } catch (error) {
    errors.push(`ID 数据读取失败：${error.message}`);
  }
  try {
    nameTable = loadTable(nameDataPath);
  } catch (error) {
    errors.push(`名字对照数据读取失败：${error.message}`);
  }

  if (idTable) {
    checkRequiredHeaders(idTable, ID_DATA_REQUIRED, "ID 数据", errors);
    checkIds(idTable, "ID 数据", errors);
    checkTextFields(
      idTable,
      ["shop_operation_country", "product_new_cbec_industry_l3"],
      "ID 数据",
      errors,
    );
    checkNumericFields(idTable, ["payment_1d", "dollar_cost"], "ID 数据", errors);
  }
  if (nameTable) {
    checkRequiredHeaders(nameTable, NAME_DATA_REQUIRED, "名字对照数据", errors);
    checkIds(nameTable, "名字对照数据", errors);
    checkTextFields(
      nameTable,
      ["product_name", "shop_operation_country", "shop_name"],
      "名字对照数据",
      errors,
    );
  }

  let coverage = null;
  if (
    idTable &&
    nameTable &&
    ID_DATA_REQUIRED.every((field) => idTable.headers.includes(field)) &&
    NAME_DATA_REQUIRED.every((field) => nameTable.headers.includes(field))
  ) {
    const idPairs = new Set(idTable.rows.map(pairKey));
    const namePairs = new Set(nameTable.rows.map(pairKey));
    const missingNamePairs = [...idPairs].filter((key) => !namePairs.has(key));
    const extraNamePairs = [...namePairs].filter((key) => !idPairs.has(key));
    coverage = {
      id_pair_count: idPairs.size,
      name_pair_count: namePairs.size,
      matched_pair_count: idPairs.size - missingNamePairs.length,
      missing_name_pair_count: missingNamePairs.length,
      extra_name_pair_count: extraNamePairs.length,
    };
    coverage.matched_pair_rate =
      coverage.id_pair_count === 0
        ? null
        : round(coverage.matched_pair_count / coverage.id_pair_count, 6);
    const gmvCoverageByCountry = new Map();
    for (const row of idTable.rows) {
      const country = row.shop_operation_country;
      const bucket = gmvCoverageByCountry.get(country) ?? {
        shop_operation_country: country,
        total_gmv: 0,
        matched_name_gmv: 0,
      };
      const value = parseNumber(row.payment_1d);
      if (Number.isFinite(value)) {
        bucket.total_gmv += value;
        if (namePairs.has(pairKey(row))) bucket.matched_name_gmv += value;
      }
      gmvCoverageByCountry.set(country, bucket);
    }
    coverage.matched_name_gmv_by_country = [...gmvCoverageByCountry.values()]
      .map((bucket) => ({
        shop_operation_country: bucket.shop_operation_country,
        total_gmv: round(bucket.total_gmv, 6),
        matched_name_gmv: round(bucket.matched_name_gmv, 6),
        matched_name_gmv_rate:
          bucket.total_gmv === 0
            ? null
            : round(bucket.matched_name_gmv / bucket.total_gmv, 6),
      }))
      .sort((left, right) =>
        left.shop_operation_country.localeCompare(right.shop_operation_country),
      );
    if (coverage.matched_pair_count === 0) {
      errors.push(
        "两份数据没有任何相同的 country × shop_id × product_id 组合；请确认两个网址选择了同一商家，并重新复制。",
      );
    } else if (missingNamePairs.length > 0) {
      warnings.push(
        `名字对照数据未覆盖 ID 数据中的 ${missingNamePairs.length} 个组合；未命中的商品仍按 ID 指标进入底表，但名称为空。名字表可少于指标表，不得用名字表行数或指标替代 ID 数据。`,
      );
    }
    if (extraNamePairs.length > 0) {
      warnings.push(
        `名字对照数据比 ID 数据多 ${extraNamePairs.length} 个组合；这些行只作别名参考，不进入指标汇总。`,
      );
    }
  }

  if (idTable) {
    const duplicateRows = idTable.rows.length - new Set(idTable.rows.map(pairKey)).size;
    if (duplicateRows > 0) {
      warnings.push(
        `ID 数据同一聚合键有 ${duplicateRows} 条重复/拆分行；prepare_portfolio 会按 country × shop_id × product_id 加总并重算比率。`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    merchantWindow,
    gcrmWindow,
    idTable,
    nameTable,
    coverage,
    countries: idTable
      ? [...new Set(idTable.rows.map((row) => row.shop_operation_country))].sort((a, b) =>
          a.localeCompare(b),
        )
      : [],
  };
}

export function printResult(result, jsonMode = false) {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const status = result.ok ? "PASS" : "FAIL";
  process.stdout.write(`${status}\n`);
  for (const message of result.errors ?? []) {
    process.stdout.write(`ERROR: ${message}\n`);
  }
  for (const message of result.warnings ?? []) {
    process.stdout.write(`WARN: ${message}\n`);
  }
  for (const message of result.messages ?? []) {
    process.stdout.write(`${message}\n`);
  }
}

export function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function safeRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}
