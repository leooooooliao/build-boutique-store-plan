#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  parseArgs,
  parseNumber,
  requireOptions,
  round,
  safeRatio,
  validateInputs,
} from "./lib.mjs";

const HELP = `
把 ID 指标事实表确定性汇总为精品大店分析底表，并用名字表补充别名。

用法：
  node scripts/prepare_portfolio.mjs \\
    --id-data <ID数据.csv|tsv> \\
    --name-data <名字对照.csv|tsv> \\
    --merchant "<商家名称>" \\
    --currency "<金额口径/币种>" \\
    --confirm-same-merchant yes \\
    --confirm-same-period yes \\
    --merchant-window 2026-07-01..2026-07-26 \\
    --gcrm-window 2026-06-29..2026-07-28 \\
    [--output portfolio.json]

输出口径：
  - 唯一指标粒度：country × shop_id × product_id。
  - GMV、消耗、曝光先加总；ROAS、CTR、CVR、CPM从加总后的分子/分母重算。
  - 名字表只补 product_name / shop_name 别名，不贡献任何指标。
  - ID 全程保留字符串，避免 19 位数字丢精度。
  - 只输出分国家合计，不生成跨国总 GMV；金额口径来自使用者确认。
`.trim();

function keyOf(row) {
  return `${row.shop_operation_country}\u001f${row.shop_id}\u001f${row.product_id}`;
}

function rankAliases(values) {
  const counts = new Map();
  for (const value of values) {
    const clean = String(value ?? "").trim();
    if (!clean) continue;
    counts.set(clean, (counts.get(clean) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value]) => value);
}

function addNumber(target, field, raw) {
  const parsed = parseNumber(raw);
  if (parsed !== null && !Number.isNaN(parsed)) {
    target[field] += parsed;
    return parsed;
  }
  return null;
}

function aggregateProducts(idRows, nameRows) {
  const aliasesByKey = new Map();
  const aliasesByProductId = new Map();
  const shopAliasesByKey = new Map();
  for (const row of nameRows) {
    const key = keyOf(row);
    const bucket = aliasesByKey.get(key) ?? { product_names: [], shop_names: [] };
    bucket.product_names.push(row.product_name);
    bucket.shop_names.push(row.shop_name);
    aliasesByKey.set(key, bucket);

    const productAliases = aliasesByProductId.get(row.product_id) ?? [];
    productAliases.push(row.product_name);
    aliasesByProductId.set(row.product_id, productAliases);

    const shopKey = `${row.shop_operation_country}\u001f${row.shop_id}`;
    const shopAliases = shopAliasesByKey.get(shopKey) ?? [];
    shopAliases.push(row.shop_name);
    shopAliasesByKey.set(shopKey, shopAliases);
  }

  const products = new Map();
  for (const row of idRows) {
    const key = keyOf(row);
    const bucket =
      products.get(key) ??
      {
        shop_operation_country: row.shop_operation_country,
        shop_id: row.shop_id,
        product_id: row.product_id,
        categories_raw: [],
        source_row_count: 0,
        gmv: 0,
        ad_cost: 0,
        impressions: 0,
        derived_clicks: 0,
        derived_orders: 0,
      };
    bucket.source_row_count += 1;
    bucket.categories_raw.push(row.product_new_cbec_industry_l3);
    addNumber(bucket, "gmv", row.payment_1d);
    addNumber(bucket, "ad_cost", row.dollar_cost);
    const impressions = addNumber(bucket, "impressions", row.ads_show_count);
    const ctr = parseNumber(row.ads_ctr);
    if (impressions !== null && ctr !== null && !Number.isNaN(ctr)) {
      const clicks = impressions * ctr;
      bucket.derived_clicks += clicks;
      const cvr = parseNumber(row.ads_cvr);
      if (cvr !== null && !Number.isNaN(cvr)) {
        bucket.derived_orders += clicks * cvr;
      }
    }
    products.set(key, bucket);
  }

  return [...products.entries()]
    .map(([key, bucket]) => {
      const exactAliases = aliasesByKey.get(key);
      const fallbackProductAliases = aliasesByProductId.get(bucket.product_id) ?? [];
      const productNames = rankAliases(
        exactAliases?.product_names?.length
          ? exactAliases.product_names
          : fallbackProductAliases,
      );
      const shopKey = `${bucket.shop_operation_country}\u001f${bucket.shop_id}`;
      const shopNames = rankAliases(shopAliasesByKey.get(shopKey) ?? []);
      const categories = rankAliases(bucket.categories_raw);
      const lowAdCost = bucket.ad_cost > 0 && bucket.ad_cost < 0.01;
      return {
        shop_operation_country: bucket.shop_operation_country,
        shop_id: bucket.shop_id,
        shop_name: shopNames[0] ?? null,
        shop_name_aliases: shopNames,
        product_id: bucket.product_id,
        product_name: productNames[0] ?? null,
        product_name_aliases: productNames,
        industry_l3: categories[0] ?? null,
        industry_l3_aliases: categories,
        metrics: {
          gmv: round(bucket.gmv, 6),
          ad_cost: round(bucket.ad_cost, 6),
          impressions: round(bucket.impressions, 6),
          roas: round(safeRatio(bucket.gmv, bucket.ad_cost), 4),
          ctr: round(safeRatio(bucket.derived_clicks, bucket.impressions), 6),
          cvr: round(safeRatio(bucket.derived_orders, bucket.derived_clicks), 6),
          cpm: round(safeRatio(bucket.ad_cost * 1000, bucket.impressions), 6),
        },
        audit: {
          id_source_row_count: bucket.source_row_count,
          product_name_alias_count: productNames.length,
          shop_name_alias_count: shopNames.length,
          product_name_match: exactAliases?.product_names?.length
            ? "country_shop_product_exact"
            : productNames.length > 0
              ? "product_id_fallback"
              : "unmatched",
          ad_cost_below_cent: lowAdCost,
          roas_reliability: lowAdCost
            ? "low_ad_cost_directional"
            : bucket.ad_cost === 0
              ? "not_computable"
              : "standard",
        },
      };
    })
    .sort(
      (left, right) =>
        right.metrics.gmv - left.metrics.gmv ||
        left.shop_id.localeCompare(right.shop_id) ||
        left.product_id.localeCompare(right.product_id),
    );
}

