#!/usr/bin/env node

import {
  parseArgs,
  printResult,
  requireOptions,
  resolveReportWindowArgs,
  validateInputs,
} from "./lib.mjs";

const HELP = `
校验精品大店分析所需的两张表与一个全文报告周期。

用法：
  node scripts/validate_input.mjs \\
    --workbook <一个含两张表的客户数据.xlsx> \\
    --report-window 2026-07-01..2026-07-26 [--json]

或继续使用 CSV/TSV：
  node scripts/validate_input.mjs \\
    --id-data <ID数据.csv|tsv> \\
    --name-data <名字对照.csv|tsv> \\
    --report-window 2026-07-01..2026-07-26 [--json]

说明：
  --workbook         推荐：一个 .xlsx 内含 ID 层级和名称对照两张 sheet，
                     脚本按表头自动识别，不要求固定 sheet 名。
  --id-data          指标事实表；按 Shop ID / Product ID 校准和汇总。
  --name-data        名字对照表；仅用于理解商品与店铺别名，不作为指标来源。
  --merchant         可选；客户/集团展示标签，不与 Shop Name 做一致性校验。
  --currency         可选；缺省为“内部报表原口径”，不改变源数值。
  --report-window    客户货盘与营销参谋共用的开始日和结束日。
                     旧版 --merchant-window / --gcrm-window 仍可作别名，但不允许不同周期。
  --json             输出机器可读 JSON。

支持一个 XLSX 两张 sheet、UTF-8 CSV/TSV，以及从两张完整表复制保存的制表符文本。
只隔离明显的 Excel ID 传输损坏，不因正常 ID 字符串长度不同而质疑源数据。
`.trim();

function publicSummary(validation, metadata) {
  const gmvCoverageText = (
    validation.coverage?.matched_name_gmv_by_country ?? []
  )
    .map((country) => {
      const rate = country.matched_name_gmv_rate;
      return `${country.shop_operation_country} ${
        rate === null ? "不可计算" : `${(rate * 100).toFixed(2)}%`
      }`;
    })
    .join("、");

  return {
    ok: validation.ok,
    analysis_ready: validation.analysis_ready,
    status: validation.analysis_ready ? "analysis_ready" : "hard_blocked",
    hard_blockers: validation.hard_blockers,
    auto_handled: validation.auto_handled,
    notices: validation.notices,
    // Backward-compatible aliases.
    errors: validation.errors,
    warnings: validation.warnings,
    context: {
      merchant: metadata.merchant,
      currency_or_unit: metadata.currency,
      merchant_role: "display_label_only",
      metric_policy: "ID 层级表原样事实；不更改源数值",
    },
    periods: { report: validation.reportWindow ?? null },
    inputs: {
      id_rows: validation.idTable?.rows.length ?? 0,
      name_rows: validation.nameTable?.rows.length ?? 0,
      analysis_rows: validation.analysisIdRows?.length ?? 0,
      isolated_id_rows: validation.isolatedIdRows?.length ?? 0,
      countries: validation.countries,
      id_transport: validation.analysis_ready
        ? "safe_values_kept; obvious_damage_isolated"
        : "see_hard_blockers",
      sheets: {
        id: validation.idTable?.sheetName ?? null,
        names: validation.nameTable?.sheetName ?? null,
      },
      coverage: validation.coverage,
    },
    messages: validation.analysis_ready
      ? [
          `报告周期：${validation.reportWindow.display}`,
          `ID 数据 ${validation.idTable.rows.length} 行，其中 ${validation.analysisIdRows.length} 行进入分析；名字对照 ${validation.nameTable.rows.length} 行。`,
          `覆盖国家：${validation.countries.join("、") || "无"}；金额口径：${metadata.currency}。`,
          `名称匹配率：${(
            (validation.coverage?.matched_pair_rate ?? 0) * 100
          ).toFixed(2)}%；各国命名 GMV 覆盖率：${gmvCoverageText || "无"}。`,
          "ID 规则：正常字符串原样保留；仅隔离明显的科学计数法、浮点或长 ID 数值单元格。",
        ]
      : [],
  };
}

function resolveDataPaths(args) {
  if (args.workbook && args.workbook !== true) {
    return {
      idDataPath: String(args.workbook),
      nameDataPath: String(args.workbook),
    };
  }
  requireOptions(args, ["id-data", "name-data"]);
  return {
    idDataPath: String(args["id-data"]),
    nameDataPath: String(args["name-data"]),
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

try {
  const reportWindowRaw = resolveReportWindowArgs(args);
  const dataPaths = resolveDataPaths(args);
  const validation = validateInputs({
    ...dataPaths,
    reportWindowRaw,
  });
  const summary = publicSummary(validation, {
    merchant:
      args.merchant && args.merchant !== true ? String(args.merchant) : "未提供客户/集团标签",
    currency:
      args.currency && args.currency !== true ? String(args.currency) : "内部报表原口径",
  });
  printResult(summary, Boolean(args.json));
  process.exit(validation.ok ? 0 : 1);
} catch (error) {
  printResult(
    {
      ok: false,
      analysis_ready: false,
      hard_blockers: [error.message],
      auto_handled: [],
      notices: [],
      errors: [error.message],
      warnings: [],
    },
    Boolean(args.json),
  );
  process.exit(1);
}
