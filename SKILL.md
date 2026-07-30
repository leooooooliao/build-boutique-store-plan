---
name: build-boutique-store-plan
description: Turn one merchant or group’s complete multi-shop SKU portfolio into a Top 3 boutique-store plan, then verify structural assortment gaps with GCRM Marketing Advisor evidence. Use when a user asks to 把跑品商家的爆品集中到精品大店、重组多个 Shop ID 下的货盘、判断哪些好货适合放在一起、升级现有店、补充同主题新品、规划达人/短视频/直播方向，或从双源 SKU 数据生成可交付的飞书精品店建议。
---

# 精品大店规划

把同一客户分散在多个 Shop ID 下、已经验证过的好货，重组为主题清晰的精品大店。先用客户货盘形成主题，再用营销参谋验证结构性缺口和补品；不要用营销参谋倒推客户整体大盘。

始终遵守两条原则：

1. **内部报表输出什么，就按什么分析。** 不纠正、不改写、不拿外部数据覆盖。
2. **营销参谋是完整报告必经阶段。** 任意 AI 都必须实际提出并执行，不能静默跳过。

## 1. 先完成首次交互

先解析包含本文件的目录为 `<SKILL_ROOT>`，再完整读取：

- `references/interaction.md`
- `references/data-contract.md`

第一条回复必须先做浏览器预检：

- Aime 用户：点击输入框下方【拓展】→ 开启【Aime Chrome】；“Aime Chrome”就是开关实际名称。
- Mira 或其他 AI：按当前宿主真实界面给出一个具体动作，开启可操作当前已登录浏览器的能力；不知道按钮名称时不要编造。
- 使用本地已登录浏览器，不使用云端浏览器授权。

然后要求用户提供：

- ID 层级数据和名称对照数据。推荐上传一个含两个 Sheet 的 Excel；也可在对话中分两段粘贴完整表格并标注来源；
- 客户/集团名称，仅用于报告标题；
- 客户货盘准确起止日；
- 营销参谋准确起止日。

两个报表都必须先把“商家”切换为同一目标客户：

1. ID 层级数据：<https://mmm.tiktok-row.net/apps/analytics/biportal/report/edit/1324598>
2. 名称对照数据：<https://mmm.tiktok-row.net/apps/analytics/biportal/report/edit/1324606>

不要要求用户补 L3、cost、名称、国家或其他空值；不要要求用户清洗或修改源数据。国家从表内识别，金额沿用内部报表原口径。客户/集团名称和具体 `shop_name` 不同属于正常情况。
客户/集团名称缺失时使用“目标客户”作临时标题继续，不把它当作经营分析阻断项。

## 2. 只阻断真正不可分析的问题

优先运行 Node.js 18+ 随包脚本。一个 XLSX 两个 Sheet 时：

```bash
node "<SKILL_ROOT>/scripts/validate_input.mjs" \
  --workbook "<客户货盘.xlsx>" \
  --merchant "<客户或集团名称>" \
  --merchant-window "YYYY-MM-DD..YYYY-MM-DD" \
  --gcrm-window "YYYY-MM-DD..YYYY-MM-DD" \
  --json
```

收到两段粘贴数据或两个文本表格时，先由 AI 保存为带完整表头的临时文件，再使用：

```bash
node "<SKILL_ROOT>/scripts/validate_input.mjs" \
  --id-data "<ID层级.csv|tsv>" \
  --name-data "<名称对照.csv|tsv>" \
  --merchant "<客户或集团名称>" \
  --merchant-window "YYYY-MM-DD..YYYY-MM-DD" \
  --gcrm-window "YYYY-MM-DD..YYYY-MM-DD" \
  --json
```

只有 `hard_blockers` 才向用户追问：

- 文件无法读取、为空或无法识别两张来源表；
- 隔离少量损坏行后，核心 Product ID / Shop ID 仍整体不可用；
- ID 层级表完全没有可用商品—店铺记录；
- 缺少且无法确认准确时间窗口。

`auto_handled` 和 `notices` 直接记录后继续。空 L3、空 cost、空名称、空国家、多名称、部分国家缺失、集团名与店名不同和极端值均不阻断。一次列全真正阻断项，不发 A/B/C 选择题。

宿主没有 Node 时，读取 `references/agent-compatibility.md`，用等价工具复现数据合同；不得声称运行了随包脚本。

## 3. 建立不可改写的事实层

运行：

```bash
node "<SKILL_ROOT>/scripts/prepare_portfolio.mjs" \
  --workbook "<客户货盘.xlsx>" \
  --merchant "<客户或集团名称>" \
  --merchant-window "YYYY-MM-DD..YYYY-MM-DD" \
  --gcrm-window "YYYY-MM-DD..YYYY-MM-DD" \
  --output "<任务输出目录>/portfolio-audit.json" \
  --analysis-output "<任务输出目录>/analysis-pool.json"
```

