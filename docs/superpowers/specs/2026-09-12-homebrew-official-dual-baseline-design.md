# 进入 Homebrew 官方源（homebrew/cask）：双版本基线发布体系设计

- 日期：2026-09-12
- 状态：设计稿 v2（已吸收 owner 当日三项决策：①暂不申请 Apple 开发者账号 → 官方 cask 收录搁置，私有 tap 长期为 brew 唯一通道；②演进线自下一个版本首发（`v3.0.0-current.1`）；③官方 cask 由 owner 本人提交，条件成熟后启动——注意 notability 与公证是两个独立门槛，缺一不可，见 §1.5/§7）
- 范围：发布策略、CI（`.github/workflows/release.yml`）、应用内更新设置（Rust + React）、官方 cask 提交与维护
- 不在范围：私有 tap `GOODBOY008/homebrew-tap` 内部实现（另仓库，仅约束其接口）

---

## 1. 官方要求核实（已逐条对照 Homebrew 文档）

结论先行——**双基线并存是官方明确允许的**，真正的硬门槛是：公证签名、notability 自投门槛、以及「推荐通道」的界定。

### 1.1 收录通道：homebrew/cask（不是 core）

R-Shell 是开源 GUI 应用且有编译好的 dmg 分发 → 进 `homebrew/cask`（随 brew 内置，用户无需加 tap）。文档明确：开源 CLI / 无编译产物的 GUI 才归 homebrew/core；被 core 拒收也不自动获得 cask 资格。

### 1.2 版本与通道规则（双基线的合法性依据）

> "The unversioned cask normally tracks the upstream release channel recommended for most users. That channel is not necessarily the newest available release."

即：**官方 `r-shell` cask 跟踪"推荐给大多数用户"的通道，不必是最新版本**。其它通道可用 `@beta` / `@nightly` 等 token 单独立 cask；版本钉死的发布线只要上游仍在积极维护就有效。

对我们的含义：
- 稳定线（兼容基线）= 推荐通道 → 官方 cask 只跟踪它；
- 演进线（新基线）= 另一通道，可以留在私有 tap（`r-shell@current`）或仅走应用内更新 + 直接下载；
- **两条线必须同时维护**——官方 cask 一旦收录，稳定线停更超过合理周期会被社区质疑（"actively maintains" 是资格前提）。

### 1.3 系统与架构（Support Tiers，2026-09 现状）

| 架构 | Tier 1（受支持） | Tier 3（尽力而为） |
|---|---|---|
| Apple Silicon | macOS 27 / 26 / 15 | 11–14 |
| Intel | macOS 26 / 15 / 14 | 10.15–13（≤10.14 不支持） |

硬性要求：
- "A cask must work on every operating system and architecture it declares"——cask 声明双架构就必须双架构都能跑；
- "A cask that supports macOS must work on the latest major version of macOS"——**必须在 macOS 27 上可运行**（每个稳定版发布前要验证，见 §3.7）；
- macOS 27 起 Intel 不再有任何受支持系统；GitHub Intel runner 2027 年退役 → x86_64 构建保留在稳定线（Intel 用户 Tier 1 上限是 macOS 26），演进线不做 Intel。

基线取舍：稳定线**沿用 Tauri 默认最低系统（10.13），不设 `depends_on macos`**——不缩小现有用户面，cask 全系统可装；演进线最低 macOS 26（Tahoe）、仅 aarch64。"基线"的差别只体现在演进线的构建参数与测试范围上，稳定线零行为变化。

### 1.4 Gatekeeper / 公证（当前最大缺口）

> "Executable artefacts must pass Homebrew's Gatekeeper checks" 且不得要求关闭/绕过 Gatekeeper。

现状：`release.yml` 只有 updater 的 minisign 密钥（`TAURI_SIGNING_PRIVATE_KEY`，release.yml:76–77），**没有任何 Apple 签名/公证配置**。未公证的 dmg 在新 macOS 上会被 Gatekeeper 拦截 → 官方 cask 的前置阻塞项。

前置条件：Apple Developer Program（Developer ID Application 证书 + App Store Connect API key 或 Apple ID app-specific password）。tauri-action 原生支持，只需注入 secrets（见 §3.3）。

