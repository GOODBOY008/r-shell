# RDP 客户端重写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 RDP 画面斜杠变形与鼠标点击失效,并把 864 行单文件重构为可维护的模块化 client。

**Architecture:** 将 `rdp_client.rs` 拆为 `rdp/` 模块(mod/connect/tls/session/input)。核心修复是处理 `ActiveStageOutput::DeactivateAll`——驱动 ironrdp 的 `ConnectionActivationSequence` 重跑到 `Finalized`,重建 `DecodedImage`,并把新尺寸经新的 `DesktopEvent::Resized` 通道推给前端,让 canvas 动态跟随。TLS 单路化推迟到最后且仅在真机验证通过后执行。

**Tech Stack:** Rust, ironrdp 0.16(connector 0.9 / session 0.10 / dvc 0.7 / displaycontrol 0.7)、tokio、tauri、tokio-tungstenite;前端 React + TypeScript。

## Global Constraints

- ironrdp 版本:`ironrdp = "0.16"`,`ironrdp-tokio = "0.9"`,`ironrdp-tls = "0.2"`(已在 Cargo.toml)
- 新增 ironrdp feature:`dvc`、`displaycontrol`、`input`
- 保留"专用 OS 线程 + current-thread tokio runtime"模型(ironrdp 会话类型 `!Send`)
- TLS 单路化(切 rustls、删 openssl/native-tls)仅在真机握手成功后执行;否则保留现有双回退
- 每个 commit 前 `cargo build` 必须通过
- 不改动 VNC 相关代码
- CredSSP 失败自动降级到 TLS-only,可接受一次 TCP 重连延迟

## 已确认的 ironrdp 0.16 API(事实,勿再猜)

- `ConnectionActivationSequence` 实现 `Sequence` → 用 `ironrdp_tokio::single_sequence_step(&mut framed, &mut seq, &mut buf).await` 驱动。
- `seq.connection_activation_state()` 返回 `ConnectionActivationState`;`Finalized { desktop_size: DesktopSize, share_id: u32, .. }` 为完成态。
- `ActiveStage::set_share_id(share_id: u32)`。
- `ActiveStage::encode_resize(width: u32, height: u32, scale_factor: Option<u32>, physical_dims: Option<(u32,u32)>) -> Option<SessionResult<Vec<u8>>>`(`None` = DVC 不可用)。
- `MonitorLayoutEntry::adjust_display_size(width: u32, height: u32) -> (u32, u32)`(路径:`ironrdp::displaycontrol::pdu::MonitorLayoutEntry`)。
- DVC 注册:`ClientConnector::new(cfg, addr).with_static_channel(DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_caps| Ok(vec![]))))`。
- `DisplayControlClient::new<F>(cb)`,`F: Fn(DisplayControlCapabilities) -> PduResult<Vec<DvcMessage>> + Send + 'static`。
- `connect_finalize` 内建 CredSSP 驱动,由 `Config.enable_credssp` 控制。
- CredSSP 错误:`ConnectorError.kind == ConnectorErrorKind::Credssp(_)`。
- `DecodedImage::data_for_rect(&InclusiveRectangle) -> &[u8]`(带正确 stride);`stride() = width*4`;格式 RgbA32。
- `InclusiveRectangle` 边界含端点:`width() = right-left+1`,`height() = bottom-top+1`。

---

## Task 1: 提取 input 映射到独立模块(纯函数 + 单测)

把 `handle_input_command` 的 fast-path 事件映射抽成纯函数,先建立可单测的最小单元,不改行为。

**Files:**
- Create: `src-tauri/src/rdp/mod.rs`(暂时只 `pub mod input;` + re-export 占位)
- Create: `src-tauri/src/rdp/input.rs`
- Modify: `src-tauri/src/lib.rs`(或声明 `rdp_client` 的地方,加 `mod rdp;`)
- Test: `src-tauri/src/rdp/input.rs`(`#[cfg(test)]` 内联)

**Interfaces:**
- Produces:
  - `pub enum InputCommand { Key { scancode: u16, down: bool }, Pointer { x: u16, y: u16, mask: u8, prev_mask: u8 }, Resize { width: u16, height: u16 }, FullFrame }`
  - `pub fn map_input(cmd: &InputCommand) -> smallvec::SmallVec<[ironrdp::pdu::input::fast_path::FastPathInputEvent; 4]>`（`Resize`/`FullFrame` 返回空)

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/rdp/input.rs` 末尾:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::pdu::input::fast_path::FastPathInputEvent;

    #[test]
    fn key_down_maps_to_one_keyboard_event() {
        let evs = map_input(&InputCommand::Key { scancode: 0x1E, down: true });
        assert_eq!(evs.len(), 1);
        assert!(matches!(evs[0], FastPathInputEvent::KeyboardEvent(_, _)));
    }

    #[test]
    fn left_button_press_emits_down_event() {
        // prev=0 (up) -> mask=0x01 (left down): one MouseEvent
        let evs = map_input(&InputCommand::Pointer { x: 10, y: 20, mask: 0x01, prev_mask: 0x00 });
        assert_eq!(evs.len(), 1);
        assert!(matches!(evs[0], FastPathInputEvent::MouseEvent(_)));
    }

    #[test]
    fn left_button_release_emits_event() {
        let evs = map_input(&InputCommand::Pointer { x: 10, y: 20, mask: 0x00, prev_mask: 0x01 });
        assert_eq!(evs.len(), 1);
    }

    #[test]
    fn pure_move_emits_single_move_event() {
        let evs = map_input(&InputCommand::Pointer { x: 5, y: 5, mask: 0x00, prev_mask: 0x00 });
        assert_eq!(evs.len(), 1);
    }

    #[test]
    fn wheel_up_emits_vertical_wheel() {
        let evs = map_input(&InputCommand::Pointer { x: 0, y: 0, mask: 0x08, prev_mask: 0x00 });
        assert_eq!(evs.len(), 1);
    }

    #[test]
    fn resize_and_fullframe_emit_nothing() {
        assert!(map_input(&InputCommand::Resize { width: 800, height: 600 }).is_empty());
        assert!(map_input(&InputCommand::FullFrame).is_empty());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test --lib rdp::input 2>&1 | tail -20`
