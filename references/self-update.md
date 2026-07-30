# 启动时版本同步

每个新任务第一次触发本 Skill 时检查一次；同一任务内不要因重新读取新版 `SKILL.md` 再次检查。

用户安装 `v1.3.0` 或更高版本即选择启用本机制。宿主若要求联网或写入审批，只清楚申请一次；用户拒绝或宿主不允许时保留当前版继续，不重复弹窗。

## 标准路径

运行：

```bash
node "<SKILL_ROOT>/scripts/sync_skill_release.mjs" --apply --json
```

更新器只接受固定仓库 `leooooooliao/build-boutique-store-plan` 的稳定 SemVer Release，以及精确命名的完整 ZIP。它先访问固定的 `/releases/latest`，只有发现新版并应用更新时才读取 Release API、下载 ZIP、核对 GitHub SHA-256、验证 Skill 身份与包结构并原子替换。符号链接、传错的 Skill 根目录和任何 Git checkout 内的目录都不会被整体替换。更新失败保留旧目录，不逐文件覆盖。

按状态处理：

- `up_to_date`：静默继续。
- `updated`：只告诉用户“已从 vX 更新到 vY，继续为你处理”，随后重新完整读取新版 `SKILL.md`；本任务不再检查。
- `check_unavailable`：一句话说明暂时无法检查，使用当前版继续；不反复请求联网权限。
- `update_failed`：保留旧版继续。若原因是官方仓库的 Git checkout，且工作区干净、远端确认为本页固定仓库，自动执行一次 fast-forward-only 更新并复核 `VERSION`；有本地修改时不得覆盖。若原因是只读目录或宿主无法持久安装，给出固定最新发布页，不把业务流程卡住。
- `update_available`：只会在检查模式出现；有写入能力时应立即改用 `--apply`，不要让普通用户自己比较版本号。

固定最新发布页：

<https://github.com/leooooooliao/build-boutique-store-plan/releases/latest>

Git checkout 仅在 `git status --short` 为空且 `origin` 精确指向固定官方仓库时执行：

```bash
git -C "<SKILL_ROOT>" pull --ff-only
```

命令失败或存在本地修改时保持原样继续，不 reset、不强制覆盖。

## 没有 Node 或不能持久安装

有等价下载和文件能力时，复现同一合同：

1. 打开固定最新发布页，只接受 `v数字.数字.数字` 的稳定版本。
2. 与 `<SKILL_ROOT>/VERSION` 做三段整数比较；禁止按字符串、发布时间或 `main` 分支判断。
3. 远端版本更高时，只下载精确附件 `build-boutique-store-plan-vX.Y.Z.zip`。
4. 完整解压并验证顶层目录、`VERSION`、`SKILL.md`、`README.md`、`agents/`、`scripts/`、`references/`、`assets/` 和 `dependencies/`。
5. 能持久安装时备份旧目录后整体替换；只能临时读文件时，本次从新版解压目录执行，并说明“本次使用新版，未持久安装”。
6. 更新成功后重新完整读取新版 `SKILL.md`，同一任务不再重复检查。

不得索要 GitHub Token，不得下载 Source code 自动压缩包，不得只替换 `SKILL.md`，不得把 GitHub 更新检查与 Aime Chrome 或营销参谋授权混为一谈。

## 首个自更新版本

`v1.2.0` 及更早版本没有更新器，无法自动发现新版。旧用户必须手动覆盖安装一次 `v1.3.0` 或更高版本；从此后每次新任务触发时才会自动检查。
