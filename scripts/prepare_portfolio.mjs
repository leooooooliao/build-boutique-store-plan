#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  parseArgs,
  parseNumber,
  requireOptions,
  resolveReportWindowArgs,
  round,
  safeRatio,
  validateInputs,
} from "./lib.mjs";

const HELP = `
把 ID 指标事实表确定性汇总为精品大店分析底表，并用名字表补充别名。

用法：
  node scripts/prepare_portfolio.mjs \\
    --workbook <一个含两张表的客户数据.xlsx> \\
    --report-window 2026-07-01..2026-07-26 \\
    [--output portfolio-audit.json] \\
    [--analysis-output analysis-pool.json]

或继续使用 CSV/TSV：
  node scripts/prepare_portfolio.mjs \\
    --id-data <ID数据.csv|tsv> \\
    --name-data <名字对照.csv|tsv> \\
    --report-window 2026-07-01..2026-07-26 \\
    [--output portfolio-audit.json] \\
    [--analysis-output analysis-pool.json]

输出口径：
  - 唯一指标粒度：country × shop_id × product_id。
  - GMV 来自全部有效 GMV 行；ROAS 只使用 GMV 与 cost 同时有效的同行数据。
  - 空指标不按 0；输出各指标覆盖率。
  - 名字表只补 product_name / shop_name 别名，不贡献任何指标。
  - 正常 ID 字符串原样保留；明显 Excel 传输损坏行隔离，不猜测修复。
  - analysis_pool 先按 country × product_id 跨店汇总，默认 Top100，
    GMV 分散或名称/语义覆盖不足时自动建议扩到 Top200。
  - 只输出分国家合计，不生成跨国总 GMV；缺省沿用内部报表原口径。
`.trim();

function keyOf(row) {
  return `${row.shop_operation_country}\u001f${row.shop_id}\u001f${row.product_id}`;
}