若输入为两段粘贴表格，先保存为临时数据文件，再改用 `--id-data` 和 `--name-data`。

严格遵守：

- ID 层级数据是唯一经营数值事实源，按 `国家或 UNKNOWN × shop_id × product_id` 聚合。
- `payment_1d` 等经营字段按内部报表原口径使用，不校正、不换算。
- 名称表只建立商品名和店名别名字典，不参与 GMV、cost 或广告指标加总。
- Product ID / Shop ID 校准实体；集团名只用于标题，`shop_name` 是具体店铺名。
- 空数值不按 0，只排除在对应指标之外；保留指标覆盖率。
- GMV 使用全部有效 GMV；ROAS 只用 GMV 与 cost 同时有效的记录重算。
- L3 为空时按名称判断商品原型，保留推断标记，不覆盖源字段。
- 国家缺失时只在同 Shop ID 唯一对应一个国家时推断，否则保留 UNKNOWN。
- 默认分国展示，不做没有源数据依据的跨国金额横加或排名。
- 不用 Top 商品加总推客户整体大盘、市场份额或新店 GMV。

`portfolio-audit.json` 保留全量聚合与明细用于审计；AI 先读取较小的 `analysis-pool.json`，不要先把全量 Product ID 放进上下文。精简候选池按 `payment_1d` 排序，并按 `country × product_id` 跨 Shop 汇总，同时保留来源 Shop 明细。默认先审阅 Top 100；当主题不足、名称覆盖不足或 GMV 过于分散时自动扩到 Top 200，不向用户确认，也不把 100/200 写成商家必须采用的商品数量。

向用户回执只需说明：读取成功、两表行数、识别国家、ID 状态、两个周期和自动处理摘要。不要把每个空值变成确认题。

## 4. 组合 Top 3 精品店主题

读取 `references/analysis-rules.md` 和 `references/plan-evidence.md`。

先把商品标题归纳为商品原型，再按用户、场景和内容叙事组合主题。默认给出三个优先级不同的方案；证据不足时给真实数量并说明原因，不跨主题硬凑。

每个候选：

- 只属于一个已识别国家；UNKNOWN 商品不得悄悄并入某国。
- 优先选择一个现有 Shop ID 升级，不无必要新开空店。
- 使用一组已验证核心货盘，并解释商品为什么适合放在一起。
- 审计货盘强度、跨店分散度、承接店纯度、主题一致性、内容可演示性和执行风险。
- 计算候选核心 GMV、可计算范围内的 ROAS、承接店外 GMV 占比和来源 Shop ID 数。
- 判断方案是“重组型”还是“精修型”。若超过一半的核心候选 GMV，或大部分商品原型本来就在承接店，默认降低优先级；除非其主题纯度、经营强度或落地可行性明显更优，否则优先选择能把其他店铺好货真正集中起来的方案。

只给主题、候选商品、互补/重叠和排除建议。不要规定最终主推款数量、SKU 数、尺寸、规格或固定“引流款/利润款/形象款”角色。

写出并验证方案排序证据：

```bash
node "<SKILL_ROOT>/scripts/validate_plan_evidence.mjs" \
  --evidence "<plan-evidence.json>" \
  --merchant-window "YYYY-MM-DD..YYYY-MM-DD" \
  --expected-plans "<实际方案数，默认 3>"
```

让程序核算重组型/精修型及默认排序；不要只靠正文标签自行判断。精修型不被机械淘汰；若排在某个重组型之前，必须按 `references/plan-evidence.md` 提供主题纯度、经营强度或落地可行性的结构化例外理由。

## 5. 强制完成营销参谋

Top 3 主题确定后，读取 `references/gcrm-integration.md` 和 `references/agent-compatibility.md`。

有 `$build-gcrm-hot-product-report` 时复用其提取和图片规则；没有时直接按本 Skill 的工具中立流程查询。安装另一个 Skill 不是浏览器授权，也不是跳过查询的理由。

对每个主题：

1. 使用该主题的国家、准确周期和最贴近的一级/二级类目。
2. 实际打开营销参谋并核验页面筛选状态，等待加载完成。
3. 先看 GMV Top 50；有效候选不足时再扩 Top 100 或飙升榜。
4. 只补主题内真实缺口，不设数量配额。
5. 保存 Product ID、原始标题、中文短名、原 Shop Name、类目、GMV/涨幅/渠道区间、商品图或截图、筛选页 URL 和含时区的采集时间。
6. 把补品证据与对应图片、店铺和来源逐一绑定。