Expected: 编译失败(`map_input`/`InputCommand`/模块未定义)。

- [ ] **Step 3: 写实现**

`src-tauri/src/rdp/input.rs` 顶部(迁移自 `rdp_client.rs:770-863` 与 `rdp_keymap` 调用):

```rust
use crate::rdp_keymap;
use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp::pdu::input::mouse::{MousePdu, PointerFlags};
use smallvec::SmallVec;

/// Commands sent from the `DesktopProtocol` trait methods to the session task.
#[derive(Debug)]
pub enum InputCommand {
    Key { scancode: u16, down: bool },
    Pointer { x: u16, y: u16, mask: u8, prev_mask: u8 },
    Resize { width: u16, height: u16 },
    FullFrame,
}

/// Maps an `InputCommand` to zero or more fast-path input events.
/// `Resize`/`FullFrame` produce no fast-path events (handled elsewhere).
pub fn map_input(cmd: &InputCommand) -> SmallVec<[FastPathInputEvent; 4]> {
    match cmd {
        InputCommand::Key { scancode, down } => map_key(*scancode, *down),
        InputCommand::Pointer { x, y, mask, prev_mask } => map_pointer(*x, *y, *mask, *prev_mask),
        InputCommand::Resize { .. } | InputCommand::FullFrame => SmallVec::new(),
    }
}

fn map_key(scancode: u16, down: bool) -> SmallVec<[FastPathInputEvent; 4]> {
    let (prefix, sc) = rdp_keymap::scancode_bytes(scancode);
    let mut flags = KeyboardFlags::empty();
    if !down {
        flags |= KeyboardFlags::RELEASE;
    }
    if prefix != 0 {
        flags |= KeyboardFlags::EXTENDED;
    }
    let mut v = SmallVec::new();
    v.push(FastPathInputEvent::KeyboardEvent(flags, sc));
    v
}

fn map_pointer(x: u16, y: u16, mask: u8, prev_mask: u8) -> SmallVec<[FastPathInputEvent; 4]> {
    let mut events: SmallVec<[FastPathInputEvent; 4]> = SmallVec::new();

    // Wheel events are stateless.
    if mask & 0x08 != 0 || mask & 0x10 != 0 {
        let mut flags = PointerFlags::VERTICAL_WHEEL;
        if mask & 0x10 != 0 {
            flags |= PointerFlags::WHEEL_NEGATIVE;
        }
        events.push(FastPathInputEvent::MouseEvent(MousePdu {
            flags,
            x_position: x,
            y_position: y,
            number_of_wheel_rotation_units: 1,
        }));
        return events;
    }

    // Button press/release transitions. Bits: 0x01=left, 0x02=right, 0x04=middle.
    let button_pairs: [(u8, PointerFlags); 3] = [
        (0x01, PointerFlags::LEFT_BUTTON),
        (0x02, PointerFlags::RIGHT_BUTTON),
        (0x04, PointerFlags::MIDDLE_BUTTON_OR_WHEEL),
    ];

    for (bit, flag) in &button_pairs {
        let was_down = prev_mask & bit != 0;
        let is_down = mask & bit != 0;
        if is_down && !was_down {
            events.push(FastPathInputEvent::MouseEvent(MousePdu {
                flags: *flag | PointerFlags::DOWN | PointerFlags::MOVE,
                x_position: x,
                y_position: y,
                number_of_wheel_rotation_units: 0,
            }));
        } else if !is_down && was_down {
            events.push(FastPathInputEvent::MouseEvent(MousePdu {
                flags: *flag | PointerFlags::MOVE,
                x_position: x,
                y_position: y,
                number_of_wheel_rotation_units: 0,
            }));
        }
    }

    // Pure move (no button transitions).
    if events.is_empty() {
        events.push(FastPathInputEvent::MouseEvent(MousePdu {
            flags: PointerFlags::MOVE,
            x_position: x,
            y_position: y,
            number_of_wheel_rotation_units: 0,
        }));
    }

    events
}
```

`src-tauri/src/rdp/mod.rs`:

```rust
pub mod input;
```

在 `src-tauri/src/lib.rs` 声明 `rdp_client` 的位置附近加(保留旧 `rdp_client` 暂不删):

```rust
mod rdp;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test --lib rdp::input 2>&1 | tail -20`
Expected: 6 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/rdp/ src-tauri/src/lib.rs
git commit -m "refactor(rdp): extract input mapping into rdp::input module with tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 新增 DesktopEvent 通道类型(尺寸事件基础)

