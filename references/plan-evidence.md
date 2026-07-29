# 方案重组价值证据

Top 3 主题和承接店确定后，写出 `plan-evidence.json`。它只保存方案计算与排序证据，不替代面向商家的文档。

## 结构

```json
{
  "schema_version": "1.0.0",
  "window": {
    "start": "YYYY-MM-DD",
    "end": "YYYY-MM-DD"
  },
  "plans": [
    {
      "rank": 1,
      "theme_name": "主题名",
      "country": "MY",
      "target_shop_id": "Shop ID",
      "target_shop_name": "店铺名",
      "candidate_gmv": 1000,
      "target_shop_existing_gmv": 200,
      "outside_shop_gmv": 800,
      "target_shop_existing_gmv_share": 0.2,
      "outside_shop_gmv_share": 0.8,
      "source_shop_count": 3,
      "archetype_count": 4,
      "archetypes_already_in_target_shop": 1,
      "existing_archetype_share": 0.25,
      "classification": "reorganization",
      "priority_reason": "店外 GMV 和跨店商品原型充足，具备真实集中价值",
      "ranking_override": null
    }
  ]
}
```

所有 GMV 只来自同一客户货盘周期的 ID 层级事实数据：

- `candidate_gmv = target_shop_existing_gmv + outside_shop_gmv`
- `target_shop_existing_gmv_share = target_shop_existing_gmv / candidate_gmv`
- `outside_shop_gmv_share = outside_shop_gmv / candidate_gmv`
- `existing_archetype_share = archetypes_already_in_target_shop / archetype_count`

## 类型与排序

- 店内已有 GMV 占比 `> 0.5`，或店外 GMV 占比 `< 0.5`，分类必须为 `refinement`。
- 已在承接店的商品原型占比 `> 0.5`，分类必须为 `refinement`。
- 其他方案分类为 `reorganization`。
- 默认先排 `reorganization`，再排 `refinement`；精修型可以进入 Top 3，不机械淘汰。
- 精修型需要排在某个重组型之前时，填写：

```json
{
  "enabled": true,
  "reason_code": "theme_coherence",
  "explanation": "主题纯度显著更高，迁移与内容改造成本更低",
  "over_reorganization_ranks": [2]
}
```

`reason_code` 只允许：

- `theme_coherence`
- `operating_strength`
- `execution_feasibility`

不要用自由文本绕过分类；`explanation` 只解释为什么例外前置。

## 验证

```bash
node scripts/validate_plan_evidence.mjs \
  --evidence plan-evidence.json \
  --merchant-window "YYYY-MM-DD..YYYY-MM-DD" \
  --expected-plans 3
```

最终报告必须展示每个方案的类型、店内/店外 GMV 占比、来源店铺数和 `priority_reason`。报告 QA 会再次读取本证据，不依赖正文关键词自行判断类型。
