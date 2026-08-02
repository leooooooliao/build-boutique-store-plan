import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;

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

// Keep this export for older callers. Only the ID keys and GMV column are
// structurally required; category, cost, country values, and optional ad
// metrics are recoverable or isolatable.
export const ID_DATA_REQUIRED = ["product_id", "shop_id", "payment_1d"];

// A name sheet is semantic enrichment, never a metric source. shop_id,
// product_name, and shop_name improve matching but are not row-level blockers.
export const NAME_DATA_REQUIRED = ["product_id"];

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

export function resolveReportWindowArgs(args) {
  const provided = [
    ["--report-window", args["report-window"]],
    ["--merchant-window", args["merchant-window"]],
    ["--gcrm-window", args["gcrm-window"]],
  ].filter(([, value]) => value && value !== true);
  if (provided.length === 0) {
    throw new Error(
      "缺少参数：--report-window（旧版 --merchant-window / --gcrm-window 仍可作兼容别名）",
    );
  }

  const parsed = provided.map(([name, value]) => ({
    name,
    value,
    window: parseWindow(value, `${name} 报告周期`),
  }));
  const selected = parsed[0].window;
  const conflicts = parsed.filter(
    (candidate) =>
      candidate.window.start !== selected.start ||
      candidate.window.end !== selected.end,
  );
  if (conflicts.length > 0) {
    throw new Error(
      `全文只支持一个报告周期；同时提供的 ${parsed
        .map(({ name, value }) => `${name}=${value}`)
        .join("、")} 不一致。`,
    );
  }
  return `${selected.start}..${selected.end}`;
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

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(/&#(\d+);/g, (_match, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlAttribute(attributes, name) {
  const expression = new RegExp(
    `(?:^|\\s)${name.replace(":", "\\:")}=(?:"([^"]*)"|'([^']*)')`,
  );
  const match = expression.exec(attributes);
  return match ? decodeXml(match[1] ?? match[2] ?? "") : null;
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error("不是有效的 XLSX/ZIP 文件：找不到中央目录。");
}

function readZipEntries(buffer) {
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER
    ) {
      throw new Error("XLSX 中央目录损坏。");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString(flags & 0x800 ? "utf8" : "utf8")
      .replace(/\\/g, "/");

    if (
      localOffset + 30 > buffer.length ||
      buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE_HEADER
    ) {
      throw new Error(`XLSX 条目损坏：${fileName}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let content;
    if (compression === 0) {
      content = Buffer.from(compressed);
    } else if (compression === 8) {
      content = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`XLSX 使用了不支持的压缩方式 ${compression}：${fileName}`);
    }
    entries.set(fileName.replace(/^\/+/, ""), content);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    const fragments = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)];
    strings.push(fragments.map((fragment) => decodeXml(fragment[1])).join(""));
  }
  return strings;
}

function columnIndex(reference) {
  const match = /^([A-Z]+)\d+$/i.exec(reference);
  if (!match) return null;
  let result = 0;
  for (const character of match[1].toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
}

function cellText(body, type, sharedStrings) {
  if (type === "inlineStr") {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
      .map((match) => decodeXml(match[1]))
      .join("");
  }
  const valueMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body);
  if (!valueMatch) return "";
  const raw = decodeXml(valueMatch[1]);
  if (type === "s") {
    const index = Number.parseInt(raw, 10);
    return Number.isInteger(index) ? String(sharedStrings[index] ?? "") : "";
  }
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return raw;
}

function parseWorksheet(xml, sharedStrings) {
  const rows = new Map();
  const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi;
  for (const match of xml.matchAll(cellPattern)) {
    const attributes = match[1] ?? match[3] ?? "";
    const body = match[2] ?? "";
    const reference = xmlAttribute(attributes, "r");
    if (!reference) continue;
    const rowMatch = /(\d+)$/.exec(reference);
    const column = columnIndex(reference);
    if (!rowMatch || column === null) continue;
    const rowNumber = Number.parseInt(rowMatch[1], 10);
    const type = xmlAttribute(attributes, "t") ?? "n";
    const style = xmlAttribute(attributes, "s");
    const formula = /<f\b/i.test(body);
    const value = cellText(body, type, sharedStrings);
    const row = rows.get(rowNumber) ?? new Map();
    row.set(column, {
      value,
      type,
      style: style === null ? null : Number.parseInt(style, 10),
      formula,
      numeric: type === "n",
    });
    rows.set(rowNumber, row);
  }
  return rows;
}

function headerRecognitionScore(cells) {
  let score = 0;
  const seen = new Set();
  for (const cell of cells.values()) {
    const canonical = canonicalField(String(cell.value ?? ""));
    if (Object.hasOwn(FIELD_ALIASES, canonical) && !seen.has(canonical)) {
      score += 1;
      seen.add(canonical);
    }
  }
  return score;
}

function tableFromWorksheet(filePath, sheetName, rows) {
  const candidateRows = [...rows.entries()]
    .filter(([, cells]) =>
      [...cells.values()].some((cell) => String(cell.value ?? "").trim() !== ""),
    )
    .slice(0, 30);
  if (candidateRows.length === 0) {
    return {
      filePath,
      sheetName,
      delimiter: "XLSX",
      rawHeaders: [],
      headers: [],
      rows: [],
    };
  }
  const [headerRowNumber, headerCells] = candidateRows.reduce((best, candidate) => {
    const score = headerRecognitionScore(candidate[1]);
    return score > best.score
      ? { score, value: candidate }
      : best;
  }, { score: -1, value: candidateRows[0] }).value;
  const maximumColumn = Math.max(...headerCells.keys());
  const rawHeaders = [];
  const headers = [];
  const headerColumns = [];
  for (let column = 0; column <= maximumColumn; column += 1) {
    const rawHeader = String(headerCells.get(column)?.value ?? "").trim();
    if (!rawHeader) continue;
    rawHeaders.push(rawHeader);
    headers.push(canonicalField(rawHeader));
    headerColumns.push(column);
  }
  const duplicateHeaders = headers.filter(
    (value, index) => headers.indexOf(value) !== index,
  );
  if (duplicateHeaders.length > 0) {
    throw new Error(
      `工作表“${sheetName}”字段名重复：${[...new Set(duplicateHeaders)].join("、")}`,
    );
  }
  const records = [];
  for (const [rowNumber, cells] of [...rows.entries()].sort(
    (left, right) => left[0] - right[0],
  )) {
    if (rowNumber <= headerRowNumber) continue;
    const record = { __row: rowNumber, __cell_types: {} };
    let hasValue = false;
    headers.forEach((header, headerIndex) => {
      const cell = cells.get(headerColumns[headerIndex]);
      const value = String(cell?.value ?? "").trim();
      record[header] = value;
      record.__cell_types[header] = cell
        ? {
            type: cell.type,
            numeric: cell.numeric,
            formula: cell.formula,
            style: cell.style,
          }
        : null;
      if (value) hasValue = true;
    });
    if (hasValue) records.push(record);
  }
  return {
    filePath,
    sheetName,
    delimiter: "XLSX",
    rawHeaders,
    headers,
    rows: records,
  };
}

function normalizeRelationshipTarget(target) {
  const clean = String(target ?? "").replace(/\\/g, "/");
  if (clean.startsWith("/")) return path.posix.normalize(clean.slice(1));
  return path.posix.normalize(path.posix.join("xl", clean));
}

function loadWorkbookTables(filePath) {
  const entries = readZipEntries(fs.readFileSync(filePath));
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8");
  const relationships = entries
    .get("xl/_rels/workbook.xml.rels")
    ?.toString("utf8");
  if (!workbook || !relationships) {
    throw new Error("XLSX 缺少 workbook.xml 或工作表关系文件。");
  }
  const relationshipTargets = new Map();
  for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?>/gi)) {
    const id = xmlAttribute(match[1], "Id");
    const target = xmlAttribute(match[1], "Target");
    if (id && target) relationshipTargets.set(id, normalizeRelationshipTarget(target));
  }
  const sharedStrings = parseSharedStrings(
    entries.get("xl/sharedStrings.xml")?.toString("utf8"),
  );
  const tables = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/gi)) {
    const sheetName = xmlAttribute(match[1], "name") ?? "未命名工作表";
    const relationshipId =
      xmlAttribute(match[1], "r:id") ?? xmlAttribute(match[1], "id");
    const target = relationshipTargets.get(relationshipId);
    const sheetXml = target ? entries.get(target)?.toString("utf8") : null;
    if (!sheetXml) continue;
    tables.push(
      tableFromWorksheet(
        filePath,
        sheetName,
        parseWorksheet(sheetXml, sharedStrings),
      ),
    );
  }
  if (tables.length === 0) {
    throw new Error("XLSX 中没有可读取的工作表。");
  }
  return tables;
}

function roleScore(table, role) {
  const fields = new Set(table.headers);
  if (role === "id") {
    const qualified =
      fields.has("product_id") &&
      fields.has("shop_id") &&
      fields.has("payment_1d");
    if (!qualified) return -1;
    return (
      100 +
      (fields.has("shop_operation_country") ? 8 : 0) +
      (fields.has("product_new_cbec_industry_l3") ? 5 : 0) +
      (fields.has("dollar_cost") ? 4 : 0) +
      (fields.has("ads_show_count") ? 1 : 0)
    );
  }
  const qualified =
    fields.has("product_id") &&
    (fields.has("product_name") || fields.has("shop_name"));
  if (!qualified) return -1;
  return (
    100 +
    (fields.has("shop_id") ? 10 : 0) +
    (fields.has("product_name") ? 6 : 0) +
    (fields.has("shop_name") ? 5 : 0) -
    (fields.has("payment_1d") ? 2 : 0)
  );
}

function selectWorkbookTable(tables, role, excludedSheetName = null) {
  const candidates = tables
    .filter((table) => table.sheetName !== excludedSheetName)
    .map((table) => ({ table, score: roleScore(table, role) }))
    .filter((candidate) => candidate.score >= 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.table.sheetName.localeCompare(right.table.sheetName),
    );
  if (candidates.length === 0) {
    const available = tables
      .map((table) => `“${table.sheetName}”[${table.headers.join(", ")}]`)
      .join("；");
    const expectation =
      role === "id"
        ? "product_id、shop_id、payment_1d"
        : "product_id 且至少包含 product_name/shop_name";
    throw new Error(
      `无法自动识别${role === "id" ? "ID 层级" : "名称对照"}工作表；需要 ${expectation}。现有工作表：${available || "无"}。`,
    );
  }
  return candidates[0].table;
}

export function loadTable(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在：${filePath}`);
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".xlsx") {
    const tables = loadWorkbookTables(filePath);
    if (!options.role) {
      if (tables.length !== 1) {
        throw new Error(
          `XLSX 有 ${tables.length} 个工作表；请指定 role=id 或 role=name 自动识别。`,
        );
      }
      return tables[0];
    }
    return selectWorkbookTable(tables, options.role, options.excludeSheetName);
  }
  if (extension === ".xls") {
    throw new Error(
      "暂不支持旧版 .xls 二进制格式；请另存为 .xlsx。不要改写报表数值。",
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
    sheetName: null,
    delimiter: delimiter === "\t" ? "TSV" : "CSV",
    rawHeaders,
    headers,
    rows,
  };
}

export function loadInputTables(idDataPath, nameDataPath) {
  const idResolved = path.resolve(idDataPath);
  const nameResolved = path.resolve(nameDataPath);
  const sameXlsx =
    idResolved === nameResolved && path.extname(idResolved).toLowerCase() === ".xlsx";
  if (sameXlsx) {
    const tables = loadWorkbookTables(idResolved);
    const idTable = selectWorkbookTable(tables, "id");
    const nameTable = selectWorkbookTable(tables, "name", idTable.sheetName);
    return { idTable, nameTable };
  }
  return {
    idTable: loadTable(idDataPath, { role: "id" }),
    nameTable: loadTable(nameDataPath, { role: "name" }),
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

function missingHeaders(table, required) {
  return required.filter((field) => !table.headers.includes(field));
}

function obviousIdTransportDamage(row, field) {
  const raw = String(row[field] ?? "").trim();
  if (!raw) return null;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(raw)) {
    return "scientific_notation";
  }
  if (/^[+-]?\d+\.\d+$/.test(raw)) {
    return "floating_point";
  }
  const metadata = row.__cell_types?.[field];
  if (metadata?.numeric && /^[+-]?\d{16,}$/.test(raw)) {
    return "xlsx_unsafe_numeric_precision";
  }
  return null;
}

function normalizeCountry(value) {
  return String(value ?? "").trim().toUpperCase();
}

function idKey(row) {
  return `${row.shop_operation_country}\u001f${row.shop_id}\u001f${row.product_id}`;
}

function namePairKey(row) {
  return `${String(row.shop_id ?? "").trim()}\u001f${String(
    row.product_id ?? "",
  ).trim()}`;
}

function prepareAnalysisIdRows(table, autoHandled, notices) {
  const isolatedRows = [];
  const countriesByShopId = new Map();
  let damagedIdRows = 0;

  for (const row of table.rows) {
    const shopId = String(row.shop_id ?? "").trim();
    const country = normalizeCountry(row.shop_operation_country);
    if (!shopId || !country || obviousIdTransportDamage(row, "shop_id")) continue;
    const values = countriesByShopId.get(shopId) ?? new Set();
    values.add(country);
    countriesByShopId.set(shopId, values);
  }

  let inferredCountryRows = 0;
  let unresolvedCountryRows = 0;
  let missingCoreRows = 0;
  let invalidGmvRows = 0;
  let missingL3Rows = 0;
  let ignoredCostRows = 0;
  const optionalNumericFields = [
    "dollar_cost",
    "ads_ctr",
    "ads_cvr",
    "ads_cpm",
    "roas",
    "ads_show_count",
  ];
  const ignoredOptionalByField = new Map();
  const analysisRows = [];

  for (const sourceRow of table.rows) {
    const row = { ...sourceRow };
    const productId = String(row.product_id ?? "").trim();
    const shopId = String(row.shop_id ?? "").trim();
    const productDamage = obviousIdTransportDamage(row, "product_id");
    const shopDamage = obviousIdTransportDamage(row, "shop_id");
    if (productDamage || shopDamage) {
      damagedIdRows += 1;
      isolatedRows.push({
        row: row.__row,
        reason: "obvious_excel_id_transport_damage",
        fields: [
          ...(productDamage ? [`product_id:${productDamage}`] : []),
          ...(shopDamage ? [`shop_id:${shopDamage}`] : []),
        ],
      });
      continue;
    }
    if (!productId || !shopId) {
      missingCoreRows += 1;
      isolatedRows.push({
        row: row.__row,
        reason: "missing_product_id_or_shop_id",
      });
      continue;
    }
    const gmv = parseNumber(row.payment_1d);
    if (gmv === null || Number.isNaN(gmv)) {
      invalidGmvRows += 1;
      isolatedRows.push({ row: row.__row, reason: "missing_or_invalid_payment_1d" });
      continue;
    }

    let country = normalizeCountry(row.shop_operation_country);
    if (!country) {
      const candidates = countriesByShopId.get(shopId);
      if (candidates?.size === 1) {
        [country] = candidates;
        inferredCountryRows += 1;
        row.__country_source = "same_shop_id_unique_country";
      } else {
        country = "UNKNOWN";
        unresolvedCountryRows += 1;
        row.__country_source = "unresolved_unknown";
      }
    } else {
      row.__country_source = "source";
    }
    row.product_id = productId;
    row.shop_id = shopId;
    row.shop_operation_country = country;

    if (!String(row.product_new_cbec_industry_l3 ?? "").trim()) {
      missingL3Rows += 1;
    }
    for (const field of optionalNumericFields) {
      if (!table.headers.includes(field)) continue;
      const parsed = parseNumber(row[field]);
      if (parsed === null || Number.isNaN(parsed)) {
        ignoredOptionalByField.set(
          field,
          (ignoredOptionalByField.get(field) ?? 0) + 1,
        );
        if (field === "dollar_cost") ignoredCostRows += 1;
      }
    }
    analysisRows.push(row);
  }

  if (inferredCountryRows > 0) {
    autoHandled.push(
      `${inferredCountryRows} 行空国家已按同一 Shop ID 的唯一国家自动回填；只使用 ID 层级表内部信息。`,
    );
  }
  if (unresolvedCountryRows > 0) {
    autoHandled.push(
      `${unresolvedCountryRows} 行国家无法从同 Shop ID 唯一确定，已保留为 UNKNOWN 参与事实汇总；不悄悄并入任一国家。`,
    );
  }
  if (missingCoreRows > 0) {
    autoHandled.push(
      `${missingCoreRows} 行缺少 Product ID 或 Shop ID，已隔离，其余经营行继续。`,
    );
  }
  if (invalidGmvRows > 0) {
    autoHandled.push(
      `${invalidGmvRows} 行 payment_1d 为空或非数字，已隔离，不将空值当作 0。`,
    );
  }
  if (damagedIdRows > 0) {
    notices.push(
      `${damagedIdRows} 行出现明显 Excel ID 传输损坏（科学计数法、浮点或长 ID 数值单元格），已隔离；源 ID 未被猜测或改写。`,
    );
  }
  if (missingL3Rows > 0) {
    autoHandled.push(
      `${missingL3Rows} 行 L3 为空；保留商品进入分析，后续仅依据商品名称进行语义推断，不改写源字段。`,
    );
  }
  const optionalDetails = [...ignoredOptionalByField.entries()]
    .filter(([field]) => field !== "dollar_cost")
    .map(([field, count]) => `${field} ${count} 行`)
    .join("、");
  if (ignoredCostRows > 0) {
    autoHandled.push(
      `${ignoredCostRows} 行 cost 为空或非数字；该行不参与 cost/ROAS 计算，其他指标继续使用。`,
    );
  }
  if (optionalDetails) {
    autoHandled.push(
      `可选指标空值或非数字已按字段跳过：${optionalDetails}；均未按 0 处理。`,
    );
  }
  return { analysisRows, isolatedRows, damagedIdRows };
}

function prepareAnalysisNameRows(table, autoHandled, notices) {
  const analysisRows = [];
  const isolatedRows = [];
  let missingProductIdRows = 0;
  let damagedIdRows = 0;
  let missingProductNameRows = 0;
  let missingShopNameRows = 0;

  for (const sourceRow of table.rows) {
    const row = { ...sourceRow };
    const productId = String(row.product_id ?? "").trim();
    const productDamage = obviousIdTransportDamage(row, "product_id");
    const shopDamage = obviousIdTransportDamage(row, "shop_id");
    if (productDamage || shopDamage) {
      damagedIdRows += 1;
      isolatedRows.push({
        row: row.__row,
        reason: "obvious_excel_id_transport_damage",
      });
      continue;
    }
    if (!productId) {
      missingProductIdRows += 1;
      isolatedRows.push({ row: row.__row, reason: "missing_product_id" });
      continue;
    }
    row.product_id = productId;
    row.shop_id = String(row.shop_id ?? "").trim();
    row.shop_operation_country = normalizeCountry(row.shop_operation_country);
    if (!String(row.product_name ?? "").trim()) missingProductNameRows += 1;
    if (!String(row.shop_name ?? "").trim()) missingShopNameRows += 1;
    analysisRows.push(row);
  }

  if (missingProductIdRows > 0) {
    autoHandled.push(
      `名称对照表 ${missingProductIdRows} 行缺少 Product ID，已隔离；不影响 ID 层级事实数。`,
    );
  }
  if (damagedIdRows > 0) {
    notices.push(
      `名称对照表 ${damagedIdRows} 行出现明显 Excel ID 传输损坏，已隔离且未用于匹配。`,
    );
  }
  if (missingProductNameRows > 0 || missingShopNameRows > 0) {
    autoHandled.push(
      `名称对照表空名称自动跳过：product_name ${missingProductNameRows} 行、shop_name ${missingShopNameRows} 行；有 ID 的经营事实仍保留。`,
    );
  }
  return { analysisRows, isolatedRows };
}

export function validateInputs({
  idDataPath,
  nameDataPath,
  reportWindowRaw,
  merchantWindowRaw,
  gcrmWindowRaw,
}) {
  const hardBlockers = [];
  const autoHandled = [];
  const notices = [];
  let idTable;
  let nameTable;
  let reportWindow;
  let merchantWindow;
  let gcrmWindow;

  try {
    const normalizedRaw = resolveReportWindowArgs({
      "report-window": reportWindowRaw,
      "merchant-window": merchantWindowRaw,
      "gcrm-window": gcrmWindowRaw,
    });
    reportWindow = parseWindow(normalizedRaw, "报告周期");
    // Backward-compatible internal aliases. They can no longer diverge.
    merchantWindow = reportWindow;
    gcrmWindow = reportWindow;
  } catch (error) {
    hardBlockers.push(error.message);
  }
  try {
    ({ idTable, nameTable } = loadInputTables(idDataPath, nameDataPath));
  } catch (error) {
    hardBlockers.push(`客户数据读取失败：${error.message}`);
  }

  if (idTable) {
    const missing = missingHeaders(idTable, ID_DATA_REQUIRED);
    if (missing.length > 0) {
      hardBlockers.push(`ID 层级表缺少核心字段：${missing.join("、")}`);
    }
  }
  if (nameTable) {
    const missing = missingHeaders(nameTable, NAME_DATA_REQUIRED);
    if (missing.length > 0) {
      hardBlockers.push(`名称对照表缺少核心字段：${missing.join("、")}`);
    }
    if (
      !nameTable.headers.includes("product_name") &&
      !nameTable.headers.includes("shop_name")
    ) {
      hardBlockers.push("名称对照表至少需要 product_name 或 shop_name 字段。");
    }
  }

  let analysisIdRows = [];
  let analysisNameRows = [];
  let isolatedIdRows = [];
  let isolatedNameRows = [];
  if (
    idTable &&
    ID_DATA_REQUIRED.every((field) => idTable.headers.includes(field))
  ) {
    const prepared = prepareAnalysisIdRows(idTable, autoHandled, notices);
    analysisIdRows = prepared.analysisRows;
    isolatedIdRows = prepared.isolatedRows;
    idTable.analysisRows = analysisIdRows;
    idTable.isolatedRows = isolatedIdRows;
    if (analysisIdRows.length === 0) {
      hardBlockers.push(
        "ID 层级表没有任何可用经营行：核心 Product ID / Shop ID 与 payment_1d 无法共同形成可分析记录。",
      );
    }
  }
  if (
    nameTable &&
    NAME_DATA_REQUIRED.every((field) => nameTable.headers.includes(field))
  ) {
    const prepared = prepareAnalysisNameRows(nameTable, autoHandled, notices);
    analysisNameRows = prepared.analysisRows;
    isolatedNameRows = prepared.isolatedRows;
    nameTable.analysisRows = analysisNameRows;
    nameTable.isolatedRows = isolatedNameRows;
    if (nameTable.rows.length === 0) {
      hardBlockers.push("名称对照表没有数据行。");
    } else if (analysisNameRows.length === 0) {
      hardBlockers.push("名称对照表的 Product ID 整体不可用。");
    }
  }

  let coverage = null;
  if (analysisIdRows.length > 0 && nameTable) {
    const idPairs = new Set(analysisIdRows.map(namePairKey));
    const namePairs = new Set(
      analysisNameRows
        .filter((row) => row.shop_id)
        .map(namePairKey),
    );
    const nameProductIds = new Set(
      analysisNameRows.map((row) => row.product_id).filter(Boolean),
    );
    const matchedPairs = [...idPairs].filter((key) => {
      if (namePairs.has(key)) return true;
      const productId = key.split("\u001f")[1];
      return nameProductIds.has(productId);
    });
    const matchedPairSet = new Set(matchedPairs);
    const missingNamePairs = [...idPairs].filter((key) => !matchedPairSet.has(key));
    const idProductIds = new Set(analysisIdRows.map((row) => row.product_id));
    const extraNameRows = analysisNameRows.filter(
      (row) => !idProductIds.has(row.product_id),
    );
    coverage = {
      id_pair_count: idPairs.size,
      name_pair_count: namePairs.size,
      matched_pair_count: matchedPairs.length,
      missing_name_pair_count: missingNamePairs.length,
      extra_name_pair_count: new Set(extraNameRows.map(namePairKey)).size,
      id_rows_total: idTable.rows.length,
      id_rows_analysis_ready: analysisIdRows.length,
      id_rows_isolated: isolatedIdRows.length,
      name_rows_total: nameTable.rows.length,
      name_rows_usable: analysisNameRows.length,
      name_rows_isolated: isolatedNameRows.length,
    };
    coverage.matched_pair_rate =
      coverage.id_pair_count === 0
        ? null
        : round(coverage.matched_pair_count / coverage.id_pair_count, 6);
    const gmvCoverageByCountry = new Map();
    for (const row of analysisIdRows) {
      const country = row.shop_operation_country;
      const bucket = gmvCoverageByCountry.get(country) ?? {
        shop_operation_country: country,
        total_gmv: 0,
        matched_name_gmv: 0,
      };
      const value = parseNumber(row.payment_1d);
      if (Number.isFinite(value)) {
        bucket.total_gmv += value;
        if (
          namePairs.has(namePairKey(row)) ||
          nameProductIds.has(row.product_id)
        ) {
          bucket.matched_name_gmv += value;
        }
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
      notices.push(
        "名称对照表未命中任何可用经营行；仍以 ID 层级表继续，但商品语义将受限。客户/集团名与 Shop Name 不一致不属于异常。",
      );
    } else if (missingNamePairs.length > 0) {
      autoHandled.push(
        `名称对照表未覆盖 ID 层级表中的 ${missingNamePairs.length} 个 Shop ID + Product ID 组合；未命中行仍按事实指标进入底表。`,
      );
    }
    if (coverage.extra_name_pair_count > 0) {
      autoHandled.push(
        `名称对照表有 ${coverage.extra_name_pair_count} 个组合不在 ID 层级事实表中；仅作别名参考，不进入指标汇总。`,
      );
    }
  }

  if (analysisIdRows.length > 0) {
    const duplicateRows =
      analysisIdRows.length - new Set(analysisIdRows.map(idKey)).size;
    if (duplicateRows > 0) {
      autoHandled.push(
        `ID 数据同一聚合键有 ${duplicateRows} 条重复/拆分行；prepare_portfolio 会按 country × shop_id × product_id 加总并重算比率。`,
      );
    }
  }

  const analysisReady = hardBlockers.length === 0;
  const warnings = [...autoHandled, ...notices];
  return {
    analysis_ready: analysisReady,
    hard_blockers: hardBlockers,
    auto_handled: autoHandled,
    notices,
    ok: analysisReady,
    errors: hardBlockers,
    warnings,
    reportWindow,
    merchantWindow,
    gcrmWindow,
    idTable,
    nameTable,
    analysisIdRows,
    analysisNameRows,
    isolatedIdRows,
    isolatedNameRows,
    coverage,
    countries: analysisIdRows.length
      ? [...new Set(analysisIdRows.map((row) => row.shop_operation_country))].sort(
          (a, b) => a.localeCompare(b),
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