为把 reactivation/resize 后的新尺寸推给前端,引入统一的桌面事件枚举。本任务只改类型与 trait 签名,后续任务填充逻辑。

**Files:**
- Modify: `src-tauri/src/desktop_protocol.rs`(加 `DesktopEvent`,改 `start_frame_loop` 签名)
- Modify: `src-tauri/src/rdp_client.rs`(适配新签名,行为等价)
- Modify: `src-tauri/src/vnc_client.rs`(若存在,适配签名)
- Modify: `src-tauri/src/websocket_server.rs`(forwarder 适配)
- Modify: `src-tauri/src/connection_manager.rs`(`start_desktop_stream` 签名透传)

**Interfaces:**
- Produces:
  - `pub enum DesktopEvent { Frame(FrameUpdate), Resized { width: u16, height: u16 } }`
  - `DesktopProtocol::start_frame_loop(&self, event_tx: mpsc::UnboundedSender<DesktopEvent>, cancel: CancellationToken) -> Result<()>`
- Consumes: Task 1 无。

- [ ] **Step 1: 查找所有受影响调用点**

Run:
```bash
cd src-tauri && grep -rn 'FrameUpdate\|start_frame_loop\|start_desktop_stream\|frame_tx\|frame_rx' src/ | grep -v '/rdp/'
```
Expected: 列出 `desktop_protocol.rs`、`rdp_client.rs`、`websocket_server.rs`、`connection_manager.rs`(可能还有 `vnc_client.rs`)。据此逐个改。

- [ ] **Step 2: 改 desktop_protocol.rs**

在 `FrameUpdate` 定义之后新增:

```rust
/// Events emitted by a desktop session loop toward the frontend.
#[derive(Clone, Debug)]
pub enum DesktopEvent {
    /// A decoded dirty-rectangle framebuffer update.
    Frame(FrameUpdate),
    /// The remote desktop size changed (initial mismatch, reactivation, or resize).
    Resized { width: u16, height: u16 },
}
```

把 trait 方法签名改为:

```rust
    async fn start_frame_loop(
        &self,
        event_tx: mpsc::UnboundedSender<DesktopEvent>,
        cancel: CancellationToken,
    ) -> Result<()>;
```

- [ ] **Step 3: 适配 rdp_client.rs(行为等价,先包一层)**

`rdp_client.rs` 里 `frame_loop_tx` 与 `start_frame_loop` 的通道元素类型 `FrameUpdate` 改为 `DesktopEvent`。`rdp_session_loop` 内 `frame_tx.send(FrameUpdate {..})` 改为 `event_tx.send(DesktopEvent::Frame(FrameUpdate {..}))`。类型别名同步:

将
```rust
frame_loop_tx: Mutex<Option<mpsc::UnboundedSender<(mpsc::UnboundedSender<FrameUpdate>, CancellationToken)>>>,
```
改为
```rust
frame_loop_tx: Mutex<Option<mpsc::UnboundedSender<(mpsc::UnboundedSender<DesktopEvent>, CancellationToken)>>>,
```
并把 `SessionState`/`rdp_session_loop`/`RdpThreadState` 中所有 `mpsc::UnboundedSender<FrameUpdate>` 改为 `mpsc::UnboundedSender<DesktopEvent>`;`frame_tx.send(FrameUpdate {...})` 处改为 `event_tx.send(DesktopEvent::Frame(FrameUpdate {...}))`。导入 `use crate::desktop_protocol::{DesktopEvent, ...}`。

- [ ] **Step 4: 适配 connection_manager.rs 与 websocket_server.rs**

`connection_manager.rs` 的 `start_desktop_stream` 把 `frame_tx: mpsc::UnboundedSender<FrameUpdate>` 改为 `event_tx: mpsc::UnboundedSender<DesktopEvent>`,透传给 `start_frame_loop`。

`websocket_server.rs` StartDesktop 分支的 forwarder(约 690-723 行)改为按事件变体分发:

```rust
let (event_tx, mut event_rx) =
    mpsc::unbounded_channel::<crate::desktop_protocol::DesktopEvent>();
// ...spawn start_desktop_stream(&cid, event_tx, cancel_clone)...

let tx_clone = tx.clone();
let cid = connection_id.clone();
tokio::spawn(async move {
    use crate::desktop_protocol::DesktopEvent;
    while let Some(ev) = event_rx.recv().await {
        match ev {
            DesktopEvent::Frame(frame) => {
                let binary = encode_desktop_frame(
                    &cid, frame.x, frame.y, frame.width, frame.height, &frame.rgba_data,
                );
                if tx_clone.send(Message::Binary(binary.into())).await.is_err() {
                    break;
                }
            }
            DesktopEvent::Resized { width, height } => {
                let msg = WsMessage::DesktopResized {
                    connection_id: cid.clone(),
                    width,
                    height,
                };
                if send_control(&tx_clone, &msg).await.map(|o| o == SendOutcome::Closed).unwrap_or(true) {
                    break;
                }
            }
        }
    }
});
```

在 `WsMessage` enum 新增变体:

```rust
    /// Remote desktop size changed (reactivation or resize took effect)
    DesktopResized {
        connection_id: String,
        width: u16,
        height: u16,
    },
```

- [ ] **Step 5: 若存在 vnc_client.rs 一并适配**

