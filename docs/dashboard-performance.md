# Dashboard 性能验证

本轮目标是降低 Dashboard 采集、缓存和渲染开销，同时控制远端探针压力。优化以保持用户配置的采样频率为前提，不因后台状态设置 30 秒下限，也不降低模板默认刷新频率。基线为 `f9271e2`（PR #307 合并后的 main），测试日期为 2026-11-11。

## 固定运行时负载

使用 `dashboard-performance.bench.test.ts`：16 个模拟 SSH 连接、5 个看板、10 个采集源、30 张卡片（每个来源对应数值、四条曲线和表格），配置间隔均为 5 秒。每次返回约 131 KiB JSON，包含大量未映射字段，以检验原始输出保留开销。先让所有看板可见 20 秒，再仅保留一个可见 60 秒。

独立 Vitest fork 进程开启 GC，在相同导入与配置完成后测量运行时保留堆；虚拟时钟让调度过程可重复。下表为实际输出，未用整个应用 RSS 代替运行时堆，也未把模拟请求并发当作远端实际进程并发。

| 指标 | 基线 | 优化后 |
| --- | ---: | ---: |
| 80 秒内发出的命令请求 | 2560 | 2560 |
| 后 60 秒内的命令请求 | 1920 | 1920 |
| 前端同时发出的执行请求峰值 | 160 | 8 |
| 同一保存连接的执行请求峰值 | 10 | 1 |
| 同时建连峰值 | 16 | 4 |
| 运行时通知次数 | 5154 | 351 |
| GC 后保留的 JavaScript 堆增量 | 24,451,384 字节（23.3 MiB） | 7,434,728 字节（7.1 MiB） |
| 关闭后相对起点的堆增量 | 475,768 字节 | 575,032 字节 |

这一场景中采样数保持不变，通知下降约 93.2%，保留堆下降约 69.6%。基线后端已经限制每个 SSH 会话最多两个通道，因此基线的 160/10 是前端请求及后端排队压力，不是服务器上同时执行了 160/10 个命令。正常命令按启动时间维持配置周期；过长命令跳过错过的周期，并发饱和时等待可用位置，失败另做退避。

复现命令：

```sh
RSHELL_DASHBOARD_BENCHMARK=1 \
RSHELL_DASHBOARD_BENCHMARK_REPORT=/tmp/dashboard-performance.json \
pnpm exec vitest run dashboard-performance.bench --pool=forks --execArgv=--expose-gc
```

## 浏览器渲染验证

在开发版 Chromium 中用演示数据加载 20 张表格，每张引用两个连接、每连接保留 200 行，每页显示 50 行。用 CDP `HeapProfiler.collectGarbage` 和 `Runtime.getHeapUsage` 观察同一页面从前台切至另一张静态看板的变化：

| 指标 | 表格看板在前台 | 表格看板在后台 |
| --- | ---: | ---: |
| 实际表格 DOM | 20 | 0 |
| 页面元素总数 | 12610 | 727 |
| JavaScript 堆 | 79,664,932 字节 | 50,004,072 字节 |

切至后台后释放约 28.3 MiB 渲染堆。后台按配置的 5 秒采样，实测启动间隔为 5.00–5.25 秒（250 ms 调度粒度）。返回前台后 20 张表格恢复且连接筛选仍为原选择。这个对比是优化后的前台/后台状态，不是两个版本的全应用内存对比；浏览器开发构建的绝对堆大小不能代替 Tauri/WKWebView 的 RSS。

## 真实 SSH 与回归

`dashboard-ssh-performance.integration.test.ts` 使用一次性本地 OpenSSH 容器和已认证的 ControlMaster，以非交互 SSH 通道运行六个探针及手动试运行。远端目录记录同时存活的探针数，峰值为 1；切后台后仍在下一个配置的 5 秒周期执行全部六个探针，关闭后缓存清空。该测试验证前端调度与真实 SSH 命令的组合，不替代 Tauri IPC 和全部桌面平台的性能测试。

```sh
RSHELL_DASHBOARD_SSH_CONTROL=/path/to/disposable/control-socket \
RSHELL_DASHBOARD_SSH_PORT=2225 \
pnpm exec vitest run dashboard-ssh-performance.integration
```

`ssh::reuse_tests::docker_dashboard_reuses_transport_without_sharing_owner_lifecycle` 直接使用 Rust `ConnectionManager` 和 russh 检验传输复用：先建立一个终端，再连续建立/关闭十个看板试运行身份，验证它们共享相同的 `SshClient` 和远端 `$SSH_CONNECTION`。关闭终端会取消其 PTY，但正在执行的看板命令成功完成；最后关闭看板后物理会话被释放。普通终端登录和不同配置仍建立独立连接。

```sh
RSHELL_TEST_SSH_PORT=2225 cargo test --manifest-path src-tauri/Cargo.toml \
  docker_dashboard_reuses_transport_without_sharing_owner_lifecycle -- --ignored
```

测试要求测试容器中的 `testuser` 已通过控制连接认证，只在一次性容器内使用；不要指向生产服务器。普通测试不启用这两个性能测试入口。

自动回归覆盖相同前后台频率、暂停曲线在其他看板持续更新时的时间轴推进、复用会话的并发与取消隔离、并发与公平性、慢命令间隔、失败退避和显式重试、排队取消与迟到结果、原始输出预算、缓存释放后保留数据及错误、按看板通知、静态看板无循环唤醒、暂停隐藏后的过期历史释放、共享 JSON 解码、隐藏表格后恢复筛选，以及终端更新不触发看板重配置。

## 边界

- 8 MiB 是原始成功输出的字符串预算；配置、已解析的文本/表格、曲线历史、React 和其他功能仍占内存，不能把它当作 R-Shell 总内存上限。
- 每个保存连接有独立调度键。同一物理服务器若被保存为多个不同连接，仍会有多个独立预算；其他终端、Monitor 面板和其他应用也可能访问该服务器。
- 自定义命令自身的 CPU、内存及后台子进程由命令决定。客户端限制频率、并发和等待时间，不替代远端资源隔离。
- 前后台均使用原配置间隔，新模板仍为 10 秒。复用减少 TCP/SSH 握手、认证及连接常驻开销；在相同采样频率下，不声称减少自定义命令本身的计算量。
