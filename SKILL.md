---
name: build-boutique-store-plan
description: Turn one merchant's complete multi-shop SKU portfolio into a stable Top 3 boutique-store plan, then verify structural assortment gaps with GCRM Marketing Advisor evidence. Use when a user asks to 把跑品商家的爆品集中到精品大店、重组多个 Shop ID 下的货盘、判断哪些好货适合放在一起、给现有店升级建议、补充同主题新品、判断达人/短视频/直播方向，或要求从两份商家 SKU 导出生成可交付的飞书精品店方案。
---

# 精品大店规划

把同一客户分散在多个 Shop ID 下、已经验证过的好货，重组为主题清晰的精品大店；营销参谋只用于验证结构性缺口和补品，不用于倒推客户整体大盘。

本 Skill 的策略单元是“商品原型 × 使用场景 × 店铺主题”，不是单个 Product ID。Product ID 是数据校准和证据锚点。

## 1. 先走输入闸门

在读取数据或给出任何策略前，先读 `references/interaction.md` 和 `references/data-contract.md`。

先把包含本文件的目录解析为 `<SKILL_ROOT>`。所有脚本都从该目录运行，或使用脚本的绝对路径；不得假设当前工作目录就是 Skill 目录。

优先使用 Node.js 18+ 运行随包脚本。宿主无 Node 时，立即读 `references/agent-compatibility.md`，用等价数据工具复现合同，并明确未运行随包脚本。

如果用户没有同时提供两份完整数据和两个明确周期，逐字输出 `references/interaction.md` 中的首次交互；只列缺失项，然后停止正式分析。不得先看一部分数据“试着做”，不得自行猜商家、国家或日期。

两份数据缺一不可：

1. ID 层级主数据：<https://mmm.tiktok-row.net/apps/analytics/biportal/report/edit/1324598>
2. 名称对照数据：<https://mmm.tiktok-row.net/apps/analytics/biportal/report/edit/1324606>

两个链接均仅限有权限的登录用户访问。Skill 公开不代表获得内部系统权限。

强制确认：

- 两个报表都已把“商家”筛选改成用户实际要分析的同一商家。
- 两份客户数据覆盖同一商家、同一准确起止日，且包含完整表头和全量行。
- 用户给出客户货盘准确周期和营销参谋准确周期；“近 30 天”也必须解析为具体起止日。
- Shop ID、Product ID 保持文本；出现科学计数法、小数或末位被改成 0 时停止并要求重拉。
- 跨国数据保留国家和币种；不同币种不得直接横加。

若宿主能读取 XLSX，直接读取两个独立工作表。若只收到粘贴表格，分别保存为 UTF-8 TSV/CSV；不要要求用户做宿主本来可以完成的转换。

运行输入校验：

```bash
node "<SKILL_ROOT>/scripts/validate_input.mjs" \
  --id-data "<01_ID主数据.csv|tsv>" \
  --name-data "<02_名称对照.csv|tsv>" \
  --merchant "<商家名称>" \
  --currency "<USD|各国本币分国展示|其他明确口径>" \
  --confirm-same-merchant yes \
  --confirm-same-period yes \
  --merchant-window "YYYY-MM-DD..YYYY-MM-DD" \
  --gcrm-window "YYYY-MM-DD..YYYY-MM-DD" \
  --json
```

只有校验结果为 `ok: true`，且同商家/同客户周期确认均为 `yes` 才能继续。先向用户回执两表行数、国家、金额口径、ID 格式、两个周期、重复数、匹配率、命名 GMV 覆盖率和未匹配 ID 数。名称覆盖不足时标为“语义覆盖不完整”，只用有名称的已验证强品形成主题，不假装理解全部商品。

## 2. 固定数据事实层

运行：

```bash
node "<SKILL_ROOT>/scripts/prepare_portfolio.mjs" \
  --id-data "<01_ID主数据.csv|tsv>" \
  --name-data "<02_名称对照.csv|tsv>" \
  --merchant "<商家名称>" \
  --currency "<已确认金额口径>" \
  --confirm-same-merchant yes \
  --confirm-same-period yes \
  --merchant-window "YYYY-MM-DD..YYYY-MM-DD" \
  --gcrm-window "YYYY-MM-DD..YYYY-MM-DD" \
  --output "<任务输出目录>/portfolio-audit.json"
```