Run: `cd src-tauri && grep -ln 'start_frame_loop' src/vnc_client.rs 2>/dev/null`
若命中:把其 `start_frame_loop` 签名改为 `event_tx: mpsc::UnboundedSender<DesktopEvent>`,内部 `frame_tx.send(update)` 改为 `event_tx.send(DesktopEvent::Frame(update))`。

- [ ] **Step 6: 编译确认通过**

Run: `cd src-tauri && cargo build 2>&1 | tail -30`
Expected: 编译成功(可能有 unused warning,可接受)。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/
git commit -m "refactor(rdp): introduce DesktopEvent channel for frame + resize events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 前端处理 DesktopResized(动态 canvas 尺寸)

前端收到 `DesktopResized` 时更新 canvas 尺寸。这是斜杠修复的前端侧;即使初次协商尺寸≠实际,也能被后端 Resized 事件纠正。

**Files:**
- Modify: `src/components/desktop-viewer.tsx`(`onmessage` 加分支)

**Interfaces:**
- Consumes: Task 2 的 `WsMessage::DesktopResized { connection_id, width, height }`(JSON:`{ type: "DesktopResized", connection_id, width, height }`)。

- [ ] **Step 1: 在 onmessage 的字符串分支加处理**

`desktop-viewer.tsx` 约 92-104 行,`DesktopStarted` 分支之后、`ClipboardUpdate` 之前插入:

```tsx
            } else if (msg.type === 'DesktopResized' && msg.connection_id === connectionId) {
              if (msg.width && msg.height) {
                setDesktopWidth(msg.width);
                setDesktopHeight(msg.height);
              }
```

（保持 `else if` 链完整。）

- [ ] **Step 2: 编译/类型检查前端**

Run: `pnpm tsc --noEmit 2>&1 | tail -20`
Expected: 无新增类型错误。

- [ ] **Step 3: Commit**

```bash
git add src/components/desktop-viewer.tsx
git commit -m "feat(desktop-viewer): resize canvas on DesktopResized event

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: session loop 处理 DeactivateAll(斜杠变形核心修复)

在现有 `rdp_client.rs` 的 `rdp_session_loop` 中实现 reactivation:驱动 `ConnectionActivationSequence` 到 `Finalized`,重建 `DecodedImage`,更新 share_id,推 `Resized` 事件。这需要不 split framed(在整体 framed 上驱动 sequence)。

**Files:**
- Modify: `src-tauri/src/rdp_client.rs`(`rdp_session_loop` 不再 split;新增 reactivation 处理;`GraphicsUpdate` 改用 `data_for_rect`;删 `split_x224_frames`)

**Interfaces:**
- Consumes: Task 2 的 `DesktopEvent`。
- Produces: 行为——服务器 DeactivateAll 后画面尺寸正确、不再斜切。

- [ ] **Step 1: 改 session loop 使用整体 framed(不 split)**

将 `rdp_session_loop` 开头的
```rust
let (mut reader, mut writer) = split_tokio_framed(framed);
```
替换为持有 `let mut framed = framed;`,并把后续 `reader.read_pdu()` 改为 `framed.read_pdu()`、`writer.write_all(&frame)` 改为 `framed.write_all(&frame).await`。导入 `use ironrdp_tokio::{FramedRead, FramedWrite};`(read_pdu/write_all 所需 trait)。删除 `use ironrdp_tokio::{split_tokio_framed, FramedWrite};` 中的 `split_tokio_framed`。

- [ ] **Step 2: 新增 reactivation 处理函数**

在 `rdp_client.rs` 末尾新增(泛型受 `single_sequence_step` 约束):

```rust
/// Drive a Deactivation-Reactivation sequence to completion, returning the
/// new desktop size and share_id. Rebuilds must be applied by the caller.
async fn run_reactivation(
    framed: &mut ironrdp_tokio::TokioFramed<ErasedStream>,
    cas: Box<ironrdp::connector::connection_activation::ConnectionActivationSequence>,
) -> Result<(u16, u16, u32)> {
    use ironrdp::connector::connection_activation::ConnectionActivationState;
    use ironrdp::core::WriteBuf;

    let mut seq = *cas;
    let mut buf = WriteBuf::new();
    loop {
        ironrdp_tokio::single_sequence_step(framed, &mut seq, &mut buf)
            .await
            .map_err(|e| anyhow::anyhow!("reactivation step failed: {}", e))?;
        if let ConnectionActivationState::Finalized {
            desktop_size, share_id, ..
        } = seq.connection_activation_state()
        {
            return Ok((desktop_size.width, desktop_size.height, share_id));
        }
    }
}
```

- [ ] **Step 3: 在 output 循环里处理 DeactivateAll**

把 `rdp_session_loop` 内 `ActiveStageOutput::DeactivateAll(_activation)` 分支(现约 754 行的 warning)替换为:

```rust
                ActiveStageOutput::DeactivateAll(cas) => {
                    tracing::info!("RDP DeactivateAll — running reactivation sequence");
                    match run_reactivation(&mut framed, cas).await {
                        Ok((w, h, share_id)) => {
                            tracing::info!("RDP reactivation done: {}x{} share_id={}", w, h, share_id);
                            image = DecodedImage::new(PixelFormat::RgbA32, w, h);
                            active_stage.set_share_id(share_id);
                            let _ = event_tx.send(crate::desktop_protocol::DesktopEvent::Resized {
                                width: w,
                                height: h,
                            });
                        }
                        Err(e) => {
                            tracing::error!("RDP reactivation failed: {}", e);
                            return Ok(());
                        }
                    }
                }