function nameKeyOf(row) {
  return `${String(row.shop_id ?? "").trim()}\u001f${String(
    row.product_id ?? "",
  ).trim()}`;
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

function finiteNumber(raw) {
  const parsed = parseNumber(raw);
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}

function aggregateProducts(idRows, nameRows) {
  const aliasesByKey = new Map();
  const aliasesByProductId = new Map();
  const shopAliasesByShopId = new Map();
  for (const row of nameRows) {
    const key = nameKeyOf(row);
    const bucket = aliasesByKey.get(key) ?? { product_names: [], shop_names: [] };
    bucket.product_names.push(row.product_name);
    bucket.shop_names.push(row.shop_name);
    aliasesByKey.set(key, bucket);

    const productAliases = aliasesByProductId.get(row.product_id) ?? [];
    productAliases.push(row.product_name);
    aliasesByProductId.set(row.product_id, productAliases);

    if (row.shop_id) {
      const shopAliases = shopAliasesByShopId.get(row.shop_id) ?? [];
      shopAliases.push(row.shop_name);
      shopAliasesByShopId.set(row.shop_id, shopAliases);
    }
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
        gmv_row_count: 0,
        ad_cost: 0,
        ad_cost_row_count: 0,
        impressions: 0,
        impressions_row_count: 0,
        roas_gmv: 0,
        roas_ad_cost: 0,
        roas_row_count: 0,
        derived_clicks: 0,
        ctr_impressions: 0,
        ctr_row_count: 0,
        derived_orders: 0,
        cvr_clicks: 0,
        cvr_row_count: 0,
        cpm_ad_cost: 0,
        cpm_impressions: 0,
        cpm_row_count: 0,
      };
    bucket.source_row_count += 1;
    bucket.categories_raw.push(row.product_new_cbec_industry_l3);
    const gmv = finiteNumber(row.payment_1d);
    const adCost = finiteNumber(row.dollar_cost);
    const impressions = finiteNumber(row.ads_show_count);
    const ctr = finiteNumber(row.ads_ctr);
    const cvr = finiteNumber(row.ads_cvr);
    if (gmv !== null) {
      bucket.gmv += gmv;
      bucket.gmv_row_count += 1;
    }
    if (adCost !== null) {
      bucket.ad_cost += adCost;
      bucket.ad_cost_row_count += 1;
    }
    if (impressions !== null) {
      bucket.impressions += impressions;
      bucket.impressions_row_count += 1;
    }
    if (gmv !== null && adCost !== null) {
      bucket.roas_gmv += gmv;
      bucket.roas_ad_cost += adCost;
      bucket.roas_row_count += 1;
    }
    if (impressions !== null && ctr !== null) {
      const clicks = impressions * ctr;
      bucket.derived_clicks += clicks;
      bucket.ctr_impressions += impressions;
      bucket.ctr_row_count += 1;
      if (cvr !== null) {
        bucket.derived_orders += clicks * cvr;
        bucket.cvr_clicks += clicks;
        bucket.cvr_row_count += 1;
      }
    }
    if (adCost !== null && impressions !== null) {
      bucket.cpm_ad_cost += adCost;
      bucket.cpm_impressions += impressions;
      bucket.cpm_row_count += 1;
    }
    products.set(key, bucket);
  }

  return [...products.entries()]
    .map(([key, bucket]) => {
      const exactAliases = aliasesByKey.get(
        `${bucket.shop_id}\u001f${bucket.product_id}`,
      );
      const fallbackProductAliases = aliasesByProductId.get(bucket.product_id) ?? [];
      const exactProductNames = rankAliases(exactAliases?.product_names ?? []);
      const productNames =
        exactProductNames.length > 0
          ? exactProductNames
          : rankAliases(fallbackProductAliases);
      const shopNames = rankAliases(shopAliasesByShopId.get(bucket.shop_id) ?? []);
      const categories = rankAliases(bucket.categories_raw);
      const lowAdCost =
        bucket.roas_row_count > 0 &&
        bucket.roas_ad_cost > 0 &&
        bucket.roas_ad_cost < 0.01;
      const roasGmvCoverage =
        bucket.gmv === 0
          ? null
          : safeRatio(bucket.roas_gmv, bucket.gmv);
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
          ad_cost:
            bucket.ad_cost_row_count === 0 ? null : round(bucket.ad_cost, 6),
          impressions:
            bucket.impressions_row_count === 0
              ? null
              : round(bucket.impressions, 6),
          roas: round(safeRatio(bucket.roas_gmv, bucket.roas_ad_cost), 4),
          ctr: round(
            safeRatio(bucket.derived_clicks, bucket.ctr_impressions),
            6,
          ),
          cvr: round(
            safeRatio(bucket.derived_orders, bucket.cvr_clicks),
            6,
          ),
          cpm: round(
            safeRatio(bucket.cpm_ad_cost * 1000, bucket.cpm_impressions),
            6,
          ),
        },
        metric_coverage: {
          source_rows: bucket.source_row_count,
          gmv_rows: bucket.gmv_row_count,
          ad_cost_rows: bucket.ad_cost_row_count,
          roas_matched_rows: bucket.roas_row_count,
          roas_row_rate: round(
            safeRatio(bucket.roas_row_count, bucket.source_row_count),
            6,
          ),
          roas_gmv_coverage_rate: round(roasGmvCoverage, 6),
          ctr_matched_rows: bucket.ctr_row_count,
          cvr_matched_rows: bucket.cvr_row_count,
          cpm_matched_rows: bucket.cpm_row_count,
        },
        audit: {
          id_source_row_count: bucket.source_row_count,
          product_name_alias_count: productNames.length,
          shop_name_alias_count: shopNames.length,
          product_name_match: exactProductNames.length > 0
            ? "shop_product_exact"
            : productNames.length > 0
              ? "product_id_fallback"
              : "unmatched",
          ad_cost_below_cent: lowAdCost,
          ratio_basis: {
            roas_gmv: round(bucket.roas_gmv, 6),
            roas_ad_cost: round(bucket.roas_ad_cost, 6),
            ctr_clicks: round(bucket.derived_clicks, 6),
            ctr_impressions: round(bucket.ctr_impressions, 6),
            cvr_orders: round(bucket.derived_orders, 6),
            cvr_clicks: round(bucket.cvr_clicks, 6),
            cpm_ad_cost: round(bucket.cpm_ad_cost, 6),
            cpm_impressions: round(bucket.cpm_impressions, 6),
          },
          roas_reliability: lowAdCost
            ? "low_ad_cost_directional"
            : bucket.roas_row_count === 0 || bucket.roas_ad_cost === 0
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
        ad_cost_product_count: 0,
        roas_gmv: 0,
        roas_ad_cost: 0,
        source_rows: 0,
        roas_matched_rows: 0,
        categories: new Set(),
        products: [],
      };
    if (product.shop_name) bucket.canonical_shop_names.push(product.shop_name);
    for (const alias of product.shop_name_aliases) bucket.shop_name_aliases.add(alias);
    bucket.product_count += 1;
    bucket.gmv += product.metrics.gmv;
    if (product.metrics.ad_cost !== null) {
      bucket.ad_cost += product.metrics.ad_cost;
      bucket.ad_cost_product_count += 1;
    }
    bucket.roas_gmv += product.audit.ratio_basis.roas_gmv ?? 0;
    bucket.roas_ad_cost += product.audit.ratio_basis.roas_ad_cost ?? 0;
    bucket.source_rows += product.metric_coverage.source_rows;
    bucket.roas_matched_rows += product.metric_coverage.roas_matched_rows;
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
          ad_cost:
            bucket.ad_cost_product_count === 0 ? null : round(bucket.ad_cost, 6),
          roas: round(safeRatio(bucket.roas_gmv, bucket.roas_ad_cost), 4),
        },
        metric_coverage: {
          source_rows: bucket.source_rows,
          roas_matched_rows: bucket.roas_matched_rows,
          roas_row_rate: round(
            safeRatio(bucket.roas_matched_rows, bucket.source_rows),
            6,
          ),
          roas_gmv_coverage_rate: round(
            safeRatio(bucket.roas_gmv, bucket.gmv),
            6,
          ),
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
        ad_cost_product_count: 0,
        roas_gmv: 0,
        roas_ad_cost: 0,
        source_rows: 0,
        roas_matched_rows: 0,
      };
    bucket.product_count += 1;
    bucket.shop_ids.add(product.shop_id);
    bucket.gmv += product.metrics.gmv;
    if (product.metrics.ad_cost !== null) {
      bucket.ad_cost += product.metrics.ad_cost;
      bucket.ad_cost_product_count += 1;
    }
    bucket.roas_gmv += product.audit.ratio_basis.roas_gmv ?? 0;
    bucket.roas_ad_cost += product.audit.ratio_basis.roas_ad_cost ?? 0;
    bucket.source_rows += product.metric_coverage.source_rows;
    bucket.roas_matched_rows += product.metric_coverage.roas_matched_rows;
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
        ad_cost:
          bucket.ad_cost_product_count === 0 ? null : round(bucket.ad_cost, 6),
        roas: round(safeRatio(bucket.roas_gmv, bucket.roas_ad_cost), 4),
      },
      metric_coverage: {
        source_rows: bucket.source_rows,
        roas_matched_rows: bucket.roas_matched_rows,
        roas_row_rate: round(
          safeRatio(bucket.roas_matched_rows, bucket.source_rows),
          6,
        ),
        roas_gmv_coverage_rate: round(
          safeRatio(bucket.roas_gmv, bucket.gmv),
          6,
        ),
      },
    }))
    .sort((left, right) =>
      left.shop_operation_country.localeCompare(right.shop_operation_country),
    );
}