严格遵守：

- ID 主数据是唯一数值事实源。按 `国家 × shop_id × product_id` 聚合。
- GMV、成本、销量等可加指标求和；ROAS、占比、转化率等比率必须用分子/分母重算，不得平均。
- 名称对照表只建立商品名和店名别名字典，绝不参与 GMV 加总。
- Product ID 对应多个商品名、Shop ID 对应多个店名时，以 ID 校准；展示一个最完整的非空名称并保留别名。没有时间戳时不得称其为“最新名称”。
- 不得用 Top 商品加总推客户整体大盘、市场份额或新店 GMV 预测。
- 跨国候选分别计算，禁止把不同币种 GMV 直接相加。
- 消耗低于 0.01 的极高 ROAS 只能标为“低消耗方向性信号”，不得据此判定强品。

任何关键列缺失、ID 精度异常、两表周期不一致或匹配率异常时，停止并给出可操作的重拉建议。

## 3. 从好货组合出 Top 3 主题店

读 `references/analysis-rules.md`。

先把标题归纳为商品原型，再按使用场景和内容叙事形成候选主题。默认给出三个优先级不同的精品店方案；若证据不足以支持三个，明确说明为什么更少，禁止为了凑数跨主题硬拼。

每个候选必须：

- 只属于一个国家和币种。
- 选择一个现有 Shop ID 作为承接店，优先升级现有店，不建议无必要新开空店。
- 至少有一组已验证核心货盘，并能解释为什么这些商品适合在同一主题下销售。
- 同时审计已验证强度、跨店分散度、承接店纯度、主题一致性、内容可演示性和执行风险。
- 计算核心货盘 GMV、加权 ROAS、承接店外 GMV 占比、来源 Shop ID 数，并保留明细以便审计。

商品组合建议只回答：

- 哪些商品原型适合放在一起。
- 哪些同质变体存在重叠，需要商家合并评估。
- 哪些商品会让主题漂移，应排除或后置。
- 哪些结构性场景仍缺货。

不要规定必须只留几个主推款、几个尺寸、哪个具体尺寸或固定 SKU 角色。最终数量、规格、价带和套装由商家结合库存、毛利、供应链、履约、售后和内容表现评估。没有充分数据时，也不要强行划分“引流款/利润款/形象款”。

## 4. 营销参谋只验证补品

确定 Top 3 主题后再读 `references/gcrm-integration.md`。不要在主题形成前遍历营销参谋。

若环境已安装 `$build-gcrm-hot-product-report`，调用它复用榜单提取、Product ID 对齐、区间保留和图片规则；本 Skill 负责限定国家、类目、周期和店铺主题。若不可调用，按 `references/gcrm-integration.md` 的工具中立流程执行。

对每个主题：

1. 只查询该国家下最贴近主题的一级/二级类目，使用页面当前原始标签。
2. 先看 GMV Top 50；只有有效候选不足时才扩 Top 100 或飙升榜。
3. 只补“主题内真实缺口”，通常保留少量高证据候选；没有合格候选时明确不补，不设数量配额。
4. 保留 Product ID、营销参谋原店铺名、商品图/截图、平台类目、GMV 区间、涨幅、Live/Video/Card 区间和筛选页 URL。原店铺名用于让商家回到榜单定位原品。
5. 涨幅超过 300% 时标记“低基数/促销风险”，不得直接称为持续趋势。
6. 只凭标题相似不能确认同品；Product ID 不同只能称商品原型候选。

客户周期与营销参谋周期不一致时，只能把客户数据用于货盘重组、营销参谋用于补品验证；不得直接比较绝对 GMV、推市场份额或预测增量。

## 5. 给内容渠道建议

根据营销参谋渠道结构、商品可演示性、客单和决策成本判断：