```

注意:`image` 与 `active_stage` 需为 `let mut` 且在 loop 外声明(现已是)。`event_tx` 是 Task 2 改名后的发送端。

- [ ] **Step 4: GraphicsUpdate 改用 data_for_rect**

把 `ActiveStageOutput::GraphicsUpdate(region)` 分支的手写按行拷贝替换为使用库函数 + 复用 buffer。在 loop 外声明 `let mut rgba_buf: Vec<u8> = Vec::new();`,分支内:

```rust
                ActiveStageOutput::GraphicsUpdate(region) => {
                    let w = region.width() as usize;   // right-left+1
                    let h = region.height() as usize;  // bottom-top+1
                    if w == 0 || h == 0 {
                        continue;
                    }
                    let stride = image.stride();
                    let bpp = image.bytes_per_pixel();
                    let src = image.data_for_rect(&region);
                    // data_for_rect returns rows at the image stride; compact to w*h*bpp.
                    rgba_buf.clear();
                    rgba_buf.reserve(w * h * bpp);
                    let row_bytes = w * bpp;
                    for row in 0..h {
                        let start = row * stride;
                        let end = start + row_bytes;
                        if end <= src.len() {
                            rgba_buf.extend_from_slice(&src[start..end]);
                        }
                    }
                    let _ = event_tx.send(crate::desktop_protocol::DesktopEvent::Frame(FrameUpdate {
                        x: region.left,
                        y: region.top,
                        width: w as u16,
                        height: h as u16,
                        rgba_data: rgba_buf.clone(),
                    }));
                }
```

删除该分支原有的 `img_width`/手写 `for row in y..(y+h)` 逻辑与 `gfx_count` 日志(或保留计数日志,择一;为简洁删除计数)。

- [ ] **Step 5: 删除 split_x224_frames 及调用**

删除 `split_x224_frames` 函数(约 563-616 行)。将 loop 内读到 PDU 后的调用:
```rust
let sub_frames = if action == ironrdp::pdu::Action::X224 {
    split_x224_frames(&payload)
} else {
    vec![payload.to_vec()]
};
let mut all_outputs = Vec::new();
// ...for sub_frame in &sub_frames { active_stage.process(...) }
```
替换为直接单帧处理:
```rust
let mut all_outputs = Vec::new();
match active_stage.process(&mut image, action, &payload) {
    Ok(outs) => all_outputs.extend(outs),
    Err(e) => {
        tracing::warn!("RDP process PDU error: {:?}", e);
        consecutive_errors += 1;
        if consecutive_errors > 10 {
            tracing::error!("RDP: too many consecutive PDU errors, aborting");
            break;
        }
    }
}
all_outputs
```
（`consecutive_errors = 0` 在成功读到 PDU 后重置,保留。）

- [ ] **Step 6: 编译确认**

Run: `cd src-tauri && cargo build 2>&1 | tail -30`
Expected: 编译成功。若报 `FramedRead`/`FramedWrite` trait 未导入或 `width()`/`height()` 方法不存在,按 API 事实修正导入路径。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/rdp_client.rs
git commit -m "fix(rdp): handle DeactivateAll reactivation to fix sheared display

Drive ConnectionActivationSequence to Finalized, rebuild DecodedImage at the
new size, update share_id, and notify the frontend via DesktopEvent::Resized.
Use data_for_rect for correct stride. Remove split_x224_frames hack.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 初次尺寸不匹配也发 Resized(防斜杠兜底)

若 `connection_result.desktop_size` 与请求的 config 尺寸不同,session loop 启动时立即发一次 `Resized`,保证前端 canvas 与实际一致。

**Files:**
- Modify: `src-tauri/src/rdp_client.rs`(`rdp_session_loop` 起始处)

**Interfaces:**
- Consumes: Task 2 `DesktopEvent`,Task 4 的 loop 结构。

- [ ] **Step 1: loop 前发送初始 Resized**

在 `rdp_session_loop` 中 `let mut active_stage = ActiveStage::new(connection_result);` 之后、主 loop 之前插入:

```rust
    // Ensure the frontend canvas matches the actually-negotiated size, which
    // may differ from the requested resolution (server alignment/clamping).
    let _ = event_tx.send(crate::desktop_protocol::DesktopEvent::Resized {
        width: desktop_size.width,
        height: desktop_size.height,
    });
