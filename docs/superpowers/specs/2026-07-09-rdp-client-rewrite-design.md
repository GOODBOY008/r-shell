# RDP 客户端重写设计

日期:2026-07-09
分支:feature/rdp-ironrdp-client

## 背景

当前 `src-tauri/src/rdp_client.rs`(864 行单文件)基于 ironrdp 0.16 实现,存在两类问题:

**功能症状(用户报告):**
1. RDP 远程画面显示变形、有斜杠(画面斜切)
2. 鼠标点击无效

**代码质量问题:**
- 单文件 864 行,连接/TLS/session/输入职责纠缠
- `SessionState` 与 `RdpThreadState` 两个几乎相同的结构体
- OpenSSL → 断连重连 → native-tls 的双重 TLS 回退,脆弱
- `split_x224_frames` 是绕 ironrdp bug 的 hack
- CredSSP/NLA 完全禁用
- `InputCommand::Resize` 是空实现,resize 从不生效
- 每个脏矩形都新分配一个 Vec

## 根因分析

### 斜杠变形 → stride 不匹配(高置信度)

`ActiveStageOutput::DeactivateAll` 当前只打 warning 就丢弃(`rdp_client.rs:754`)。Windows 服务器在协商分辨率后常做 Deactivation-Reactivation(宽度对齐、实际分辨率与请求不一致等)。此时:

- ironrdp 给出 `ConnectionActivationSequence`,需要驱动它重跑 activation 到 `Finalized`,拿到新的 `desktop_size` 和 `share_id`,并**重建 `DecodedImage`**——现在完全没做。
- 前端 canvas 的 `width/height` 用的是初次协商的 `connection_result.desktop_size`,之后再没更新。

服务器按新宽度发像素,而 `image.width()` 仍是旧值,每行错位 → 画面斜切。

### 点击失效 → 待真机日志坐实(低置信度)

传输链路(`e.buttons` → WS → fast-path DOWN/release)逻辑本身看着正确。怀疑是 reactivation 后 session 状态错乱导致 fast-path 输入被服务器忽略,或坐标随斜切错位。**此根因不猜,在验证阶段用真机日志确认。**

## 已确认的 ironrdp 0.16 API 事实

- `ConnectionActivationSequence` 实现 `Sequence`(有 `next_pdu_hint`/`step`)→ 可用 `ironrdp_async::single_sequence_step` 驱动到 `ConnectionActivationState::Finalized`。
- `ActiveStage::set_share_id(u32)` 用于 reactivation 后更新 share_id。
- `ActiveStage::encode_resize(w, h, scale, physical)` 返回 DVC resize 帧;DVC 不可用时返回 `None`。
- resize DVC 注册:`connector.with_static_channel(DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(cb)))`。需要 ironrdp 的 `dvc` + `displaycontrol` feature。
- `connect_finalize` 内建 CredSSP 驱动(sspi-rs),受 `Config.enable_credssp` 控制。
- `DecodedImage::data_for_rect(&InclusiveRectangle)` 返回带正确 stride 的行数据。
- `DecodedImage` 为 RgbA32,`stride() = width * 4`。

## 目标 / 非目标

**目标:**
- 修复斜杠变形(reactivation + 动态 canvas 尺寸)
- 坐实并修复点击失效
- 开启 NLA/CredSSP,失败自动降级到 TLS-only(可接受一次重连延迟)
- resize 真正生效(DVC),不支持时回落到 client-side 缩放
- 拆分模块,消除重复结构体与 workaround

**非目标(本次不做):**
- 音频重定向、文件传输、CLIPRDR 完整实现(保持现状 stub)
- H.264/AVC444 GFX 编码优化(继续用现有 bitmap/GFX 解码路径)
- VNC 相关改动

## 架构

将单文件拆为 `src-tauri/src/rdp/` 模块:

```
rdp/
  mod.rs        RdpClient(DesktopProtocol 实现)+ 命令通道 + 专用 OS 线程编排
  connect.rs    连接状态机:TCP → X.224 → TLS → (CredSSP|TLS-only) → finalize
  tls.rs        单一 TLS 升级路径(rustls,经 ironrdp-tls)+ 证书提取
  session.rs    session loop:读 PDU、reactivation、帧提取、输出分发
  input.rs      InputCommand → fast-path 事件映射(迁移现有 keymap 逻辑)
```

保留"专用 OS 线程 + current-thread tokio runtime"模型:ironrdp 会话类型 `!Send`,这是必要设计而非 workaround。

### 单元职责与接口