function summarizeShops(products) {
  const shops = new Map();
  for (const product of products) {
    const key = `${product.shop_operation_country}\u001f${product.shop_id}`;
    const bucket =
      shops.get(key) ??
      {
        shop_operation_country: product.shop_operation_country,
        shop_id: product.shop_id,
        canonical_shop_names: [],
        shop_name_aliases: new Set(),
        product_count: 0,
        gmv: 0,
        ad_cost: 0,
        categories: new Set(),
        products: [],
      };
    if (product.shop_name) bucket.canonical_shop_names.push(product.shop_name);
    for (const alias of product.shop_name_aliases) bucket.shop_name_aliases.add(alias);
    bucket.product_count += 1;
    bucket.gmv += product.metrics.gmv;
    bucket.ad_cost += product.metrics.ad_cost;
    if (product.industry_l3) bucket.categories.add(product.industry_l3);
    bucket.products.push({
      product_id: product.product_id,
      product_name: product.product_name,
      industry_l3: product.industry_l3,
      gmv: product.metrics.gmv,
      roas: product.metrics.roas,
    });
    shops.set(key, bucket);
  }
  return [...shops.values()]
    .map((bucket) => {
      const canonicalName = rankAliases(bucket.canonical_shop_names)[0] ?? null;
      const names = [
        ...(canonicalName ? [canonicalName] : []),
        ...[...bucket.shop_name_aliases]
          .filter((name) => name !== canonicalName)
          .sort((a, b) => a.localeCompare(b)),
      ];
      return {
        shop_operation_country: bucket.shop_operation_country,
        shop_id: bucket.shop_id,
        shop_name: canonicalName,
        shop_name_aliases: names,
        product_count: bucket.product_count,
        industry_l3: [...bucket.categories].sort((a, b) => a.localeCompare(b)),
        metrics: {
          gmv: round(bucket.gmv, 6),
          ad_cost: round(bucket.ad_cost, 6),
          roas: round(safeRatio(bucket.gmv, bucket.ad_cost), 4),
        },
        top_products: bucket.products
          .sort(
            (left, right) =>
              right.gmv - left.gmv || left.product_id.localeCompare(right.product_id),
          )
          .slice(0, 10),
      };
    })
    .sort(
      (left, right) =>
        left.shop_operation_country.localeCompare(right.shop_operation_country) ||
        right.metrics.gmv - left.metrics.gmv ||
        left.shop_id.localeCompare(right.shop_id),
    );
}