```

（`desktop_size` 已在该函数取自 `connection_result.desktop_size`。）

- [ ] **Step 2: 编译确认**

Run: `cd src-tauri && cargo build 2>&1 | tail -15`
Expected: 编译成功。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/rdp_client.rs
git commit -m "fix(rdp): emit initial Resized to sync canvas with negotiated size

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 启用 DVC 通道 + resize 生效

注册 DisplayControl DVC 通道,让 `InputCommand::Resize` 调用 `encode_resize` 发真实 resize;不支持时前端回落 client-side 缩放(已有)。

**Files:**
- Modify: `src-tauri/Cargo.toml`(ironrdp features 加 `dvc`、`displaycontrol`、`input`)
- Modify: `src-tauri/src/rdp_client.rs`(`ClientConnector::new` 注册 DVC;`InputCommand::Resize` 走 encode_resize)

**Interfaces:**
- Consumes: Task 4 的整体 framed loop。
- Produces: resize 生效(或明确不支持)。

- [ ] **Step 1: 加 ironrdp features**

`src-tauri/Cargo.toml` 第 47 行改为:

```toml
ironrdp = { version = "0.16", features = ["connector", "session", "graphics", "dvc", "displaycontrol", "input"] }
```

- [ ] **Step 2: 注册 DVC 通道**

`rdp_connect_inner` 中两处 `ClientConnector::new(build_ironrdp_config(config), client_addr)`(主路径约 311 行 + native-tls 回退路径约 342 行)改为经 helper 注册 DVC:

```rust
fn new_connector(config: &RdpConfig, client_addr: SocketAddr) -> ClientConnector {
    use ironrdp::dvc::DrdynvcClient;
    use ironrdp::displaycontrol::client::DisplayControlClient;
    ClientConnector::new(build_ironrdp_config(config), client_addr).with_static_channel(
        DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_caps| Ok(Vec::new()))),
    )
}
```
两处 `ClientConnector::new(...)` 替换为 `new_connector(config, client_addr)`。

- [ ] **Step 3: Resize 走 encode_resize**

`rdp_session_loop` 的 input 分支当前把所有 cmd 交给 `handle_input_command`。改为先拦截 `Resize`:

在 `cmd = input_rx.recv()` 分支内,替换 `handle_input_command(&mut active_stage, &mut image, cmd)` 为:

```rust
                match cmd {
                    InputCommand::Resize { width, height } => {
                        use ironrdp::displaycontrol::pdu::MonitorLayoutEntry;
                        let (w, h) = MonitorLayoutEntry::adjust_display_size(width as u32, height as u32);
                        match active_stage.encode_resize(w, h, None, None) {
                            Some(Ok(frame)) => vec![ActiveStageOutput::ResponseFrame(frame)],
                            Some(Err(e)) => {
                                tracing::warn!("RDP encode_resize error: {:?}", e);
                                Vec::new()
                            }
                            None => {
                                tracing::info!("RDP resize: Display Control unavailable, client-side scaling");
                                Vec::new()
                            }
                        }
                    }
                    other => map_input_to_outputs(&mut active_stage, &mut image, other),
                }