- **`connect.rs`**:输入 `RdpConfig`,输出 `(TokioFramed<ErasedStream>, ConnectionResult, ClientConnector)`。内部封装 NLA 降级逻辑。不依赖 session/输入。
- **`tls.rs`**:输入裸 stream + host,输出 `(ErasedStream, x509 证书)`。单一 rustls 路径,接受自签名证书。
- **`session.rs`**:输入连接产物 + `frame_tx` + `event_tx`(尺寸变化)+ `input_rx` + `cancel`,运行 select loop。
- **`input.rs`**:纯函数 `map_input(cmd) -> SmallVec<FastPathInputEvent>`,可独立单测。
- **`mod.rs`**:实现 `DesktopProtocol`,持有命令通道句柄。

## 关键流程

### 1. 连接与 NLA 自动降级(connect.rs)

```
fn connect(config):
    result = try_connect(config, enable_credssp = true)
    if result is CredSSP-related error:
        warn!("CredSSP failed, falling back to TLS-only")
        result = try_connect(config, enable_credssp = false)   // 重连一次
    return result
```

`try_connect` 内单一 TLS 路径,不再做 OpenSSL/native-tls 双回退。DVC 通道在构造 connector 时注册(用于后续 resize)。

### 2. Reactivation(斜杠变形的正解,session.rs)

session loop 处理 `ActiveStageOutput::DeactivateAll(cas)`:

```
handle_deactivate_all(cas):
    seq = *cas
    loop:
        single_sequence_step(&mut framed, &mut seq, &mut buf).await
        if seq.state is Finalized { desktop_size, .. }: break
    image = DecodedImage::new(RgbA32, new_w, new_h)   // 重建
    active_stage.set_share_id(new_share_id)
    desktop_size = new_size
    event_tx.send(DesktopResized { width, height })    // 通知前端
```

注意:`reader`/`writer` 当前是 split 的;reactivation 需要在未 split 的 framed 上驱动 sequence。设计上在 loop 开始前**不 split**,而是持有整体 `framed` 并直接对其 `read_pdu`/`write_all`,以便复用同一 framed 驱动 activation sequence。(取消现有的 `split_tokio_framed`。)

### 3. 帧提取(session.rs)

`GraphicsUpdate(region)` 用 `image.data_for_rect(&region)` 拿带正确 stride 的字节,复用一个可增长 buffer,避免每帧新分配。按行拷贝到紧凑 RGBA(canvas 需要连续 `w*h*4`)。

### 4. resize 真正生效(session.rs + mod.rs)

`InputCommand::Resize { width, height }`:

```
match active_stage.encode_resize(w, h, None, None):
    Some(Ok(frame)) => writer.write_all(frame)         // 服务器将回 DeactivateAll → 走 reactivation
    Some(Err(e))    => warn, 保持原分辨率
    None            => DVC 不可用,前端回落 client-side 缩放(已有 computeFitScale)
```

## 前后端协议变更

`websocket_server.rs` 的 `WsMessage` 新增:

```rust
/// 远程桌面尺寸变化(reactivation 或 resize 生效后)
DesktopResized { connection_id: String, width: u16, height: u16 },
```

`desktop_protocol.rs` 的 `FrameUpdate` 通道旁,新增一条尺寸事件通道(`mpsc::UnboundedSender<DesktopEvent>`),或复用现有 frame 通道加一个 enum 变体。**选定:** 新增 `DesktopEvent` enum(`Frame(FrameUpdate)` | `Resized { w, h }`),`start_frame_loop` 的发送端类型改为 `DesktopEvent`,websocket 转发端据变体分别发二进制帧或 `DesktopResized` JSON。

前端 `desktop-viewer.tsx`:`onmessage` 处理 `DesktopResized` → `setDesktopWidth/Height`,canvas 随之重设尺寸并清空。

## 错误处理

- 连接错误:CredSSP 失败降级;降级仍失败 → 返回明确错误给前端。
- session 读错误、`Terminate`:干净退出 loop,前端进入 disconnected 态(已有 UI)。
- reactivation sequence 出错:记 error,终止会话(不吞掉)。
- resize DVC 不可用:非错误,回落 client-side 缩放。

## 测试

**单元测试(cargo test,无需真机):**
- `input.rs`:`map_input` 对按下/抬起/多键/滚轮/纯移动的事件映射
- resize 参数边界(200–8192、非奇数宽度)——用 `MonitorLayoutEntry::adjust_display_size`

**集成/真机验证(tests/rdp-e2e.spec.ts,连 192.168.20.180):**
1. 连接成功、canvas 渲染
2. 开日志确认:reactivation 是否触发、`DesktopResized` 是否发出、斜杠是否消失
3. 键盘输入生效
4. **鼠标点击**:用真机日志坐实根因并确认修复
5. resize:容器变化 → 远端分辨率跟随(或明确回落缩放)

## 迁移与清理

- 删除 `split_x224_frames` 及其调用
- 合并 `SessionState`/`RdpThreadState` 为单一结构体
- `ironrdp` 依赖增加 `dvc`、`displaycontrol`、`input` feature
- `rdp_keymap.rs` 保留,由 `input.rs` 调用