function buildAnalysisPool(products) {
  const grouped = new Map();
  for (const product of products) {
    const key = `${product.shop_operation_country}\u001f${product.product_id}`;
    const bucket =
      grouped.get(key) ??
      {
        shop_operation_country: product.shop_operation_country,
        product_id: product.product_id,
        product_names: [],
        categories: [],
        source_shops: [],
        gmv: 0,
        ad_cost: 0,
        ad_cost_product_count: 0,
        roas_gmv: 0,
        roas_ad_cost: 0,
        source_rows: 0,
        roas_matched_rows: 0,
      };
    bucket.product_names.push(...product.product_name_aliases);
    bucket.categories.push(...product.industry_l3_aliases);
    bucket.source_shops.push({
      shop_id: product.shop_id,
      shop_name: product.shop_name,
      shop_name_aliases: product.shop_name_aliases,
      gmv: product.metrics.gmv,
    });
    bucket.gmv += product.metrics.gmv;
    if (product.metrics.ad_cost !== null) {
      bucket.ad_cost += product.metrics.ad_cost;
      bucket.ad_cost_product_count += 1;
    }
    bucket.roas_gmv += product.audit.ratio_basis.roas_gmv ?? 0;
    bucket.roas_ad_cost += product.audit.ratio_basis.roas_ad_cost ?? 0;
    bucket.source_rows += product.metric_coverage.source_rows;
    bucket.roas_matched_rows += product.metric_coverage.roas_matched_rows;
    grouped.set(key, bucket);
  }

  const rows = [...grouped.values()].map((bucket) => {
    const sourceShops = bucket.source_shops
      .sort(
        (left, right) =>
          right.gmv - left.gmv || left.shop_id.localeCompare(right.shop_id),
      )
      .map((shop) => {
        const share = safeRatio(shop.gmv, bucket.gmv);
        return {
          ...shop,
          product_gmv_share: round(share, 6),
          candidate_shop_existing_gmv_share: round(share, 6),
          outside_shop_gmv_share:
            share === null ? null : round(1 - share, 6),
          outside_this_shop_gmv_share:
            share === null ? null : round(1 - share, 6),
        };
      });
    const names = rankAliases(bucket.product_names);
    const categories = rankAliases(bucket.categories);
    const largestShop = sourceShops[0] ?? null;
    return {
      shop_operation_country: bucket.shop_operation_country,
      product_id: bucket.product_id,
      product_name: names[0] ?? null,
      product_name_aliases: names,
      industry_l3: categories[0] ?? null,
      industry_l3_aliases: categories,
      source_shop_count: sourceShops.length,
      cross_shop: sourceShops.length > 1,
      source_shops: sourceShops,
      shop_distribution: {
        largest_shop_id: largestShop?.shop_id ?? null,
        largest_shop_name: largestShop?.shop_name ?? null,
        largest_shop_gmv_share: largestShop?.product_gmv_share ?? null,
        outside_largest_shop_gmv_share:
          largestShop?.outside_this_shop_gmv_share ?? null,
      },
      metrics: {
        gmv: round(bucket.gmv, 6),
        ad_cost:
          bucket.ad_cost_product_count === 0 ? null : round(bucket.ad_cost, 6),
        roas: round(safeRatio(bucket.roas_gmv, bucket.roas_ad_cost), 4),
      },
      metric_coverage: {
        source_rows: bucket.source_rows,
        roas_matched_rows: bucket.roas_matched_rows,
        roas_row_rate: round(
          safeRatio(bucket.roas_matched_rows, bucket.source_rows),
          6,
        ),
        roas_gmv_coverage_rate: round(
          safeRatio(bucket.roas_gmv, bucket.gmv),
          6,
        ),
      },
    };
  });

  const rowsByCountry = new Map();
  for (const row of rows) {
    const bucket = rowsByCountry.get(row.shop_operation_country) ?? [];
    bucket.push(row);
    rowsByCountry.set(row.shop_operation_country, bucket);
  }

  const countries = [...rowsByCountry.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([country, countryRows]) => {
      countryRows.sort(
        (left, right) =>
          right.metrics.gmv - left.metrics.gmv ||
          left.product_id.localeCompare(right.product_id),
      );
      const ranked = countryRows.map((row, index) => ({ rank: index + 1, ...row }));
      const top100 = ranked.slice(0, 100);
      const countryGmv = ranked.reduce((sum, row) => sum + row.metrics.gmv, 0);
      const top100Gmv = top100.reduce((sum, row) => sum + row.metrics.gmv, 0);
      const namedCount = top100.filter((row) => row.product_name).length;
      const understandableCount = top100.filter(
        (row) => row.product_name || row.industry_l3,
      ).length;
      const crossShopCount = top100.filter((row) => row.cross_shop).length;
      const top100Categories = new Set(
        top100.map((row) => row.industry_l3).filter(Boolean),
      ).size;
      const top100GmvCoverage = round(safeRatio(top100Gmv, countryGmv), 6);
      const expansionReasons = [];
      if (ranked.length > 100 && (top100GmvCoverage ?? 0) < 0.85) {
        expansionReasons.push("top100_gmv_coverage_below_85pct");
      }
      if (
        ranked.length > 100 &&
        understandableCount < Math.min(60, Math.ceil(top100.length * 0.7))
      ) {
        expansionReasons.push("top100_semantic_coverage_insufficient");
      }
      if (
        ranked.length > 100 &&
        namedCount < Math.min(50, Math.ceil(top100.length * 0.6))
      ) {
        expansionReasons.push("top100_named_candidates_insufficient");
      }
      if (ranked.length > 100 && top100Categories < 3) {
        const top200Categories = new Set(
          ranked
            .slice(0, 200)
            .map((row) => row.industry_l3)
            .filter(Boolean),
        ).size;
        if (top200Categories > top100Categories) {
          expansionReasons.push("additional_category_breadth_in_top200");
        }
      }
      const recommendedLimit =
        expansionReasons.length > 0
          ? Math.min(200, ranked.length)
          : Math.min(100, ranked.length);
      return {
        shop_operation_country: country,
        total_unique_products: ranked.length,
        total_gmv: round(countryGmv, 6),
        selection: {
          default_limit: 100,
          analysis_limit: recommendedLimit,
          recommended_limit: recommendedLimit,
          expansion_required: recommendedLimit > 100,
          expansion_reasons: expansionReasons,
          top100_gmv_coverage_rate: top100GmvCoverage,
          top100_named_count: namedCount,
          top100_named_rate: round(safeRatio(namedCount, top100.length), 6),
          top100_understandable_count: understandableCount,
          top100_understandable_rate: round(
            safeRatio(understandableCount, top100.length),
            6,
          ),
          top100_cross_shop_product_count: crossShopCount,
          top100_industry_l3_count: top100Categories,
        },
        top_100: top100,
        // Keep the extension available in the compact artifact so the AI can
        // expand after a semantic/theme review without loading the full audit.
        // It should still read this section only when the first 100 are not
        // sufficient for stable themes.
        extension_101_200: ranked.slice(100, Math.min(200, ranked.length)),
      };
    });
  return {
    grain: "shop_operation_country × product_id",
    ranking_metric: "payment_1d GMV from ID-level source",
    cross_country_ranking: "not_computed",
    usage:
      "先读取各国 top_100；当 selection.expansion_required=true，或 AI 审阅后仍不足以形成稳定主题时，再读取 extension_101_200。",
    migration_value_fields:
      "source_shops 与 outside_this_shop_gmv_share 用于计算候选承接店已有/店外 GMV 占比，识别精修型或重组型方案。",
    countries,
  };
}

