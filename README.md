# 精品大店规划 Skill

[![Release ZIP downloads](https://img.shields.io/github/downloads/leooooooliao/build-boutique-store-plan/total?label=Release%20ZIP%20downloads&style=flat-square)](https://github.com/leooooooliao/build-boutique-store-plan/releases)
[![README views](https://hits.sh/github.com/leooooooliao/build-boutique-store-plan.svg?label=README%20views&style=flat-square)](https://github.com/leooooooliao/build-boutique-store-plan)
[![Registered installs](https://img.shields.io/github/issues-search?query=repo%3Aleooooooliao%2Fbuild-boutique-store-plan%20is%3Aissue%20label%3Ainstalled&label=registered%20installs&style=flat-square)](https://github.com/leooooooliao/build-boutique-store-plan/issues?q=is%3Aissue+label%3Ainstalled)

把同一商家分散在多个店铺里的已验证好品，重组为主题清晰的精品大店，并用营销参谋验证补品与内容渠道。

[下载最新版本](https://github.com/leooooooliao/build-boutique-store-plan/releases/latest)｜[可选：登记一次成功安装](https://github.com/leooooooliao/build-boutique-store-plan/issues/new?template=install-registration.yml)

## 给任意 AI 的安装提示词

复制下面整段给你正在使用的 AI：

```text
请帮我下载、安装并启用“精品大店规划”Skill。

最新发布页：
https://github.com/leooooooliao/build-boutique-store-plan/releases/latest

请严格执行：
1. 打开最新 Release，下载其中名为 build-boutique-store-plan-v*.zip 的 Skill 压缩包。
2. 解压后完整保留 build-boutique-store-plan 文件夹及内部目录，不要只复制 SKILL.md。
3. 如果当前 AI 支持 Skills/Agent Skills，请安装到它能识别的 Skill 目录并重新加载；如果没有原生 Skill 功能，就把根目录 SKILL.md 作为入口，并按相对路径读取它引用的文件。
4. 至少读取并验证 SKILL.md、references/interaction.md、references/data-contract.md 都存在且可访问。
5. 安装完成后，不要立刻分析商家。先向我返回：
   - 是否安装成功
   - Skill 名称
   - 安装位置或加载方式
   - 已验证的入口文件
   - 一段可直接复制的“第一次使用提示词”
6. 如果你不能联网、下载、解压、写文件或持久安装，请明确说明限制，给我最短的手动操作步骤，并让我上传 ZIP；不得假装安装成功。
7. 只有在我确认安装成功后，且你具备 GitHub 写入能力时，才可以询问我是否自愿登记一次安装；不要重复登记。
```

## 第一次使用提示词

安装成功后，复制这一段：

```text
请使用 build-boutique-store-plan，为【商家名称】做精品大店规划。
先不要分析，请严格按 Skill 的首次交互，只告诉我需要准备的两份数据、两个准确时间窗口和金额/币种口径。
```

AI 的第一条回复应当先给出两个内部拉数入口，并用醒目方式提醒：两个报表都必须把“商家”改成当前要分析的同一商家。随后再收集：

1. ID 层级数据：经营指标的唯一计算口径。
2. 名称对照数据：只用于理解商品与店铺名称。
3. 客户货盘准确起止日。
4. 营销参谋准确起止日。
5. 覆盖国家与金额/币种口径。

两份数据缺一不可。表格不要截图，`Shop ID` 和 `Product ID` 必须保持为文本，不能变成科学计数法。

## 不同 AI 怎么处理

| AI 能力 | 使用方式 |
|---|---|
| 支持本地 Skills | 安装完整文件夹，重新加载后使用 Skill 名称触发 |
| 能下载和读取文件，但没有 Skills 功能 | 保留完整目录，以 `SKILL.md` 为入口按相对路径执行 |
| 只有聊天和上传能力 | 用户手动下载 ZIP 并上传；该 AI 可能只在当前对话内有效 |
| 无法访问内部页面 | 仍可完成客户货盘重组，但必须把营销参谋补品标为未验证 |

## 指标口径

- `Release ZIP downloads`：GitHub 正式 Release 附件的累计下载事件，不是独立用户数或安装人数。
- `README views`：README 徽章被请求的页面计数，可能包含刷新、机器人或重复访问，不是 GitHub 独立访客数。
- `registered installs`：使用者自愿提交的安装登记数量，不代表全部实际安装。
- GitHub 官方仓库 Traffic 只向有写入权限的人展示最近 14 天访客数据，因此不把它伪装成公开累计浏览量。

公开 Skill 保留工作所需的内部入口，但链接本身不授予访问权限。任何 AI 都不得绕过组织登录或既有权限。
