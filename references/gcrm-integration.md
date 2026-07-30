# 营销参谋接入

营销参谋只用于为已选主题找补品/新品和内容渠道证据，不用于计算客户整体大盘。完整精品店方案必须实际查询营销参谋；安装了其他 Skill、找不到其他 Skill、下拉框操作失败或暂时没有浏览器权限，都不能替代查询证据。

## 唯一完成标准

使用内置的 `dependencies/gcrm-core/`。它包含最小筛选 taxonomy、本地浏览器状态机、采集 Runbook、`gcrm-evidence.json` schema 和验证器，不依赖另一个 Skill 才能工作。

1. 先读 `dependencies/gcrm-core/browser-runbook.md`，使用本地已登录浏览器完成筛选和采集。
2. 每个国家 × 一级类目组合先运行：

   `node dependencies/gcrm-core/build-filter-plan.mjs --country "<COUNTRY>" --category "<精确一级类目>"`

   按输出的 direct URL 和 selector 操作 Country tree-select 与 Category cascader。类目不在当前视口时用 DOM locator 自动滚入浮层，不让用户滚轮查找或逐组手选。
3. 按 `dependencies/gcrm-core/evidence.schema.json` 写出结构化证据。
4. 运行：

   `node dependencies/gcrm-core/validate-evidence.mjs --evidence gcrm-evidence.json --gcrm-window YYYY-MM-DD..YYYY-MM-DD --expected-themes <实际方案数>`

5. 状态只能由验证器推导：
   - `verified`：真实查询全部成功，且至少有一个完整候选；
   - `verified_no_candidate`：真实查询全部成功，有筛选条件、读取行数和查询证据，但没有合格候选；
   - `partial`：未执行、授权失败、能力不足、筛选失败、用户跳过或证据不完整。
6. `partial` 只能产出明确标注的“部分草稿”，不得作为完整报告交付。

若宿主也安装了 `build-gcrm-hot-product-report`，可复用其浏览器操作经验；不得把是否发现该 Skill 当作营销参谋是否可执行的判断条件。

## 查询输入

- 与承接店相同的国家；
- 已确认的营销参谋起止日期；
- 与主题最接近的当前 GCRM 一级类目，并在页面支持时进一步选择二级类目；
- 一级/二级类目状态按页面原文记录。页面不支持二级筛选时写明 `not_supported`，不能声称已完成二级筛选。

营销参谋 Top Product 页面：

`https://mmm.tiktok-row.net/gcrm_overseas/phoenix/marketing-advisor/product-insights/top-product`

## 查询顺序

1. 先完成客户货盘的 Top 3 主题，不为所有客户类目预抓榜单。
2. 每个主题至少真实完成一次查询，只查最接近、能解释结构性缺口的类目；查询和候选都用 `theme_rank`、`theme_name` 绑定到对应精品店方案。
3. 优先读取 GMV Top 50；飙升榜仅在确有有效数据时作为补充。无需为了“数量完整”扩到 Top 100。
4. 优先用页面 API/XHR 或导出获得全表和图片 URL；无法获得时再读取可见表格。
5. 导出与页面值只按 `product_id` 确认关联。标题 + 店铺只能作为待核对候选，必须标注不确定。
6. 不要求逐个打开 TikTok 商品详情页；页面源链接、商品 ID、榜单证据和图片已足够支撑补品建议。

每次查询还必须保留：

- 唯一 `query_id`
- 对应方案的 `theme_rank` 与 `theme_name`
- 国家、一级类目、二级类目及其筛选状态
- 与报告一致的精确起止日期
- 筛选后的 GCRM URL
- 含时区的采集时间
- 实际读取行数
- `xhr`、`dom`、`export` 或 `visible_table` 采集方式
- 截图、DOM 快照或导出文件中的至少一种证据引用

下拉框或页面控件失败时，先运行 `build-filter-plan.mjs`，再按 `direct URL/DOM locator 自动滚动 → 浮层内视觉滚动 → 同登录态 XHR/API → 页面导出` 恢复。页面主体滚轮无效不代表类目浮层不可操作；不得要求用户逐个国家、逐个类目手动切换。只允许为浏览器授权或登录请求一次明确动作。恢复路径全部失败时只能标为 `partial`。

## 补品选择

- 只补主题当前缺失的场景、功能或内容表达；不为了填满表格设定固定数量。
- 建议必须同时满足：类目/场景匹配、榜单证据可追溯、与现有货盘不明显重复、商家有合理开品可能。
- 每个补品保留：
  - 对应方案的 `theme_rank` 与 `theme_name`
  - `product_id`
  - 营销参谋榜单显示的原店铺名（`Shop Name`）
  - 原标题与简洁中文名
  - 国家、一级/二级类目筛选状态
  - 与报告一致的精确周期
  - GMV 区间
  - 增长率或明确的“暂无可靠涨幅”
  - 至少一个真实渠道 GMV 区间；有直播与短视频数据时分别保留
  - 图片 URL 或页面截图
  - 已筛选页面链接
  - 含时区的采集时间
- 原店铺名是定位原榜单商品的必填字段。按页面原样保留，不自行翻译或改写；缺失时把候选标为“待定位”，不能作为完整补品推荐。
- 增长超过 300% 时提示“可能受低基数、活动或短期爆发影响”，不得仅凭涨幅下结论。
- 页面区间保持原样；若用区间中点估算渠道占比，明确标注估算且不要求占比之和等于 100%。

## 图片与链接

- 优先保存原始图片 URL，并在飞书文档中同时放图片和可点击源链接。
- 没有稳定图片 URL 时，可截取带商品卡片及当前筛选条件的页面截图。
- 图片下方注明 `国家｜类目｜营销参谋周期｜product_id`，避免离开上下文后误用。
- 不把内部导出文件、客户数据或登录态 URL 参数发布到公共仓库。

## 无登录或能力不足时的处理

若无法访问已认证页面：

1. 不绕过登录、不编造榜单、不拿公开电商榜单冒充营销参谋。
2. 记录真实 `browser.state` 和已尝试路径；授权、控件、能力或登录问题均推导为 `partial`。
3. 可以继续完成客户货盘重组和 Top 3 的部分草稿，将补品区标为“待完成营销参谋验证”。
4. 在草稿结论中明确：补品、市场 GMV、涨幅和渠道证据尚未验证，不能作为完整建议。
5. 恢复本地浏览器后继续采集并重新运行验证器。不得使用模型手选的 `unavailable`、`blocked` 或 `no-candidate` 绕过这一步。

`verified_no_candidate` 仅表示“真实查询后没有合格候选”，不是访问失败的同义词。它必须逐次展示国家、类目、周期、筛选 URL、采集时间、实际读取行数、查询证据引用和未入选原因。

公开 Skill 只包含流程与内部入口，不授予任何内部系统权限。使用者必须通过其组织账号和既有权限访问。
