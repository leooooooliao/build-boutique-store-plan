# GCRM 本地浏览器采集 Runbook

本模块只负责精品店方案所需的最小营销参谋证据，不生成独立的 GCRM Excel 报告。使用本地、已登录的浏览器会话；不要改用云端浏览器，也不要让“找不到另一个 Skill”成为跳过查询的理由。

- Aime：点击输入框下方【拓展】，开启真实扩展名【Aime Chrome】。
- Mira 或其他 AI：开启其“操作当前本地浏览器/Chrome”能力，并确认使用当前已登录会话，不走云端浏览器授权。

`get_tabs` 只表示已经发现浏览器标签页，不表示已经完成筛选。取得 GCRM 标签页后必须继续执行下面的 DOM/视觉操作，不能停下来让用户逐组手选。

### Aime 的固定动作顺序

Aime Chrome 已验证支持 `get_tabs`、`snapshot`、`click(selector)`、`scroll`、`get(selector)` 和 `eval`；`select` 只用于原生 `<select>`，不要拿它操作本页自定义控件。

1. `get_tabs` 取得 GCRM `tab_id`，先打开目标国家 direct URL。切换 `region` 会重置类目和日期，所以国家必须先设置。
2. 做一次新的完整 `snapshot`，用 `category_selection.trigger_selector` 打开 Category；不要点击整个 Category 根节点，已选中类目时根节点点击可能命中清空控件。
3. **浮层展开后再做一次新的完整 `snapshot`。** Cascader 浮层挂在 portal 中，不要继续使用展开前的旧 ref，也不要只截旧 Category 节点的子树。
4. 用 `click` 的 CSS `selector` 参数点击 `target_checkbox_selector`。Aime 会把精确目标滚入可见区域；不要改用页面滚轮。
5. 用 `get(selector)` 或 `eval` 回读目标行 `aria-checked`、已选类目文本和 `+0` 状态；不满足就继续修复，不能声称筛选完成。

Aime CLI 可直接按下面的骨架执行；`<...>` 必须替换为当前 tab 和 `build-filter-plan.mjs` 的真实输出：

```bash
aime-browser get_tabs --response_mode=verbose
aime-browser navigate --tab_id=<TAB_ID> --url='<DIRECT_URL>' --new_tab=false
aime-browser snapshot --tab_id=<TAB_ID> --interactive=true --compact=true
aime-browser click --tab_id=<TAB_ID> --selector='<CATEGORY_TRIGGER_SELECTOR>'
aime-browser snapshot --tab_id=<TAB_ID> --interactive=true --compact=false --depth=12
aime-browser click --tab_id=<TAB_ID> --selector='<TARGET_CHECKBOX_SELECTOR>'
aime-browser get --tab_id=<TAB_ID> --content_type=text --selector='<SELECTED_VALUE_SELECTOR>'
```

若目标已经是 `aria-checked="true"`，跳过目标 checkbox 的点击。Aime 的 `select` 仅用于原生 `<select>`，不能用来操作本页 TreeSelect/Cascader。

## 状态机

按顺序记录 `browser.state`：

1. `not_checked`
2. `permission_needed`
3. `browser_ready`
4. `page_ready`
5. `filters_verified`
6. `evidence_collected`
7. `evidence_validated`

以下状态都不是完整交付：

- `auth_required`
- `capability_blocked`
- `filter_failed`
- `user_skipped`
- `unavailable`

只有 `evidence_collected` 或 `evidence_validated` 才能进入证据校验。最终的 `verified` / `verified_no_candidate` 必须由 `validate-evidence.mjs` 推导，不能由模型自行声明。

## 已验证的国家与类目自动选择协议

GCRM 的 Country 是自定义 tree-select，Category 是自定义多选 cascader，不是原生 `<select>`。可访问树可能只显示当前值；这不等于控件不可操作。

每个国家 × 一级类目组合先运行：

```bash
node dependencies/gcrm-core/build-filter-plan.mjs \
  --country "<COUNTRY>" \
  --category "<精确一级类目>"
```

宿主从其他工作目录运行时，使用 `<SKILL_ROOT>` 绝对路径。执行返回的精确 selector 和完成检查，不自行猜控件名称。

### Country

1. 优先打开 `country_selection.direct_url`，通过 `region=<COUNTRY>` 直接设置国家，避免重复操作国家下拉框。该路径已实测可从 MY 切换到 ID，但会重置类目和日期；因此必须先切国家，再设置类目和日期。
2. 回读页面可见 Country；只有显示值与目标国家一致才算成功。
3. URL 路径不可用时，打开 `.potoo-marketing-advisor-tree-select`，只在可见的 tree-select 浮层内查找 `option_selector`。
4. MY / ID / TH / VN / PH / SG 是 SEA 子国家。`option_selector` 数量为 0 时，先点击 `sea_expand_selector` 展开 SEA，重新做完整 snapshot，再查一次目标子国家；SEA 默认折叠不等于目标国家不存在。
5. SEA 子国家或虚拟列表中的选项未出现在当前视口时，优先用 DOM locator 点击，让浏览器在浮层内自动滚动；视觉兜底也必须把滚轮落在浮层内部，不能滚页面主体。