**决策（2026-09-12）：暂不申请 Apple Developer Program。** 后果：签名公证缺失 → 官方 cask 的 Gatekeeper 硬性要求无法满足 → **官方收录整条线搁置**（重启条件见 §7 P4）；私有 tap 继续作为 brew 渠道（现状不变）。§3.3 / §3.5 / §5 保留为条件重启时的实施说明。

### 1.5 Notability（决定性发现：owner 目前不能自投）

Package-Acceptance-Policy 的量化门槛（满足任一即可）：

| 路径 | forks | watchers | stars | r-shell 现状（2026-09-12） |
|---|---|---|---|---|
| 社区标准提交 | ≥30 | ≥30 | ≥75 | 33 ✓ / 2 ✗ / 142 ✓ → **达标** |
| **仓库 owner 自投** | ≥90 | ≥90 | ≥225 | 33 ✗ / 2 ✗ / 142 ✗ → **不达标** |

另：仓库须满 30 天（已满足）；数字以 canonical 仓库为准；达标只是最低线，维护者保留裁量权。

**决策（2026-09-12）：owner 选择自投路径，条件成熟再提交。** 自投的"条件合适"是两个**独立**门槛，缺一不可：

1. notability：225⭐ / 90 forks / 90 watchers 任一达标（现 142⭐ / 33 forks / 2 watchers，均未达）；
2. 签名公证：需要 Apple Developer Program（§1.4，owner 已决定暂不申请）。

即：**star 涨到 225 而账号未办，提交仍会被拒**——Gatekeeper 检查是收录审核的硬条件，与 star 数无关。§5 的 cask 草案保留，两个条件都齐备后直接可用。

### 1.6 `auto_updates`  stanza 的决策：不加，改为"应用内更新器对 Caskroom 安装自动禁用"

Cask Cookbook：仅当应用自带更新（菜单里有真正执行下载安装的 "Check for Updates…"）时声明 `auto_updates true`；若只是跳转网页则不声明。

而 brew 侧语义：声明了 `auto_updates` 的 cask **默认不被 `brew upgrade` 升级**（需 `--greedy`）。我们希望 brew 用户走 `brew upgrade --cask r-shell`，因此：

- 官方 cask **不含 `auto_updates`**；
- 应用内更新器检测到自身运行于 `/opt/homebrew/Caskroom/` 或 `/usr/local/Caskroom/`（可判定"自更新可被禁用"）时，禁用自动检查与下载安装，UI 引导用户执行 `brew upgrade`（§4）。

这同时**取代了此前"给私有 tap 加 `auto_updates true`"的方案**：既然 Caskroom 安装一律停用应用内更新，两条 tap 都应省略该 stanza，冲突从根上消失，且 `brew upgrade` 对两个 cask 都直接生效。

> 注意方向：不要反过来（声明 auto_updates + 让更新器在 Caskroom 内就地替换 .app）——Tauri 更新器整包替换 app bundle 会破坏 brew 的 receipt/sha256 追踪，是已知的"更新器 vs brew"冲突根因。

### 1.7 其他条款核对

- 可验证分发：官方 GitHub Releases ✓（要求"开发者发布或公开背书的下载源"）；
- 重复 cask："同一软件 + 同一发布 + 同一通道"才算重复——私有 tap 若继续存在必须换成不同通道（`r-shell@current`），同名同通道的 `r-shell` 需迁移退役（§3.6）；
- 试用/激活、fork 命名、多语言 cask 等条款不适用。

### 1.8 差距清单（现状 → 要求）

| # | 差距 | 影响 | 对应方案 |
|---|---|---|---|
| 1 | dmg 未签名公证 | cask 硬阻塞 | §3.3 |
| 2 | 更新器与 brew 安装互相不知情 | 冲突/版本错乱 | §4 |
| 3 | 单通道 `latest.json`，无基线/通道概念 | 无法双基线 | §3.4、§4 |
| 4 | owner 自投 notability 不达标（142/225⭐） | 提交人受限 | §7 阶段 2 |
| 5 | 私有 tap 存在同名 `r-shell` cask | 官方合并时的用户混淆（搁置期间不构成问题：私有 tap 是唯一 brew 通道） | §3.6 |
| 6 | 未在 macOS 27 上验证 | "must work on latest macOS" | §3.7 |
| 7 | CI 无按 tag 区分发布线的机制 | 双基线无法落地 | §3.1 |

---

## 2. 双基线模型