每个实际方案都必须至少有一次成功查询；在查询和补品证据中写入对应的 `theme_rank`、`theme_name`。不能用一个主题的营销参谋结果替另外两个主题过关。

浏览器未授权或未登录时，只向用户提出一个当前动作，完成后重试。页面控件失败时依次尝试 DOM、键盘/视觉操作和同登录态页面请求；不得要求用户为每个国家、类目逐组手切。所有安全路径失败时写入 `partial`。

完整报告只接受由证据文件推导出的：

- `verified`：已获取并核验候选；
- `verified_no_candidate`：已真实查询指定国家、类目和周期；逐次保留含时区采集时间、实际读取行数和证据引用，但无合格候选。

浏览器不可用、登录失败、页面操作失败或找不到另一个 Skill 都是 `partial`，不是“无候选”。用户若决定暂时停止，只能交付醒目标注的“精品店方案部分草稿｜营销参谋待完成”，不能称为完整精品店方案。

客户周期与营销参谋周期不一致时，分别用于货盘重组和补品验证，不直接比较绝对 GMV。

## 6. 给内容渠道建议

根据营销参谋渠道结构、商品可演示性、客单和决策成本判断：

- 持续演示、答疑或高客单设备可偏直播承接。
- 前后对比强、理解门槛低的商品可偏短视频和达人铺量。
- 证据混合时给组合打法，不强行二选一。

把渠道写成内容和成交建议，不写成无数据支撑的 SKU 角色。事实与判断分开，推断标注为“判断”。

## 7. 交付一份好看且可审计的文档

读取：

- `references/output-contract.md`
- `references/quality-gates.md`
- `assets/report-template.md`

优先创建可编辑飞书文档；不能写飞书时使用 Markdown、HTML 或宿主原生文档。

固定的是信息和证据，不是逐字模板。保留这些视觉特征：

- 首屏结论和 Top 3 总表；
- 清晰层级与适量留白；
- 商品图靠近对应营销参谋证据；
- 表格、图片与可点击 URL 互相对应；
- 一种克制的重点色和可快速扫描的卡片/提示块。

允许 Aime、Mira 或其他宿主采用最自然的组件，不机械复刻 Sample。创建飞书文档后回读，核验标题、两个时间窗口、表格、图片和链接。

## 8. 报告 QA

保存最终文档的可校验文本后运行：

```bash
node "<SKILL_ROOT>/scripts/validate_report.mjs" \
  --report "<report.md|html|xml|txt>" \
  --merchant-window "YYYY-MM-DD..YYYY-MM-DD" \
  --gcrm-window "YYYY-MM-DD..YYYY-MM-DD" \
  --generated-date "YYYY-MM-DD" \
  --plan-evidence "<plan-evidence.json>" \
  --gcrm-evidence "<gcrm-evidence.json>" \
  --expected-top "<实际方案数，默认 3>"
```

不要让模型手填营销参谋状态或方案类型。校验器必须从 `gcrm-evidence.json` 推导 `verified`、`verified_no_candidate` 或 `partial`，并从 `plan-evidence.json` 核算重组型/精修型和排序；只有营销参谋前两种状态且方案证据通过时，完整报告 QA 才能通过。

交付前确认：

- 两个准确窗口、生成日和识别国家已出现。
- Top 3 有优先级、主题、承接 Shop ID 和候选范围指标。
- 每个方案的店内/店外 GMV、商品原型、重组/精修分类和排序理由已通过结构化方案证据校验。
- 每个补品都有 Product ID、原始标题、中文短名、原 Shop Name、区间指标、图片、URL 和含时区采集时间。
- 无候选结论逐次展示实际查询范围、含时区采集时间、读取行数和证据引用。
- 没有固定主推数量、尺寸或规格建议。
- 数据说明覆盖自动推断、可选指标覆盖率和未出现国家。
- 飞书文档已回读，图片与链接一一对应。

QA 失败先修正文档再交付；营销参谋未完成时不得通过完整报告 QA。

## 9. 时间优化

- 先定 Top 3，再查对应国家 × 类目，不遍历全市场。
- 默认查最贴近主题的类目和 GMV Top 50，证据不足再扩。
- 使用榜单缩略图/截图和筛选页链接，不逐个抓商品详情页。
- 不制作中间汇报 Excel；Excel 只作输入，最终交付一份文档。
- 把确定性清洗和 QA 交给脚本，把 AI 时间留给主题与组合判断。

## 10. 权限边界

不绕过登录或权限，不索要账号密码、Cookie 或 Token。不把客户数据、真实 Product ID / Shop ID、内部截图或任务报告写入公开 Skill、公开仓库或 Release。