### Category

1. 用 `category_selection.trigger_selector`（`.potoo-marketing-advisor-cascader > .potoo-marketing-advisor-select-selector`）打开类目框；不要直接点击整个 `.potoo-marketing-advisor-cascader` 根节点，已选中类目时可能误触清空控件。
2. 展开后重新读取 DOM。一级类目行是 `li[role="menuitemcheckbox"][title="<CATEGORY>"]`；其可访问名称可能是“`<CATEGORY> right`”，不要用只含类目名的 exact accessible-name 查询判断失败。
3. **选择一级类目必须点击该行内的 `.potoo-marketing-advisor-cascader-checkbox`。** 点击行文字只会展开二级菜单，不等于选中一级类目。
4. 只保留目标一级类目：在第一列一级类目菜单中取消 `title` 不等于目标类目的其他 `aria-checked="true"` checkbox，然后重新读取浮层 DOM。目标行已经是 `aria-checked="true"` 时不要再点；只有未选中时才点击目标 checkbox，避免把正确筛选反向取消。
5. 目标类目在屏幕下方时，直接点击 `target_checkbox_selector`；DOM locator 会自动在类目浮层内滚到目标。严格 selector 数量为 0 时，只可在 `target_checkbox_fallback_selector` 恰好命中 1 个节点时使用它；清理其他已选项仍必须限定第一列。只有 DOM 路径失败时，才在类目浮层内部定点滚动。不得因“滚轮滑不动”让用户手选。
6. 回读选中值：文本必须等于目标一级类目，且溢出标记是 `+0`；出现 `+1` 或更高表示仍有多个一级类目。

### 保存与核验

国家、类目和日期都设置后点击【保存】，等待 loading 消失或数字排名行出现，再回读 Country、Category、起止日期和结果行。不能把“点击成功”当作“筛选成功”。

若页面改版导致 selector 失效，按以下顺序恢复：

1. 新 DOM 快照并检查自定义 tree-select/cascader；
2. 使用截图定位控件，并在浮层内部点击/滚动；
3. 使用同一已登录会话的 XHR/API；
4. 记录 `browser.attempted_paths`。

只有上述自动路径都失败后才能标记 `filter_failed` / `partial`。仍然不得把每个国家、类目的切换交给用户；唯一允许请求的人工动作是一次性的浏览器授权或登录。

## 采集顺序

1. 按上面的宿主路径启用本地浏览器控制，确认当前浏览器已登录 GCRM。
2. 打开 Top Product 页面，逐项设置国家、精确起止日期和一级类目；页面支持时设置二级类目。
3. 每次切换筛选后等待加载状态消失，再核对页面上实际显示的筛选值。不要把“点击了”当作“筛选成功”。
4. 优先从同一登录态页面的 XHR/API 或 DOM 批量读取；其次使用页面导出；最后读取可见表格。
5. 自定义下拉框必须先运行 `build-filter-plan.mjs` 并按上面的已验证协议操作；不要只寻找原生 `select` / `listbox`。
6. 若下拉框仍失败，按 `DOM → 键盘/视觉 → 同登录态 XHR/API → 页面导出` 恢复，每条路径都重新核对页面筛选状态。不得把国家或类目的逐组手动切换交给用户；唯一可请求的人工动作是一次性的浏览器授权或登录。所有恢复路径失败时记录为 `partial`，不能用用户代操作换取完整状态。
7. 为每次查询记录 `query_id`、对应精品店的 `theme_rank` 与 `theme_name`、国家、类目、周期、筛选后 URL、采集时间、实际读取行数、采集方式，以及截图/DOM 快照/导出文件中的至少一种证据引用。
8. 用 `product_id` 关联候选与查询，同时让候选的 `theme_rank`、`theme_name` 与所属查询完全一致；标题和店铺名不能代替 ID 对齐。
9. 写出 `gcrm-evidence.json` 后运行：

   `node dependencies/gcrm-core/validate-evidence.mjs --evidence gcrm-evidence.json --gcrm-window YYYY-MM-DD..YYYY-MM-DD --expected-themes <实际方案数>`

## 恢复与停止条件

- 授权未开：只请求一次本地浏览器权限，随后重试。
- 登录失效：请用户在本地浏览器登录，随后从页面就绪状态继续。
- 某种控件失败：切换到下一种采集路径，不把控件失败写成“营销参谋无数据”，也不请用户逐组切筛选。
- 所有安全路径均失败：写入真实失败状态和已尝试路径，只能产出“部分草稿”；不得生成完整报告。
- `verified_no_candidate` 不是失败兜底。它要求真实完成筛选、读取并记录行数，同时说明为什么读取到的商品均未成为候选。