| | 稳定线（兼容基线） | 演进线（新基线） |
|---|---|---|
| 通道语义 | "推荐给大多数用户"（官方 cask 跟踪） | 尝鲜通道 |
| 版本示例 | `2.9.3`、`2.9.4`…（晋升后跳 `3.1.x`） | `3.0.0-current.1`、`3.0.0-current.2`… |
| Git tag | `v2.9.3` | `v3.0.0-current.3` |
| GitHub Release | 正式版（非 prerelease）→ `releases/latest` 永远指向本线 | **标记为 prerelease** → 不污染 `releases/latest` |
| 最低 macOS | 10.13（Tauri 默认，不变） | 26.0（Tahoe） |
| macOS 架构 | aarch64 + x86_64（两个 dmg，与现状一致） | 仅 aarch64 |
| Windows / Linux | 每个稳定版全平台出包 | 同样出包（跟演进线版本号） |
| 内容 | bugfix / 安全修复 / 无风险回移（cherry-pick） | 全部新功能 |
| 更新 manifest | `latest.json`（**URL 与现状完全不变**） | `current.json`（滚动 tag `current` 的 release 资产，§3.4） |
| Homebrew | 官方 `homebrew/cask/r-shell` + bump 自动化 | （可选）私有 tap `r-shell@current`，或仅应用内更新 |

**首发定档（2026-09-12 决策）：演进线自下一个版本启动，即 `v3.0.0-current.1`**（版本基数取 3.0.0，与稳定线 2.9.x 形成清晰分界）。stable 用户完全无感：`releases/latest` 仍指向 2.9.2，`latest.json` 不变，自动更新不受任何影响。演进线首批用户来自直接下载（GitHub prerelease 页面）；应用内通道切换随本版合入，此后 current 线更新走应用内。

关键机制：

1. **tag 后缀即通道**：`-current.N` 是合法 semver prerelease（`3.0.0-current.3 < 3.0.0`），GitHub 会把标记 prerelease 的演进版排除在 `releases/latest` 之外——所以现有的 `releases/latest/download/latest.json` 稳定通道 URL **零改动**继续可用。
2. **晋升（promotion）**：演进线每 4–6 周左右冻结一次，从该提交打稳定 tag（如 `v3.1.0`，去掉后缀、非 prerelease）全平台重新出包；稳定线版本号随之跳到 `3.1.x`。同一份代码、两个 tag，与 Chrome stable/beta 模型一致。
3. **双线同时存续是承诺不是过渡**：官方 cask 收录后，稳定线的维护节奏（安全修复回移时限，目标 ≤7 天）要写进发布流程文档。

---

## 3. CI 设计（`.github/workflows/release.yml` 改造）

### 3.1 触发与矩阵

tag 过滤改为 `v*`（含 `v*-current.*`），在 job 内按 tag 判定发布线：

```yaml
release:
  strategy:
    matrix:
      include:
        # —— 稳定线（tag 不含 -current.）——
        - { platform: macos-latest, args: --target aarch64-apple-darwin, baseline: compat }
        - { platform: macos-latest, args: --target x86_64-apple-darwin, baseline: compat }
        - { platform: ubuntu-latest, args: '', baseline: compat }
        - { platform: windows-latest, args: '', baseline: compat }
        # —— 演进线（tag 匹配 v*-current.*）——
        - { platform: macos-latest, args: --target aarch64-apple-darwin, baseline: current }
        - { platform: ubuntu-latest, args: '', baseline: current }
        - { platform: windows-latest, args: '', baseline: current }
```

每个 entry 顶部 `if: tagMatchesBaseline`（用一步 `jq`/`grep` 判定 tag 是否含 `-current.`，与 matrix 条目匹配；演进线新增的 mac 构建沿用 `macos-latest` runner）。

### 3.2 演进线的最低系统注入

tauri-action 的 `args` 里追加内联 config 覆盖（Tauri 2 支持 `--config <json>` 合并）：

```yaml
args: --target aarch64-apple-darwin --config '{"bundle":{"macOS":{"minimumSystemVersion":"26.0"}}}'
```

稳定线不传 → 保持默认 10.13。稳定线资产名（`r-shell_<v>_aarch64.dmg` / `_x64.dmg`）不变，保证官方 cask 的 URL 模板稳定。

### 3.3 签名与公证（已搁置——重启官方收录时实施）