function buildOutput(validation, idDataPath, nameDataPath, metadata) {
  const products = aggregateProducts(
    validation.analysisIdRows,
    validation.analysisNameRows,
  );
  const shops = summarizeShops(products);
  const countrySummary = summarizeCountries(products, metadata.currency);
  const analysisPool = buildAnalysisPool(products);
  const productAliasConflicts = products.filter(
    (product) => product.product_name_aliases.length > 1,
  ).length;
  const shopAliasConflicts = shops.filter((shop) => shop.shop_name_aliases.length > 1).length;

  return {
    schema_version: "1.2",
    generated_at: new Date().toISOString(),
    periods: { report: validation.reportWindow },
    policy: {
      metric_source: "ID 数据",
      name_source: "名字对照数据，仅作别名和商品语义理解",
      aggregation_grain: "shop_operation_country × shop_id × product_id",
      id_type: "string",
      ratio_rule:
        "比率只使用所需分子与分母同时有效的同行数据；空值不按 0。ROAS=matched GMV / matched cost。",
      currency_or_unit: metadata.currency,
      cross_country_total: "not_computed",
      total_scope_warning:
        "所有合计只按国家展示且仅代表输入商品清单，不代表客户大盘；不得据此推断客户整体 GMV。",
    },
    context: {
      merchant: metadata.merchant,
      merchant_role: "display_label_only",
      shop_identity: "shop_id",
      source_value_policy: "keep_as_reported; never rewrite internal metrics",
    },
    sources: {
      id_data_file: path.basename(idDataPath),
      name_data_file: path.basename(nameDataPath),
      id_sheet: validation.idTable.sheetName,
      name_sheet: validation.nameTable.sheetName,
    },
    audit: {
      input_id_rows: validation.idTable.rows.length,
      input_name_rows: validation.nameTable.rows.length,
      analysis_ready_id_rows: validation.analysisIdRows.length,
      isolated_id_rows: validation.isolatedIdRows,
      isolated_name_rows: validation.isolatedNameRows,
      output_product_rows: products.length,
      output_shop_rows: shops.length,
      coverage: validation.coverage,
      product_alias_conflict_count: productAliasConflicts,
      shop_alias_conflict_count: shopAliasConflicts,
      hard_blockers: validation.hard_blockers,
      auto_handled: validation.auto_handled,
      notices: validation.notices,
    },
    country_summary: countrySummary,
    shop_summary: shops,
    analysis_pool: analysisPool,
    product_rows: products,
  };
}