### TLS 单路化的推进顺序(已与用户确认)

TLS 单路化放到**最后一步**,且**仅在 rustls 真能连上目标服务器时才替换**:

- 历史注释标明 OpenSSL 是 "PRIMARY TLS backend",理由是 macOS Secure Transport session 复用问题与 Windows RDP 的 CBC cipher 需求。若贸然切 rustls 且握手失败,会卡在 TLS 步骤、连斜杠都摸不到。
- 因此先**保留现有能连上的 OpenSSL/native-tls 回退路径**,优先完成 reactivation + 动态尺寸 + 点击修复并真机验证。
- 待前述成果稳定后,再尝试 rustls 单路化;只有真机握手成功才删除 OpenSSL/native-tls 双回退及对应依赖(`openssl`/`native-tls`/`tokio-native-tls`),否则保留双路。
- 由此,`tls.rs` 初期仍封装现有双回退逻辑(仅从 `connect.rs` 抽离,不改行为);单路化是独立的收尾步骤。

## 风险

- **CredSSP 与 sspi-rs 版本兼容性**:历史注释提到"ironrdp/sspi-rs compatibility"问题禁用了 CredSSP。若 0.16 仍不兼容,自动降级保证可用性,但 NLA 目标可能达不成——届时如实报告,不强行标记完成。
- **DVC resize 服务器支持**:部分服务器无 Display Control 通道,已设计回落。
- **reactivation 在 split framed 上不可行**:已通过不 split、持有整体 framed 解决。

---

## 真机验证结果(2026-08-29,branch feature/rdp-ironrdp-client)

目标机器 192.168.20.180:3389 可达。e2e(`cargo test rdp_connect_and_capture_frames -- --ignored`)全程通过,结果如下:

| 项目 | 结果 | 说明 |
|------|------|------|
| 连接 + 帧解码 | ✅ | TLS-only 连接 1280×800,10 帧,非零像素校验通过,PNG 落盘 |
| 斜杠变形 | ✅ 消失 | 对捕获帧做逐行相关性分析:高方差行 9/11 最佳偏移为 0,无系统性斜切 |
| 鼠标点击 | ✅ 机制生效 | press/release 后会话存活且帧继续流动(fast-path 输入被服务器接受) |
| resize | ✅ 回落路径 | 该服务器无 Display Control DVC("unavailable, client-side scaling"),会话存活;服务器端 resize 无法在此机器验证 |
| NLA/CredSSP | ⚠️ 服务器侧失败,自动降级生效 | 见下 |

### NLA 失败定位(alert 80)

- 该服务器在收到**第一条** CredSSP TSRequest(v6)后立刻以 TLS alert 80(internal_error)断开 —— 此时 `pub_key_auth` 尚未参与,与本仓库曾引用的 sspi-rs#651(该问题实为调用方传整证书 DER,已在 af91ac2 修正为 SubjectPublicKey bits)无关。
- SPNEGO/Negotiate 与 raw NTLM 两种模式**同样**在第一步被拒,排除 token 封装问题。
- FreeRDP 3.31(默认配置与 seclevel:0)对该机器连 TLS 握手都无法完成;本客户端依靠 `ALL:@SECLEVEL=0` + TLS1.0 下限 + CBC 才能协商成功(cipher = AES128-SHA,静态 RSA 密钥交换)。协商出的 RDP 版本 0x80004(Server 2003 时代 caps)。
- 结论:该机器极可能是 xrdp/旧式 Windows,CredSSP 栈自身不可用。mstsc/FreeRDP 同样无法与其完成 NLA。自动 TLS-only 降级是正确行为。

### Task 10(TLS 单路化)——按条件跳过

前置条件"rustls 能连上 192.168.20.180"**不成立**:rustls 不支持静态 RSA 密钥交换(TLS_RSA_WITH_AES_128_CBC_SHA),也不支持 TLS 1.0/1.1,而该服务器只接受此类旧套件。按计划保留 OpenSSL(主)+ native-tls(macOS 回退)双路径,不删除 openssl/native-tls 依赖。

### 附带成果(本轮)

- sspi 更新:vendor 0.21.3 + 上游 #719/#717 cherry-pick(145e850);sspi master(0.21.4)因 picky rc.25/rc.26 精确锁与 ironrdp-connector 0.10 冲突不可用,已在 `vendor/sspi-rs/VENDOR.md` 记录。
- CredSSP pub_key_auth 修正(af91ac2)。
- `rdp_client.rs` 拆分为 `rdp/{tls,connect,session,mod}.rs`(6421f35),`RdpThreadState`/`SessionState` 合并。
- e2e 扩展:指针存活断言 + resize 回落断言 + 会话存活性检查。
