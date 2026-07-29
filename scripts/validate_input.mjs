#!/usr/bin/env node

import {
  parseArgs,
  printResult,
  requireOptions,
  validateInputs,
} from "./lib.mjs";

const HELP = `
校验精品大店分析所需的两份表格与两个明确周期。

用法：
  node scripts/validate_input.mjs \\
    --id-data <ID数据.csv|tsv> \\
    --name-data <名字对照.csv|tsv> \\
    --merchant "<商家名称>" \\
    --currency "<金额口径/币种>" \\
    --confirm-same-merchant yes \\
    --confirm-same-period yes \\
    --merchant-window 2026-07-01..2026-07-26 \\
    --gcrm-window 2026-06-29..2026-07-28 [--json]

说明：
  --id-data          指标事实表；按 Shop ID / Product ID 校准和汇总。
  --name-data        名字对照表；仅用于理解商品与店铺别名，不作为指标来源。
  --merchant         使用者确认的本次分析商家。
  --currency         使用者确认的金额口径/币种；跨国本币写“各国本币分国展示”。
  --confirm-same-merchant  必须为 yes，确认两个报表都选择同一商家。
  --confirm-same-period    必须为 yes，确认两份客户数据属于同一周期。
  --merchant-window  客户货盘数据的开始日和结束日，不能省略或猜测。
  --gcrm-window      营销参谋查询的开始日和结束日，不能省略或猜测。
  --json             输出机器可读 JSON。

支持 UTF-8 CSV、TSV 和从 Excel 复制保存的制表符文本。
不直接解析 .xlsx/.xls；请先另存为 UTF-8 CSV 或复制为 TSV，以保护 19 位 ID。
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
    status: validation.ok ? "validated_with_user_confirmations" : "blocked",
    errors: validation.errors,
    warnings: validation.warnings,
    confirmations: {
      merchant: metadata.merchant,
      currency_or_unit: metadata.currency,
      same_merchant: true,
      same_customer_period: true,
      basis: "user-confirmed; source tables do not contain merchant/date proof fields",
    },
    periods: {
      merchant: validation.merchantWindow ?? null,
      gcrm: validation.gcrmWindow ?? null,
    },
    inputs: {
      id_rows: validation.idTable?.rows.length ?? 0,
      name_rows: validation.nameTable?.rows.length ?? 0,
      countries: validation.countries,
      id_format: validation.ok ? "19-digit-string-pass" : "see-errors",
      coverage: validation.coverage,
    },
    messages: validation.ok
      ? [
          `客户货盘周期：${validation.merchantWindow.display}`,
          `营销参谋周期：${validation.gcrmWindow.display}`,
          `ID 数据 ${validation.idTable.rows.length} 行；名字对照 ${validation.nameTable.rows.length} 行。`,
          `覆盖国家：${validation.countries.join("、") || "无"}；金额口径：${metadata.currency}。`,
          `名称匹配率：${(
            (validation.coverage?.matched_pair_rate ?? 0) * 100
          ).toFixed(2)}%；各国命名 GMV 覆盖率：${gmvCoverageText || "无"}。`,
          "ID 格式：Product ID / Shop ID 均为 19 位文本，异常 0。",
        ]
      : [],
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

try {
  requireOptions(args, [
    "id-data",
    "name-data",
    "merchant",
    "currency",
    "confirm-same-merchant",
    "confirm-same-period",
    "merchant-window",
    "gcrm-window",
  ]);
  if (String(args["confirm-same-merchant"]).toLowerCase() !== "yes") {
    throw new Error("--confirm-same-merchant 必须为 yes；请先确认两个报表选择同一商家。");
  }
  if (String(args["confirm-same-period"]).toLowerCase() !== "yes") {
    throw new Error("--confirm-same-period 必须为 yes；请先确认两份客户数据属于同一周期。");
  }
  const validation = validateInputs({
    idDataPath: args["id-data"],
    nameDataPath: args["name-data"],
    merchantWindowRaw: args["merchant-window"],
    gcrmWindowRaw: args["gcrm-window"],
  });
  const summary = publicSummary(validation, {
    merchant: String(args.merchant),
    currency: String(args.currency),
  });
  printResult(summary, Boolean(args.json));
  process.exit(validation.ok ? 0 : 1);
} catch (error) {
  printResult({ ok: false, errors: [error.message], warnings: [] }, Boolean(args.json));
  process.exit(1);
}