function compactAnalysisOutput(output) {
  return {
    schema_version: output.schema_version,
    generated_at: output.generated_at,
    periods: output.periods,
    policy: {
      metric_source: output.policy.metric_source,
      name_source: output.policy.name_source,
      ratio_rule: output.policy.ratio_rule,
      currency_or_unit: output.policy.currency_or_unit,
      cross_country_total: output.policy.cross_country_total,
    },
    context: output.context,
    sources: output.sources,
    input_audit: {
      input_id_rows: output.audit.input_id_rows,
      analysis_ready_id_rows: output.audit.analysis_ready_id_rows,
      isolated_id_row_count: output.audit.isolated_id_rows.length,
      coverage: output.audit.coverage,
      auto_handled: output.audit.auto_handled,
      notices: output.audit.notices,
    },
    country_summary: output.country_summary,
    shop_summary: output.shop_summary.map((shop) => ({
      shop_operation_country: shop.shop_operation_country,
      shop_id: shop.shop_id,
      shop_name: shop.shop_name,
      shop_name_aliases: shop.shop_name_aliases,
      product_count: shop.product_count,
      industry_l3: shop.industry_l3,
      metrics: shop.metrics,
      metric_coverage: shop.metric_coverage,
      top_products: shop.top_products,
    })),
    analysis_pool: output.analysis_pool,
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
  if (!validation.analysis_ready) {
    for (const error of validation.hard_blockers) {
      process.stderr.write(`ERROR: ${error}\n`);
    }
    for (const message of validation.auto_handled) {
      process.stderr.write(`AUTO: ${message}\n`);
    }
    for (const message of validation.notices) {
      process.stderr.write(`NOTICE: ${message}\n`);
    }
    process.exit(1);
  }
  const output = buildOutput(
    validation,
    dataPaths.idDataPath,
    dataPaths.nameDataPath,
    {
      merchant:
        args.merchant && args.merchant !== true
          ? String(args.merchant)
          : "未提供客户/集团标签",
      currency:
        args.currency && args.currency !== true
          ? String(args.currency)
          : "内部报表原口径",
    },
  );
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  const messages = [];
  if (args.output && args.output !== true) {
    const target = path.resolve(args.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serialized, "utf8");
    messages.push(`审计底表：${target}`);
  }
  if (args["analysis-output"] && args["analysis-output"] !== true) {
    const target = path.resolve(args["analysis-output"]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `${JSON.stringify(compactAnalysisOutput(output), null, 2)}\n`,
      "utf8",
    );
    messages.push(`精简分析池：${target}`);
  }
  if (messages.length > 0) {
    process.stdout.write(
      `PASS\n${messages.join("\n")}\n${output.product_rows.length} 个店铺商品聚合行；${output.shop_summary.length} 个店铺。\n`,
    );
  } else {
    process.stdout.write(serialized);
  }
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exit(1);
}