> 状态：owner 2026-09-12 决定暂不申请 Apple Developer Program，本节整段挂起；内容保留，作为日后重启时的实施清单。演进线同样跳过签名公证，与稳定线产物形态保持一致。

新增 secrets（前置：Apple Developer Program），tauri-action 检测到以下 env 即自动签名 + 公证：

```
APPLE_CERTIFICATE            # p12（含 Developer ID Application）
APPLE_CERTIFICATE_PASSWORD
APPLE_SIGNING_IDENTITY       # "Developer ID Application: <Name> (TEAMID)"
APPLE_API_KEY / APPLE_API_ISSUER / APPLE_API_KEY_KEY   # App Store Connect API（推荐）或 APPLE_ID+APPLE_PASSWORD
```

同时保留现有 `TAURI_SIGNING_PRIVATE_KEY*`（updater 签名与 Gatekeeper 公证是两回事，互不替代）。演进线同样要公证（cask 之外，直接下载用户也受益）。

### 3.4 双 manifest

- **`latest.json`（稳定线，逻辑不变）**：现 job（release.yml:90–212）已在 alpha/beta tag 上跳过，把跳过条件扩展为「凡 `-current.` tag 跳过」即可，选取平台 `darwin-aarch64` / `darwin-x86_64` / `linux-x86_64` / `windows-x86_64`。
- **`current.json`（演进线，新 job `upload-current-json`）**：结构与 latest.json 相同，但：
  - `darwin-aarch64` 指向演进线 arm 构建（macOS 26+）；
  - 附着方式：**移动轻量 tag `current` 到本次 release**（`git tag -f current <tag> && git push -f origin current`），endpoint 固定为
    `https://github.com/GOODBOY008/r-shell/releases/download/current/current.json`
    ——GitHub 没有 "latest prerelease" URL，滚动 tag 是业界常用替代（neovim nightly 同款做法）；缺点是该 tag 永远是"可变引用"，文档中注明不应对 `v-current` 语义做任何假设。
  - `version` 字段写完整 `3.0.0-current.3`；tauri updater 的 semver 比较天然满足 `current.N` 递增可更新。

### 3.5 官方 cask 的 bump 自动化（随官方收录一并搁置）

> 状态：`OFFICIAL_CASK_MERGED` 长期保持 `false`（或干脆不创建该 job）；本节内容在 §7 P4 重启时实施。

仅在稳定线 tag、且仓库变量 `OFFICIAL_CASK_MERGED == 'true'` 时运行（cask 合并前置空跑会报错）：

```yaml
bump-official-cask:
  needs: generate-checksums
  if: startsWith(github.ref, 'refs/tags/v') && !contains(github.ref, '-current.')
        && vars.OFFICIAL_CASK_MERGED == 'true'
  runs-on: macos-latest
  steps:
    - run: brew install bumpctl   # 或使用 brew 内置 brew bump-cask-pr
    - run: brew bump-cask-pr --cask r-shell --version ${GITHUB_REF_NAME#v}
      env:
        HOMEBREW_GITHUB_API_TOKEN: ${{ secrets.HOMEBREW_CASK_PR_TOKEN }}  # PAT, 含 homebrew/cask fork 权限
```

`bump-cask-pr` 会自动 fork homebrew/cask、更新 version/sha256（从 checksums 或 Livecheck 抓取）、按模板开 PR。sha256 建议在 cask 中直接写死（见 §5），bump 工具会替换。

### 3.6 私有 tap（`GOODBOY008/homebrew-tap`）：长期作为 brew 唯一通道

官方收录搁置后，私有 tap 不再是过渡方案，而是 brew 用户的正式渠道，按以下规则运行：

1. **`r-shell` cask 只跟踪稳定线，且这是双基线改造中 tap 侧唯一必须的变更**：现有 dispatch 机制（release.yml:251–262）在全部 `v*` tag 上触发，必须给 `update-homebrew` job 加过滤 `!contains(github.ref, '-current.')`，否则演进线 tag 会把 tap 上的 `r-shell` 更新到 prerelease 版本。
2. tap cask 维持无 `auto_updates` stanza（§1.6），配合应用内 Caskroom 检测。
3. **演进线不进 tap（首期决策）**：`r-shell@current` cask 暂缓——solo 维护成本考量，演进线用户走直接下载 + 应用内通道切换即可；日后 brew 侧尝鲜需求真实出现再补。
4. 官方收录重启（§7 P4）时，再执行"私有 tap `r-shell` 弃用迁移 + 可选转 `r-shell@current`"的原方案。

