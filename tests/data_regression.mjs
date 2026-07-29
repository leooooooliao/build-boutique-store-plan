#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtures = path.join(repositoryRoot, "tests", "fixtures");
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "boutique-data-regression-"),
);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const content = Buffer.from(value, "utf8");
    const compressed = zlib.deflateRawSync(content);
    const method = 8;
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function worksheetXml(rows) {
  const renderedRows = rows
    .map((values, rowIndex) => {
      const cells = values
        .map((value, columnIndex) => {
          if (value === null || value === undefined || value === "") return "";
          const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
          if (typeof value === "object" && Object.hasOwn(value, "number")) {
            return `<c r="${reference}"><v>${xmlEscape(value.number)}</v></c>`;
          }
          return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${renderedRows}</sheetData></worksheet>`;
}

function writeWorkbook(target, idRows, nameRows) {
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="原始指标" sheetId="1" r:id="rId1"/><sheet name="辅助名称" sheetId="2" r:id="rId2"/></sheets></workbook>';
  const relationships =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    "</Relationships>";
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    "</Types>";
  fs.writeFileSync(
    target,
    zipArchive([
      ["[Content_Types].xml", contentTypes],
      ["xl/workbook.xml", workbook],
      ["xl/_rels/workbook.xml.rels", relationships],
      ["xl/worksheets/sheet1.xml", worksheetXml(idRows)],
      ["xl/worksheets/sheet2.xml", worksheetXml(nameRows)],
    ]),
  );
}

function run(arguments_, expectedStatus = 0) {
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

const windows = [
  "--merchant-window",
  "2026-07-01..2026-07-26",
  "--gcrm-window",
  "2026-06-29..2026-07-28",
];

try {
  const workbookPath = path.join(temporaryDirectory, "two-sheet-input.xlsx");
  writeWorkbook(
    workbookPath,
    [
      ["客户货盘指标事实表"],
      [
        "product_id",
        "shop_operation_country",
        "shop_id",
        "product_new_cbec_industry_l3",
        "payment_1d",
        "dollar_cost",
      ],
      ["1736361530895796079", "MY", "7495791554040925039", "", { number: 100 }, ""],
      ["1736342617530009418", "", "7495791554040925039", "家居用品", { number: 50 }, { number: 10 }],
      ["1736342617530009419", "", "7495000000000000000", "户外用品", { number: 30 }, { number: 5 }],
      [{ number: "1736342617530009400" }, "MY", "7495791554040925039", "家居用品", { number: 20 }, { number: 2 }],
    ],
    [
      ["product_id", "product_name", "shop_name", "shop_id"],
      ["1736361530895796079", "多用途清洁刷", "Alpha Store", "7495791554040925039"],
      ["1736342617530009418", "", "Alpha Store", "7495791554040925039"],
      ["1736342617530009419", "露营灯", "Outdoor Store", "7495000000000000000"],
    ],
  );

  const validated = JSON.parse(
    run([
      "scripts/validate_input.mjs",
      "--workbook",
      workbookPath,
      ...windows,
      "--json",
    ]).stdout,
  );
  assert.equal(validated.analysis_ready, true);
  assert.deepEqual(validated.inputs.sheets, {
    id: "原始指标",
    names: "辅助名称",
  });
  assert.equal(validated.inputs.analysis_rows, 2);
  assert.equal(validated.inputs.isolated_id_rows, 2);
  assert.ok(validated.auto_handled.some((message) => message.includes("空国家")));
  assert.ok(validated.auto_handled.some((message) => message.includes("L3 为空")));
  assert.ok(validated.notices.some((message) => message.includes("Excel ID")));

  const auditPath = path.join(temporaryDirectory, "workbook-audit.json");
  const compactPath = path.join(temporaryDirectory, "workbook-compact.json");
  run([
    "scripts/prepare_portfolio.mjs",
    "--workbook",
    workbookPath,
    ...windows,
    "--output",
    auditPath,
    "--analysis-output",
    compactPath,
  ]);
  const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
  const compact = JSON.parse(fs.readFileSync(compactPath, "utf8"));
  assert.equal(audit.product_rows.length, 2);
  assert.equal(audit.product_rows[0].metrics.ad_cost, null);
  assert.equal(audit.product_rows[0].metrics.roas, null);
  assert.equal(audit.shop_summary[0].metrics.gmv, 150);
  assert.equal(audit.shop_summary[0].metrics.roas, 5);
  assert.equal(audit.shop_summary[0].metric_coverage.roas_row_rate, 0.5);
  assert.equal(compact.analysis_pool.countries[0].top_100.length, 2);

  const tolerantAuditPath = path.join(temporaryDirectory, "tolerant-audit.json");
  run([
    "scripts/prepare_portfolio.mjs",
    "--id-data",
    path.join(fixtures, "tolerant-id.tsv"),
    "--name-data",
    path.join(fixtures, "tolerant-names.tsv"),
    ...windows,
    "--output",
    tolerantAuditPath,
  ]);
  const tolerantAudit = JSON.parse(fs.readFileSync(tolerantAuditPath, "utf8"));
  assert.equal(tolerantAudit.audit.analysis_ready_id_rows, 3);
  const crossShopProduct =
    tolerantAudit.analysis_pool.countries[0].top_100.find(
      (row) => row.product_id === "1736361530895796079",
    );
  assert.equal(crossShopProduct.source_shop_count, 2);
  assert.equal(crossShopProduct.metrics.gmv, 150);
  assert.equal(crossShopProduct.metrics.roas, 5);
  assert.equal(crossShopProduct.source_shops[0].outside_this_shop_gmv_share, 0.333333);

  const badWorkbookPath = path.join(temporaryDirectory, "all-ids-damaged.xlsx");
  writeWorkbook(
    badWorkbookPath,
    [
      ["product_id", "shop_operation_country", "shop_id", "payment_1d"],
      [{ number: "1736342617530009400" }, "MY", "7495791554040925039", { number: 20 }],
    ],
    [
      ["product_id", "product_name", "shop_id"],
      ["1736342617530009400", "测试商品", "7495791554040925039"],
    ],
  );
  const blocked = JSON.parse(
    run([
      "scripts/validate_input.mjs",
      "--workbook",
      badWorkbookPath,
      ...windows,
      "--json",
    ], 1).stdout,
  );
  assert.equal(blocked.analysis_ready, false);
  assert.ok(
    blocked.hard_blockers.some((message) => message.includes("没有任何可用经营行")),
  );

  const largeWorkbookPath = path.join(temporaryDirectory, "large-pool.xlsx");
  const largeIdRows = [
    ["product_id", "shop_operation_country", "shop_id", "product_new_cbec_industry_l3", "payment_1d"],
  ];
  const largeNameRows = [["product_id", "product_name", "shop_name", "shop_id"]];
  for (let index = 1; index <= 110; index += 1) {
    const productId = `P${String(index).padStart(4, "0")}`;
    largeIdRows.push([productId, "MY", "SHOP1", "清洁工具", { number: 1 }]);
    largeNameRows.push([productId, "", "Alpha Store", "SHOP1"]);
  }
  writeWorkbook(largeWorkbookPath, largeIdRows, largeNameRows);
  const largeCompactPath = path.join(temporaryDirectory, "large-compact.json");
  run([
    "scripts/prepare_portfolio.mjs",
    "--workbook",
    largeWorkbookPath,
    ...windows,
    "--analysis-output",
    largeCompactPath,
  ]);
  const largeCompact = JSON.parse(fs.readFileSync(largeCompactPath, "utf8"));
  const largeSelection = largeCompact.analysis_pool.countries[0];
  assert.equal(largeSelection.selection.expansion_required, true);
  assert.equal(largeSelection.selection.recommended_limit, 110);
  assert.equal(largeSelection.top_100.length, 100);
  assert.equal(largeSelection.extension_101_200.length, 10);

  process.stdout.write("Data regression tests passed.\n");
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
