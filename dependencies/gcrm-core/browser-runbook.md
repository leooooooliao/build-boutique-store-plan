# GCRM 本地浏览器采集 Runbook

本模块只负责精品店方案所需的最小营销参谋证据，不生成独立的 GCRM Excel 报告。使用本地、已登录的浏览器会话；不要改用云端浏览器，也不要让“找不到另一个 Skill”成为跳过查询的理由。

- Amy：点击输入框下方【拓展】，开启真实扩展名【Aime Chrome】。
- Mira 或其他 AI：开启其“操作当前本地浏览器/Chrome”能力，并确认使用当前已登录会话，不走云端浏览器授权。

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

## 采集顺序

1. 按上面的宿主路径启用本地浏览器控制，确认当前浏览器已登录 GCRM。
2. 打开 Top Product 页面，逐项设置国家、精确起止日期和一级类目；页面支持时设置二级类目。
3. 每次切换筛选后等待加载状态消失，再核对页面上实际显示的筛选值。不要把“点击了”当作“筛选成功”。
4. 优先从同一登录态页面的 XHR/API 或 DOM 批量读取；其次使用页面导出；最后读取可见表格。
5. 自定义下拉框先点击可访问的筛选触发器或当前值，等待可见的 `listbox`/浮层，再按 `filter-taxonomy.json` 或页面原文选择精确文本；选完必须核对显示值已改变并等待加载结束。
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