```

其中 `map_input_to_outputs` 是把 Task 1 `rdp::input::map_input` 接到 `process_fastpath_input` 的薄封装。在 `rdp_client.rs` 新增:

```rust
fn map_input_to_outputs(
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    cmd: InputCommand,
) -> Vec<ActiveStageOutput> {
    let events = crate::rdp::input::map_input(&cmd);
    if events.is_empty() {
        return Vec::new();
    }
    active_stage
        .process_fastpath_input(image, &events)
        .unwrap_or_default()
}
```

并把 `rdp_client.rs` 里对 `InputCommand` 的引用改为 `use crate::rdp::input::InputCommand;`(删除本文件内旧的 `enum InputCommand` 定义,约 29-35 行,及旧 `handle_input_command`,约 770-863 行)。

- [ ] **Step 4: 编译确认**

Run: `cd src-tauri && cargo build 2>&1 | tail -30`
Expected: 编译成功。若 `ironrdp::dvc`/`ironrdp::displaycontrol` 路径不对,用 `cargo doc` 或 `grep` 确认 re-export 路径(meta crate 以 `ironrdp::dvc` / `ironrdp::displaycontrol` 暴露)。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/rdp_client.rs
git commit -m "feat(rdp): register Display Control DVC and make resize take effect

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 启用 NLA/CredSSP + 自动降级

默认 `enable_credssp: true`;CredSSP 相关错误时自动重连一次降级到 TLS-only。

**Files:**
- Modify: `src-tauri/src/rdp_client.rs`(`build_ironrdp_config` 加 credssp 参数;`rdp_connect_inner` 包降级)

**Interfaces:**
- Consumes: Task 6 的 `new_connector`。
- Produces: NLA 优先、失败降级。

- [ ] **Step 1: build_ironrdp_config 支持 credssp 开关**

把 `build_ironrdp_config(cfg: &RdpConfig)` 改为 `build_ironrdp_config(cfg: &RdpConfig, enable_credssp: bool)`,内部 `enable_credssp: false` 改为 `enable_credssp,`。同步 `new_connector` 加 `enable_credssp: bool` 参数并透传。所有调用点传入当前尝试的模式。

- [ ] **Step 2: rdp_connect_inner 包一层降级**

把现有 `rdp_connect_inner` 重命名为 `rdp_connect_attempt(config, input_rx, enable_credssp)`(返回类型不变),并新增外层:

```rust
async fn rdp_connect_inner(
    config: &RdpConfig,
    input_rx: mpsc::UnboundedReceiver<InputCommand>,
) -> Result<(
    ironrdp_tokio::TokioFramed<ErasedStream>,
    ConnectionResult,
    mpsc::UnboundedReceiver<InputCommand>,
)> {
    match rdp_connect_attempt(config, input_rx, true).await {
        Ok(v) => Ok(v),
        Err(e) if is_credssp_error(&e) => {
            tracing::warn!("RDP CredSSP/NLA failed ({}), falling back to TLS-only", e);
            // input_rx was consumed by the failed attempt; create a fresh pair
            // is not possible here, so rdp_connect_attempt must return the rx back on error.
            Err(e) // placeholder — see Step 3 for rx handling
        }
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 3: 让 attempt 在失败时归还 input_rx**

问题:`input_rx` 被首次 attempt 消费,降级重连需要它。解决:`rdp_connect_attempt` 的错误返回携带 `input_rx`。改其签名为返回 `Result<(...), (anyhow::Error, mpsc::UnboundedReceiver<InputCommand>)>`,成功仍返回三元组。外层:

```rust
async fn rdp_connect_inner(
    config: &RdpConfig,
    input_rx: mpsc::UnboundedReceiver<InputCommand>,
) -> Result<(
    ironrdp_tokio::TokioFramed<ErasedStream>,
    ConnectionResult,
    mpsc::UnboundedReceiver<InputCommand>,
)> {
    match rdp_connect_attempt(config, input_rx, true).await {
        Ok(v) => Ok(v),
        Err((e, rx)) if is_credssp_error(&e) => {
            tracing::warn!("RDP CredSSP/NLA failed ({}), retrying TLS-only", e);
            rdp_connect_attempt(config, rx, false)
                .await
                .map_err(|(e2, _rx)| anyhow::anyhow!("RDP connect failed (NLA: {}, TLS-only: {})", e, e2))
        }
        Err((e, _rx)) => Err(e),
    }
}

fn is_credssp_error(e: &anyhow::Error) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains("credssp") || s.contains("nla") || s.contains("access denied")
}
```

在 `rdp_connect_attempt` 内,把每个 `return Err(anyhow::anyhow!(...))` 改为 `return Err((anyhow::anyhow!(...), input_rx))`,`Ok(...)` 分支不变(input_rx 随成功返回)。注意 `input_rx` 需在 attempt 内保持所有权直到成功或失败返回——它当前只在末尾原样返回,不参与握手,故改动是机械的:所有早退 `Err` 点带上 `input_rx`。

- [ ] **Step 4: 编译确认**

Run: `cd src-tauri && cargo build 2>&1 | tail -30`
Expected: 编译成功。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/rdp_client.rs
git commit -m "feat(rdp): enable NLA/CredSSP with automatic TLS-only fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: 拆分 rdp_client.rs 到 rdp/ 模块

行为已定型,现做纯结构性拆分:把 connect/tls/session 逻辑移入 `rdp/` 子模块,消除 `SessionState`/`RdpThreadState` 重复。**不改行为。**

**Files:**
- Create: `src-tauri/src/rdp/connect.rs`(TCP/X.224/TLS/finalize/降级)
- Create: `src-tauri/src/rdp/tls.rs`(现有 OpenSSL + native-tls 升级,原样迁移)
- Create: `src-tauri/src/rdp/session.rs`(session loop + reactivation + 帧提取)
- Modify: `src-tauri/src/rdp/mod.rs`(RdpClient + DesktopProtocol impl,声明子模块)
- Delete: `src-tauri/src/rdp_client.rs`
- Modify: `src-tauri/src/lib.rs`(去掉 `mod rdp_client;`,`rdp` 已声明)
- Modify: 引用 `rdp_client::RdpClient` 的地方改为 `rdp::RdpClient`

- [ ] **Step 1: 定位 RdpClient 的外部引用**

Run: `cd src-tauri && grep -rn 'rdp_client' src/ | grep -v '/rdp/'`
Expected: 列出 `lib.rs`、`connection_manager.rs` 等。记下改成 `crate::rdp::RdpClient` 的点。

- [ ] **Step 2: 迁移 tls.rs**

把 `rdp_client.rs` 的 `tls_upgrade_openssl`、`tls_upgrade_native`、`AsyncReadWrite`/`ErasedStream` 定义移入 `rdp/tls.rs`,`pub(crate)` 导出。`rdp/mod.rs` 加 `mod tls;`。

- [ ] **Step 3: 迁移 connect.rs**

把 `rdp_connect_inner`/`rdp_connect_attempt`/`build_ironrdp_config`/`new_connector`/`is_credssp_error` 移入 `rdp/connect.rs`,`pub(crate)` 导出所需项。引用 tls 用 `use super::tls::*;`。

- [ ] **Step 4: 迁移 session.rs**

把 `rdp_session_loop`/`run_reactivation`/`map_input_to_outputs`/`SessionState` 移入 `rdp/session.rs`。删除 `RdpThreadState`,统一用 `SessionState`(字段相同,合并为一个)。

- [ ] **Step 5: mod.rs 保留 RdpClient**

`rdp/mod.rs` 保留 `RdpClient` struct、`connect`、`DesktopProtocol` impl,`pub mod input; mod tls; mod connect; mod session;`,用 `use self::...` 接线。`pub use` 导出 `RdpClient`。

- [ ] **Step 6: 删除旧文件、改引用**

删 `src-tauri/src/rdp_client.rs`;`lib.rs` 去掉 `mod rdp_client;`;把 Step 1 找到的 `crate::rdp_client::RdpClient` / `rdp_client::RdpClient` 改为 `crate::rdp::RdpClient`。

- [ ] **Step 7: 编译 + 单测**

Run: `cd src-tauri && cargo build 2>&1 | tail -20 && cargo test --lib rdp 2>&1 | tail -20`
Expected: 编译成功;Task 1 的 input 测试仍 PASS。

- [ ] **Step 8: Commit**

```bash
git add -A src-tauri/src/
git commit -m "refactor(rdp): split rdp_client into rdp/{connect,tls,session,input,mod}

Behavior-preserving module split; merge duplicated SessionState/RdpThreadState.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: 真机验证(192.168.20.180)+ 坐实点击根因

前面任务修的是尺寸/reactivation;点击根因需真机日志坐实。这一步跑起来看行为。

**Files:**
- 无代码改动(除非发现新根因,则回到相应任务)

- [ ] **Step 1: 启动 app(带日志)**

Run(后台):`RUST_LOG=info,ironrdp=debug pnpm tauri dev`(或项目既定启动方式;若不确定,先 `grep -n '"dev"\|tauri' package.json`)。
Expected: app 启动,WebSocket server 监听 9001。

- [ ] **Step 2: 跑 e2e**

Run: `pnpm playwright test tests/rdp-e2e.spec.ts 2>&1 | tail -40`
Expected:连接成功、canvas 可见且有非零尺寸。记录是否出现 `DeactivateAll`/`reactivation done`/`Resized` 日志。

- [ ] **Step 3: 观察斜杠是否消失**

手动连 192.168.20.180 或看 e2e 截图。确认画面不再斜切。若仍斜切,回到 systematic-debugging:检查日志里 reactivation 后的 `w/h` 与前端 canvas 尺寸是否一致。

- [ ] **Step 4: 坐实点击**

手动点击远端桌面元素,观察 `RUST_LOG` 中 `RDP pointer BUTTON` 与服务器响应。判断根因:
- 若点击现在生效 → reactivation 修复连带解决,记录并完成。
- 若仍无效 → 用日志确认是坐标错位、fast-path 被拒、还是 button transition 逻辑。据根因新建修复任务,**不猜**。

- [ ] **Step 5: 验证 resize**

改变窗口大小,观察是否触发 `desktop_resize` → `encode_resize` → 服务器 DeactivateAll → 新尺寸。或看到 "Display Control unavailable" 回落日志。二者之一即可。

- [ ] **Step 6: 记录验证结果**

把验证结论(斜杠、点击、resize 各自状态)如实写入 commit message 或 spec 末尾。若有未解项,明确标注未完成,不标 done。

---

## Task 10(收尾,条件性):TLS 单路化

**仅当 Task 9 中 rustls 能连上 192.168.20.180 时执行。** 否则保留现有双回退,跳过本任务并记录原因。

**Files:**
- Modify: `src-tauri/src/rdp/tls.rs`(改用 `ironrdp_tls` rustls 单路径)
- Modify: `src-tauri/src/rdp/connect.rs`(去掉 native-tls 回退分支)
- Modify: `src-tauri/Cargo.toml`(移除 `openssl`/`native-tls`/`tokio-native-tls`,确认无其它使用者)

- [ ] **Step 1: 先验证 rustls 可行性**

Run: `cd src-tauri && grep -rn 'openssl\|native_tls\|native-tls\|tokio_native_tls' src/ | grep -v '/rdp/tls.rs'`
Expected: 确认这些依赖仅被 tls.rs 使用。若有其它使用者,本任务范围需扩大或放弃。

- [ ] **Step 2: 用 ironrdp_tls 实现单路径**

用 `ironrdp_tls::upgrade`(rustls,已在依赖 `ironrdp-tls = { features = ["rustls"] }`)替换 `tls_upgrade_openssl`。删除 native-tls 回退与"断开重连重协商"分支,`rdp_connect_attempt` 的 TLS 段线性化。

- [ ] **Step 3: 真机再验证**

Run: `pnpm playwright test tests/rdp-e2e.spec.ts 2>&1 | tail -30`
Expected: 连接成功。若失败 → `git revert` 本任务,保留双回退,记录 rustls 不可行。

- [ ] **Step 4: 移除废弃依赖**

`Cargo.toml` 删 `openssl`/`native-tls`/`tokio-native-tls`/`tokio-openssl`(仅确认无其它使用者后)。Run: `cd src-tauri && cargo build 2>&1 | tail -20`。

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri/
git commit -m "refactor(rdp): single rustls TLS path, drop openssl/native-tls fallback

Verified against 192.168.20.180.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review 结果

**Spec 覆盖:**
- 模块拆分 → Task 8 ✓
- NLA + 自动降级 → Task 7 ✓
- Reactivation(斜杠核心)→ Task 4 ✓;初始尺寸兜底 → Task 5 ✓
- 动态 canvas 尺寸 → Task 2(通道)+ Task 3(前端)✓
- resize 生效(DVC)→ Task 6 ✓
- 帧提取用 data_for_rect → Task 4 Step 4 ✓
- 删 split_x224_frames / 合并结构体 → Task 4 Step 5 / Task 8 Step 4 ✓
- input 迁移 + 单测 → Task 1 ✓
- 点击根因坐实 → Task 9 Step 4 ✓
- TLS 单路化放最后、条件执行 → Task 10 ✓
- 真机 e2e 验证 → Task 9 ✓

**类型一致性:** `DesktopEvent`(Frame/Resized)、`event_tx`、`WsMessage::DesktopResized`、`map_input`、`InputCommand`、`new_connector`、`rdp_connect_attempt` 返回 `Result<_, (Error, Receiver)>` 在各任务间一致。

**Placeholder 扫描:** Task 7 Step 2 有一处标注 "placeholder — see Step 3",Step 3 给出了完整正确实现替代它——保留是为解释 rx 归还的推导过程,最终代码在 Step 3 完整给出,非交付占位。