### 3.6-旧稿（官方合并后迁移方案，搁置备查）

1. **现在（阶段 0 即做）**：tap 内 cask 去掉/不添加 `auto_updates`；新版本继续 dispatch 更新（现 release.yml:251–262 机制不动），但 README 安装指引加一段"官方源上线后请迁移"。
2. **官方 cask 合并后**：私有 tap 的 `r-shell` cask 停止更新并加 `deprecation` 块（deprecate_date + reason 指向官方 cask）；同时新增 `r-shell@current` cask 跟踪演进线（channel 不同，不违反 duplicate 条款），继续由 dispatch 事件驱动，只消费 `-current.*` tag 的产物。
3. **迁移命令写进 README 与 release notes**：
   `brew uninstall --cask GOODBOY008/tap/r-shell && brew install --cask r-shell`
   （应用内更新器检测到 Caskroom 安装会自动让位，见 §4，用户无感知冲突。）

### 3.7 checksums 与测试

- `generate-checksums`（release.yml:215–248）扩展覆盖演进线资产；演进线 dmg 同样需要 sha256 供 tap 的 `r-shell@current` 使用。
- `test.yml` 矩阵在 GitHub 提供 `macos-15` / `macos-26` runner 后加入双系统冒烟（`pnpm build` + `cargo test` 足够）；**macOS 27 验证**在 runner 可用前作为发版检查清单项（QA 手动过一遍启动 + 连接 + 终端 + SFTP），满足 "must work on latest macOS"。

---

## 4. 应用内设置与更新器改造

### 4.1 设置 UI（`src/components/settings-modal.tsx`）

现有 "Check for Updates" / "Update Proxy" 所在的 Advanced 区（settings-modal.tsx:1339–1376）改造为一个明确的 **"更新" 组**：

1. **更新通道**（新增，key `updateChannel`，默认 `'stable'`，与 `checkUpdates` 同一 localStorage 容器 `sshClientSettings`、同一读写模式）：
   - `stable`：稳定版（推荐）；
   - `current`：最新版（仅 macOS 26+ Apple Silicon）——**不满足条件时选项禁用 + tooltip 说明**（门控数据来自 §4.2 的 `get_update_context`）。
2. **Homebrew 托管横幅**：当 `homebrewManaged == true` 时，隐藏"更新通道/自动检查/代理"三个控件，替换为说明文案 + 命令提示：
   `此副本由 Homebrew 管理，请运行 brew upgrade --cask r-shell 获取更新`。
3. `checkUpdates`、`updateProxy` 两个现有 key 与行为保留（非托管安装下）。

### 4.2 Rust 侧新增（`src-tauri/src/commands.rs` + `lib.rs` 注册）

```rust
#[tauri::command] fn get_update_context() -> UpdateContext
// { homebrewManaged: bool, platform: String, arch: String, macosMajor: Option<u32> }
// homebrewManaged = std::env::current_exe() 路径包含 "/Caskroom/"
// macosMajor 用 sysinfo/os_info 或简单解析 `sw_vers`（已有系统信息采集代码可复用）

#[tauri::command] async fn updater_check(channel: String, proxy: Option<String>) -> Result<Option<UpdateMeta>, String>
// UpdaterExt::updater_builder(app) → .endpoints(vec![按 channel 选 URL]) → .proxy(...) → .check()
// 托管安装直接返回特殊错误码/标志，前端据此弹引导

#[tauri::command] async fn updater_download_and_install(app: AppHandle) -> Result<(), String>
// 持有 updater_check 返回的 Update（进程内缓存于 State），download_and_install 回调里
// app.emit("updater://progress", { downloaded, total }) 供前端进度条
```

**为什么必须走 Rust 命令而不是现有 JS `check()`**：JS 端 `CheckOptions` 只有 `headers/timeout/proxy/target/version`，**没有 endpoint 覆盖**；endpoints 覆盖只存在于 Rust `UpdaterBuilder::endpoints()`（docs.rs 已确认）。通道选择在 JS 层无法表达，故把 check/download/install 三步迁到 Rust，前端只保留 UI 与状态机。

