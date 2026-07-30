#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const taxonomy = JSON.parse(
  fs.readFileSync(path.join(moduleDirectory, "filter-taxonomy.json"), "utf8"),
);

function readArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`参数 --${name} 缺少值。`);
    }
    values[name] = value.trim();
    index += 1;
  }
  return values;
}

function cssString(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\A ")}"`;
}

function normalizeCountry(input) {
  const alias = taxonomy.country_aliases[input];
  const normalized = alias || input.toUpperCase();
  const supported = new Set([
    ...taxonomy.countries.top_level,
    ...taxonomy.countries.sea_children,
  ]);
  if (!supported.has(normalized)) {
    throw new Error(`不支持的国家：${input}`);
  }
  return normalized;
}

function normalizeCategory(input) {
  const alias = taxonomy.category_aliases[input.toLowerCase()];
  const normalized = alias || input;
  if (!taxonomy.level_1_categories.includes(normalized)) {
    throw new Error(`不是当前 taxonomy 中的精确一级类目：${input}`);
  }
  return normalized;
}

function main() {
  const arguments_ = readArguments(process.argv.slice(2));
  if (!arguments_.country || !arguments_.category) {
    throw new Error(
      "Usage: node build-filter-plan.mjs --country <COUNTRY> --category <精确一级类目>",
    );
  }

  const country = normalizeCountry(arguments_.country);
  const category = normalizeCategory(arguments_.category);
  const directUrl = new URL(taxonomy.source_page);
  directUrl.searchParams.set("region", country);

  const countryOption = [
    ".potoo-marketing-advisor-tree-select-dropdown",
    ":not(.potoo-marketing-advisor-select-dropdown-hidden)",
    " .potoo-marketing-advisor-select-tree-node-content-wrapper",
    `[title=${cssString(country)}]`,
  ].join("");
  const seaParentNode = [
    ".potoo-marketing-advisor-tree-select-dropdown",
    ":not(.potoo-marketing-advisor-select-dropdown-hidden)",
    " .potoo-marketing-advisor-select-tree-treenode",
    ":has(> .potoo-marketing-advisor-select-tree-node-content-wrapper[title=\"SEA\"])",
  ].join("");
  const visibleCategoryDropdown =
    ".potoo-marketing-advisor-cascader-dropdown:not(.potoo-marketing-advisor-select-dropdown-hidden)";
  const levelOneMenu = [
    visibleCategoryDropdown,
    " .potoo-marketing-advisor-cascader-menus",
    " > .potoo-marketing-advisor-cascader-menu:first-of-type",
  ].join("");
  const categoryRow = [
    levelOneMenu,
    " li[role=\"menuitemcheckbox\"]",
    `[title=${cssString(category)}]`,
  ].join("");

  const plan = {
    schema_version: "1.0.0",
    generated_from: "gcrm-core/filter-taxonomy.json",
    verified_ui_snapshot: "2026-07-30",
    page_url: taxonomy.source_page,
    country,
    category,
    manual_selection_required: false,
    country_selection: {
      preferred_path: "direct_url",
      direct_url: directUrl.toString(),
      direct_url_ordering:
        "Navigate to the country URL before setting category and dates because changing region resets those filters. Re-read the visible country after navigation.",
      trigger_selector: ".potoo-marketing-advisor-tree-select",
      visible_dropdown_selector:
        ".potoo-marketing-advisor-tree-select-dropdown:not(.potoo-marketing-advisor-select-dropdown-hidden)",
      option_selector: countryOption,
      is_sea_child: taxonomy.countries.sea_children.includes(country),
      sea_parent_node_selector: seaParentNode,
      sea_expand_selector: `${seaParentNode} > .potoo-marketing-advisor-select-tree-switcher`,
      collapsed_sea_recovery:
        "If the target SEA child option count is 0, click sea_expand_selector, take a fresh full snapshot, then locate option_selector again.",
      selected_value_selector:
        ".potoo-marketing-advisor-tree-select .potoo-marketing-advisor-select-selection-item",
      virtualized_option_strategy:
        "Use the DOM locator so the browser scrolls the dropdown automatically. If unavailable, scroll inside the visible tree-select dropdown, never the page body.",
    },
    category_selection: {
      root_selector: ".potoo-marketing-advisor-cascader",
      trigger_selector:
        ".potoo-marketing-advisor-cascader > .potoo-marketing-advisor-select-selector",
      open_strategy:
        "Click trigger_selector, not the whole root. Clicking the root center can hit the clear control when a category is already selected.",
      visible_dropdown_selector: visibleCategoryDropdown,
      level_one_menu_selector: levelOneMenu,
      checked_level_one_selector: `${levelOneMenu} li[role="menuitemcheckbox"][aria-checked="true"]`,
      target_row_selector: categoryRow,
      target_checked_selector: `${categoryRow}[aria-checked="true"]`,
      target_checkbox_selector: `${categoryRow} .potoo-marketing-advisor-cascader-checkbox`,
      target_checkbox_fallback_selector:
        `.potoo-marketing-advisor-cascader-dropdown:not(.potoo-marketing-advisor-select-dropdown-hidden) li[role="menuitemcheckbox"][title=${cssString(category)}] .potoo-marketing-advisor-cascader-checkbox`,
      fallback_guard:
        "Use target_checkbox_fallback_selector only when the strict selector count is 0 and the fallback count is exactly 1. Never use the broad fallback to clear other checked rows.",
      selected_value_selector:
        ".potoo-marketing-advisor-cascader .potoo-marketing-advisor-select-selection-item-content",
      selection_strategy:
        "Clear checked level-1 rows whose title differs from the target, re-read the popup DOM, then click the target checkbox only when the target row is not already aria-checked=true.",
      offscreen_strategy:
        "Click the target checkbox with a DOM locator; it auto-scrolls inside the category popup. Only if that fails, scroll inside the category menu rather than the page body.",
      accessible_name_warning:
        `The row accessible name may be "${category} right"; do not require an exact accessible name of only "${category}".`,
      row_click_warning:
        "Clicking the row text only expands the next category level. Click the checkbox child to select the level-1 category.",
      single_category_verification:
        `The selected text must be exactly "${category}" and the overflow marker must be +0, not +1 or higher.`,
    },
    completion_checks: [
      `Visible country equals ${country}.`,
      `Visible level-1 category equals ${category} and no second level-1 category remains selected.`,
      "The exact requested start and end dates are visible.",
      "Click 保存, wait for loading to finish, then re-read the visible filters and numeric result rows.",
    ],
    failure_policy: {
      attempted_paths_order: [
        "direct_url_then_verify",
        "tree_select_expand_sea_if_needed",
        "dom_locator_auto_scroll",
        "popup_scoped_visual_scroll",
        "same_authenticated_session_xhr_or_api",
      ],
      user_may_be_asked_only_for: ["browser_permission", "login"],
      never_ask_user_for:
        "Repeated manual country/category switching for each boutique-store theme.",
    },
  };

  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