function summarizeCountries(products, currencyOrUnit) {
  const countries = new Map();
  for (const product of products) {
    const bucket =
      countries.get(product.shop_operation_country) ?? {
        shop_operation_country: product.shop_operation_country,
        product_count: 0,
        shop_ids: new Set(),
        gmv: 0,
        ad_cost: 0,
      };
    bucket.product_count += 1;
    bucket.shop_ids.add(product.shop_id);
    bucket.gmv += product.metrics.gmv;
    bucket.ad_cost += product.metrics.ad_cost;
    countries.set(product.shop_operation_country, bucket);
  }
  return [...countries.values()]
    .map((bucket) => ({
      shop_operation_country: bucket.shop_operation_country,
      currency_or_unit: currencyOrUnit,
      product_count: bucket.product_count,
      shop_count: bucket.shop_ids.size,
      metrics: {
        gmv: round(bucket.gmv, 6),
        ad_cost: round(bucket.ad_cost, 6),
        roas: round(safeRatio(bucket.gmv, bucket.ad_cost), 4),
      },
    }))
    .sort((left, right) =>
      left.shop_operation_country.localeCompare(right.shop_operation_country),
    );
}

function buildOutput(validation, idDataPath, nameDataPath, metadata) {
  const products = aggregateProducts(validation.idTable.rows, validation.nameTable.rows);
  const shops = summarizeShops(products);
  const countrySummary = summarizeCountries(products, metadata.currency);
  const productAliasConflicts = products.filter(
    (product) => product.product_name_aliases.length > 1,
  ).length;
  const shopAliasConflicts = shops.filter((shop) => shop.shop_name_aliases.length > 1).length;

  return {
    schema_version: "1.1",
    generated_at: new Date().toISOString(),
    periods: {
      merchant_portfolio: validation.merchantWindow,
      gcrm_marketing_advisor: validation.gcrmWindow,
    },
    policy: {
      metric_source: "ID 数据",
      name_source: "名字对照数据，仅作别名和商品语义理解",
      aggregation_grain: "shop_operation_country × shop_id × product_id",
      id_type: "string",
      ratio_rule: "先加总分子/分母，再重算 ROAS/CTR/CVR/CPM",
      currency_or_unit: metadata.currency,
      cross_country_total: "not_computed",
      total_scope_warning:
        "所有合计只按国家展示且仅代表输入商品清单，不代表客户大盘；不得据此推断客户整体 GMV。",
    },
    confirmations: {
      merchant: metadata.merchant,
      same_merchant: true,
      same_customer_period: true,
      basis: "user-confirmed; source tables do not contain merchant/date proof fields",
    },
    sources: {
      id_data_file: path.basename(idDataPath),
      name_data_file: path.basename(nameDataPath),
    },
    audit: {
      input_id_rows: validation.idTable.rows.length,
      input_name_rows: validation.nameTable.rows.length,
      output_product_rows: products.length,
      output_shop_rows: shops.length,
      coverage: validation.coverage,
      product_alias_conflict_count: productAliasConflicts,
      shop_alias_conflict_count: shopAliasConflicts,
      warnings: validation.warnings,
    },
    country_summary: countrySummary,
    shop_summary: shops,
    product_rows: products,
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
  if (!validation.ok) {
    for (const error of validation.errors) process.stderr.write(`ERROR: ${error}\n`);
    for (const warning of validation.warnings) process.stderr.write(`WARN: ${warning}\n`);
    process.exit(1);
  }
  const output = buildOutput(validation, args["id-data"], args["name-data"], {
    merchant: String(args.merchant),
    currency: String(args.currency),
  });
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.output && args.output !== true) {
    const target = path.resolve(args.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serialized, "utf8");
    process.stdout.write(
      `PASS\n已写入 ${target}\n${output.product_rows.length} 个商品聚合行；${output.shop_summary.length} 个店铺。\n`,
    );
  } else {
    process.stdout.write(serialized);
  }
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exit(1);
}