前端 `src/components/update-checker.tsx`：`check(proxy)` → `invoke('updater_check', {...})`；进度事件监听 `updater://progress`；安装后仍走 `relaunch()`（quit_guard.rs:15 已放行更新器重启，无需改）。菜单 "check_updates" 事件链路（App.tsx:1766, 2124）不变，托管安装下改为 toast 引导 `brew upgrade`。

### 4.3 门控规则汇总

| 状态 | 自动检查 | 手动检查 | 通道选择 |
|---|---|---|---|
| 直接下载安装 | 按 `checkUpdates` | ✓ | stable/current 任选（current 需 macOS≥26 且 arm64） |
| Caskroom 安装（官方或 tap） | 强制关 | 改为 brew 引导 toast | 隐藏 |
| 非 macOS 且选 current | — | — | 选项禁用（win/linux 跟随 stable 通道的版本演进，current.json 含 win/linux 条目时不特殊处理，默认 stable） |

补充：**通道只升不降**——已装 `3.0.0-current.x` 的用户把通道切回 stable 后，更新器不会自动降级到 `2.9.x`（tauri updater 默认不安装低版本），需手动下载稳定版覆盖安装；`current` 选项的说明文案应提示这一点。

### 4.4 i18n 与测试

- 新增 key（示例）：`settings.updates.channel.label`、`settings.updates.channel.stable`、`settings.updates.channel.current`、`settings.updates.channel.currentUnavailable`、`settings.updates.homebrewManaged.title/.desc/.command` —— 同步 **en / zh-CN / pl** 三份 locale，`pnpm i18n:check` 过 parity。
- 扩展 `src/__tests__/update-checker.test.tsx`：通道 → endpoint 断言（mock invoke）、托管安装禁用自动检查、macOS<26 时 current 不可选。

---

## 5. 官方 cask 草案与提交

```ruby
cask "r-shell" do
  version "2.9.3"
  sha256 arm:   "ARM_SHA256",
         intel: "X64_SHA256"
  arch arm: "aarch64", intel: "x64"

  url "https://github.com/GOODBOY008/r-shell/releases/download/v#{version}/r-shell_#{version}_#{arch}.dmg",
      verified: "github.com/GOODBOY008/r-shell/"
  name "R-Shell"
  desc "Modern desktop SSH client with terminal, SFTP and monitoring"
  homepage "https://github.com/GOODBOY008/r-shell"

  # 不设 depends_on macos（稳定线按 Tauri 默认 10.13 兼容）
  # 不设 auto_updates：Caskroom 安装下应用内更新器自动禁用，更新交由 brew 管理

  app "R-Shell.app"
  zap trash: [
    "~/Library/Application Support/com.aiden.r-shell",
    "~/Library/Caches/com.aiden.r-shell",
    "~/Library/Preferences/com.aiden.r-shell.plist",
    "~/Library/WebKit/com.aiden.r-shell",
    "~/Library/Saved Application State/com.aiden.r-shell.savedState",
  ]
end
```

注意：`app "R-Shell.app"` 的确切 bundle 名以产物为准（`productName` 决定）；sha256 来自 `checksums.txt`；`arch` 映射与现有资产名 `r-shell_<v>_aarch64.dmg` / `r-shell_<v>_x64.dmg` 精确对应。

提交流程（由社区成员署名，见 §1.5）：

1. fork `Homebrew/homebrew-cask` → `brew create --cask <url>` 生成初版；
2. `brew audit --cask r-shell --online`、`brew style --fix` 全绿；
3. PR 模板附：项目主页、截图、notability 依据（142⭐/33 forks，标准门槛 75⭐/30 forks 已过）；
4. 合并后把仓库变量 `OFFICIAL_CASK_MERGED` 置 `true`，激活 §3.5 的 bump 自动化；日常版本仍可能被社区先 bump（cask 有 autobump 机制），与 `bump-cask-pr` 重复时该 job 允许失败（`continue-on-error: true`，冲突即无操作）。

---

## 6. 版本工具与流程文档