- 需要持续演示、答疑或高客单的设备，可偏直播承接。
- 前后对比强、低理解门槛、低客单的商品，可偏短视频和达人铺量。
- 证据混合时给组合打法，不强行二选一。

把“达人/短视频/直播”写成内容与成交建议，不写成无数据支撑的 SKU 角色。区分平台事实与分析推断；推断必须标注“判断”或“推测”。

## 6. 按固定结构交付

读 `references/output-contract.md`、`references/quality-gates.md` 和 `references/agent-compatibility.md`。使用 `assets/report-template.md` 作为结构骨架，不把占位符原样交付。

有飞书文档能力时，创建一份可编辑飞书文档，并：

- 首屏写完整“全文数据窗口”：客户货盘起止日/天数、营销参谋起止日/天数、生成日、国家和币种口径。
- 用一个总表给出 Top 3 精品店优先级。
- 每店展示承接 Shop ID、核心货盘、来源店、组合/去重建议、渠道打法、营销参谋补品和执行风险。
- 营销参谋候选同时放商品图或截图、Product ID、营销参谋原店铺名、区间指标和可点击筛选页 URL。
- 末尾写数据边界：核心货盘 GMV 不等于客户整体大盘，也不是新店预测。
- 创建后回读一次，核对标题、两个时间窗口、表格、图片和链接。

没有飞书能力时，输出同结构 Markdown 或宿主可编辑文档，并明确“未创建在线飞书文档”。没有登录浏览器或营销参谋权限时，要求用户补导出；不得假装已实时查询。

## 7. 强制报告 QA

将最终 Markdown、HTML 或导出的纯文本保存为文件后运行：

```bash
node "<SKILL_ROOT>/scripts/validate_report.mjs" \
  --report "<report.md|html|xml|txt>" \
  --merchant-window "YYYY-MM-DD..YYYY-MM-DD" \
  --gcrm-window "YYYY-MM-DD..YYYY-MM-DD" \
  --generated-date "YYYY-MM-DD" \
  --gcrm-mode "<verified|no-candidate|unavailable>" \
  --expected-gcrm-products "<实际补品数量>" \
  --expected-top "<实际方案数，默认 3>"
```

交付前必须通过：

- 两个准确时间窗口和生成日均出现。
- Top 3 有优先级、主题、承接 Shop ID 和核心指标；不足三个时有明确证据说明。
- 每个营销参谋补品有 Product ID、营销参谋原店铺名、区间指标、图片/截图和来源 URL；无补品时写明原因。
- 不出现“只留 1 个主推款”“固定几个尺寸”等硬性数量建议。
- GCRM 页面国家、日期和原始类目已核验。
- 飞书文档已回读；图片和链接数量与计划一致。

QA 失败先修正文档，再交付。

## 8. 固定项与 AI 判断边界

固定执行：首次交互、双源事实层、ID 聚合、比率重算、双时间窗口、Top 3 输出结构、GCRM 证据字段、飞书回读和报告 QA。

允许 AI 判断：商品原型提炼、主题命名、互补/重叠关系、承接店选择、跨店迁移风险、内容渠道叙事和最终文案。所有判断必须能回到 Product ID、Shop ID 或营销参谋证据。

## 9. 节省时间但不降质

- 先定 Top 3，再查对应国家 × 类目；不遍历全市场。
- 默认只查最贴近主题的类目和 GMV Top 50；证据不足再扩。
- 默认使用榜单缩略图/截图和筛选页链接，不逐个抓商品详情页。
- 不制作中间汇报 Excel；Excel 仅作输入载体，最终只交付一份文档。
- 补品不设配额，无有效候选即停止扩展。
- 用脚本处理清洗、聚合和 QA；把 AI 时间留给主题与组合判断。

## 10. 数据和权限边界

不得把客户原始数据、真实 Product ID / Shop ID、Cookie、Token 或内部账号信息写入公开 Skill、公开仓库或 Release。任务所需的内部 BI 和 GCRM 入口可以保留；链接本身不授予权限，仍只对已获授权的登录用户有效。