- `scripts/bump-version.mjs` 增加 `--channel current`：版本写 `<semver>-current.<N>`（N = 该 minor 在 `git tag` 上的计数 +1）；晋升时正常 `version:patch/minor` 打稳定 tag 即可。CHANGELOG 按发布线分节（`## [3.0.0-current.3] - ...`）。
- 顺带修复已知问题：脚本向 CHANGELOG 插入时依赖 `## [Unreleased]` 标题，而当前 CHANGELOG 没有该标题（插入会 no-op）——发版流程实际靠 release-version skill 手写。要么补标题，要么把脚本改为"在文件头版本区顶部插入"。
- `.github/skills/release-version/SKILL.md` 增补：双 tag 约定、晋升流程、cask bump 检查、macOS 27 验证清单项。
- README 安装段：官方 `brew install --cask r-shell` 置顶；私有 tap 段改为"早期用户 / current 通道"并附迁移命令。

---

## 7. 分阶段落地（2026-09-12 按 owner 三项决策修订）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0 更新器与 brew 和解 + 通道设置** | Caskroom 检测、设置改造（§4，含 `updateChannel`）、Rust updater 命令、i18n/测试 | 待实施——**下个版本前必须合入** |
| **P1 双基线 CI** | 矩阵分线（§3.1/3.2）、`current.json` 滚动 tag（§3.4）、`update-homebrew` 加 `-current.` 过滤（§3.6）、bump-version `--channel`（§6） | 待实施——**下个版本前必须合入** |
| **P2 演进线首发** | 下一个版本 = `v3.0.0-current.1`（mac arm64 min26 + linux + windows，GitHub prerelease），此后演进线 4–6 周一个 current 版、定期晋升 | 依赖 P0+P1 |
| **P3 签名公证** | Apple Developer Program + CI secrets（§3.3） | **搁置**——owner 决定暂不申请；改变主意即可独立启动，直接下载用户即刻受益 |
| **P4 官方收录** | owner 自投 cask PR（§5）+ 合并后 bump 自动化（§3.5）+ 私有 tap 迁移 | **搁置**——重启条件：notability 任一达标（225⭐/90 forks/90 watchers）**且** P3 完成；两个门槛独立，只等 star 不够 |
| **P5 文档收尾** | README 安装段补"两条发布线 / 通道说明 / 手动切换指引"、release-version skill 更新、macOS 27 验证清单 | 随 P2 落地 |

## 8. 风险与开放问题

1. **notability 裁量**：数字达标不保证收录；新提交通常审得更严，PR 描述要备齐截图与定位说明。
2. **稳定线回移成本**：双线 = 每个安全修复要 cherry-pick；晋升周期建议 4–6 周，过长则稳定线与演进线差距难以收敛。
3. **滚动 tag `current`**：force-push 可变引用，个别工具（依赖 tag 不可变性的镜像）可能不适；可接受，文档注明。
4. **更新器迁 Rust**：JS→Rust 的行为等价性靠现有测试兜底（update-checker.test.tsx 全量 mock invoke 重写）；`UpdaterBuilder::endpoints` 为公开 API，版本跟随 plugins-workspace 小版本演进，锁好 Cargo.lock。
5. **`brew bump-cask-pr` 与社区 autobump 撞车**：job 容忍失败即可，冲突无副作用。
6. **macOS 27 验证空窗**：runner 未就绪前依赖手动 QA，存在漏检风险（Tahoe→Golden Gate 的 WebKit 行为变化）。
7. ~~开放问题（需 owner 决策）~~ **已决策（2026-09-12）**：a) 暂不申请 Apple Developer 账号 → P3/P4 搁置；b) 演进线下个版本首发（`v3.0.0-current.1`）；c) 官方 cask 由 owner 自投，条件 = notability 达标 **且** 公证就绪（§1.5）。

---

## 参考来源

- Acceptable Casks：https://docs.brew.sh/Acceptable-Casks
- Package Acceptance Policy（notability 门槛）：https://docs.brew.sh/Package-Acceptance-Policy
- Cask Cookbook（auto_updates / arch DSL / depends_on）：https://docs.brew.sh/Cask-Cookbook
- Support Tiers（2026-09 系统支持矩阵）：https://docs.brew.sh/Support-Tiers
- Tauri Updater 插件文档：https://v2.tauri.app/plugin/updater/
- UpdaterBuilder Rust API：https://docs.rs/tauri-plugin-updater/latest/tauri_plugin_updater/struct.UpdaterBuilder.html
- plugin-updater JS API（CheckOptions 无 endpoint 字段）：https://v2.tauri.app/reference/javascript/updater/
