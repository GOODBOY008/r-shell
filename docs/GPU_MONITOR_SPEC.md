# GPU Monitor Feature Specification

## Overview

Add NVIDIA and AMD GPU monitoring support to R-Shell's System Monitor panel. This feature will enable users to view real-time GPU metrics for remote servers with NVIDIA or AMD graphics cards.

## Current State

The existing system monitor ([system-monitor.tsx](../src/components/system-monitor.tsx)) provides:
- CPU usage monitoring
- Memory/Swap usage
- Disk usage
- Process list with kill functionality
- Network bandwidth monitoring
- Network latency monitoring

Backend commands in [commands.rs](../src-tauri/src/commands.rs) fetch metrics via SSH command execution.

## Feature Requirements

### 1. GPU Detection

**Priority:** High

Automatically detect available GPUs on the remote system:
- **NVIDIA**: Check for `nvidia-smi` binary availability
- **AMD**: Check for `rocm-smi` or `/sys/class/drm/card*/device/gpu_busy_percent`

```rust
// Detection command
"which nvidia-smi 2>/dev/null && echo 'nvidia' || (which rocm-smi 2>/dev/null && echo 'amd' || (test -f /sys/class/drm/card0/device/gpu_busy_percent && echo 'amd-sysfs'))"
```

### 2. NVIDIA GPU Metrics

**Priority:** High

Use `nvidia-smi` to fetch:

| Metric | Command | Description |
|--------|---------|-------------|
| GPU Utilization | `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits` | Core utilization % |
| Memory Used | `nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits` | VRAM used (MiB) |
| Memory Total | `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` | Total VRAM (MiB) |
| Temperature | `nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits` | GPU temp (°C) |
| Power Draw | `nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits` | Current power (W) |
| Power Limit | `nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits` | Power limit (W) |
| Fan Speed | `nvidia-smi --query-gpu=fan.speed --format=csv,noheader,nounits` | Fan speed % |
| GPU Name | `nvidia-smi --query-gpu=name --format=csv,noheader` | Model name |
| GPU Index | `nvidia-smi --query-gpu=index --format=csv,noheader` | GPU index (multi-GPU) |
| Driver Version | `nvidia-smi --query-gpu=driver_version --format=csv,noheader` | NVIDIA driver |
| CUDA Version | `nvidia-smi --query-gpu=cuda_version --format=csv,noheader` | CUDA version |
| Encoder Util | `nvidia-smi --query-gpu=utilization.encoder --format=csv,noheader,nounits` | NVENC usage % |
| Decoder Util | `nvidia-smi --query-gpu=utilization.decoder --format=csv,noheader,nounits` | NVDEC usage % |

**Optimized single command:**
```bash
nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,driver_version --format=csv,noheader,nounits
```

### 3. AMD GPU Metrics

**Priority:** High

#### Using `rocm-smi` (ROCm installed):
```bash
rocm-smi --showuse --showmemuse --showtemp --showpower --showfan --json
```

#### Using sysfs (fallback, no ROCm):
| Metric | Path |
|--------|------|
| GPU Utilization | `/sys/class/drm/card{N}/device/gpu_busy_percent` |
| VRAM Used | `/sys/class/drm/card{N}/device/mem_info_vram_used` |
| VRAM Total | `/sys/class/drm/card{N}/device/mem_info_vram_total` |
| Temperature | `/sys/class/drm/card{N}/device/hwmon/hwmon*/temp1_input` (millidegrees) |
| Power Draw | `/sys/class/drm/card{N}/device/hwmon/hwmon*/power1_average` (microwatts) |
| Fan Speed | `/sys/class/drm/card{N}/device/hwmon/hwmon*/fan1_input` (RPM) |
| Fan Max | `/sys/class/drm/card{N}/device/hwmon/hwmon*/fan1_max` (RPM) |

**Combined sysfs command:**
```bash
for card in /sys/class/drm/card[0-9]*; do
  if [ -f "$card/device/gpu_busy_percent" ]; then
    echo "card=$(basename $card)"
    cat "$card/device/gpu_busy_percent" 2>/dev/null || echo "0"
    cat "$card/device/mem_info_vram_used" 2>/dev/null || echo "0"
    cat "$card/device/mem_info_vram_total" 2>/dev/null || echo "0"
    hwmon=$(ls -d "$card/device/hwmon/hwmon"* 2>/dev/null | head -1)
    [ -n "$hwmon" ] && cat "$hwmon/temp1_input" 2>/dev/null || echo "0"
    [ -n "$hwmon" ] && cat "$hwmon/power1_average" 2>/dev/null || echo "0"
  fi
done
```

### 4. GPU Process Monitoring (Optional)

**Priority:** Medium

Show processes using GPU:

**NVIDIA:**
```bash
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits
```

**AMD (ROCm):**
```bash
rocm-smi --showpidgpus --json
```

---

## Data Structures

### Rust Backend Types

```rust
// src-tauri/src/commands.rs

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Unknown,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    pub vendor: GpuVendor,
    pub driver_version: Option<String>,
    pub cuda_version: Option<String>,  // NVIDIA only
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GpuStats {
    pub index: u32,
    pub name: String,
    pub vendor: GpuVendor,
    pub utilization: f64,           // GPU core usage %
    pub memory_used: u64,           // MiB
    pub memory_total: u64,          // MiB
    pub memory_percent: f64,        // Calculated
    pub temperature: Option<f64>,   // Celsius
    pub power_draw: Option<f64>,    // Watts
    pub power_limit: Option<f64>,   // Watts
    pub fan_speed: Option<f64>,     // % or RPM
    pub encoder_util: Option<f64>,  // NVIDIA NVENC %
    pub decoder_util: Option<f64>,  // NVIDIA NVDEC %
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GpuDetectionResult {
    pub available: bool,
    pub vendor: GpuVendor,
    pub gpus: Vec<GpuInfo>,
    pub detection_method: String,   // "nvidia-smi", "rocm-smi", "sysfs"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GpuProcess {
    pub pid: u32,
    pub name: String,
    pub gpu_index: u32,
    pub memory_used: u64,  // MiB
}
```

### TypeScript Frontend Types

```typescript
// src/components/system-monitor.tsx

type GpuVendor = 'nvidia' | 'amd' | 'unknown';

interface GpuInfo {
  index: number;
  name: string;
  vendor: GpuVendor;
  driverVersion?: string;
  cudaVersion?: string;
}

interface GpuStats {
  index: number;
  name: string;
  vendor: GpuVendor;
  utilization: number;
  memoryUsed: number;      // MiB
  memoryTotal: number;     // MiB
  memoryPercent: number;
  temperature?: number;    // Celsius
  powerDraw?: number;      // Watts
  powerLimit?: number;     // Watts
  fanSpeed?: number;       // %
  encoderUtil?: number;    // %
  decoderUtil?: number;    // %
}

interface GpuDetectionResult {
  available: boolean;
  vendor: GpuVendor;
  gpus: GpuInfo[];
  detectionMethod: string;
}

interface GpuHistoryData {
  time: string;
  utilization: number;
  memory: number;
  temperature?: number;
  timestamp: number;
}
```

---

## Tauri Commands

### 1. `detect_gpu`

Detect available GPUs on the remote system.

```rust
#[tauri::command]
pub async fn detect_gpu(
    session_id: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<GpuDetectionResult, String>
```

**Returns:** `GpuDetectionResult` with available GPUs and detection method.

### 2. `get_gpu_stats`

Fetch current GPU metrics.

```rust
#[tauri::command]
pub async fn get_gpu_stats(
    session_id: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<Vec<GpuStats>, String>
```

**Returns:** Array of `GpuStats` for each GPU.

### 3. `get_gpu_processes` (Optional)

Fetch processes using GPU.

```rust
#[tauri::command]
pub async fn get_gpu_processes(
    session_id: String,
    state: State<'_, Arc<SessionManager>>,
) -> Result<Vec<GpuProcess>, String>
```

---

## UI Design

### GPU Section Layout

Add a new collapsible section in `SystemMonitor` after the "System Overview" section:

```
┌─────────────────────────────────────┐
│ 🎮 GPU Monitor                      │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ [GPU 0] NVIDIA RTX 4090         │ │
│ │                                 │ │
│ │ GPU Utilization     ███████ 75% │ │
│ │ Memory  20GB/24GB   ███████ 83% │ │
│ │ Temperature              72°C   │ │
│ │ Power           320W / 450W     │ │
│ │ Fan Speed                  65%  │ │
│ │ Encoder                    12%  │ │
│ │ Decoder                     0%  │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ GPU Usage History              │ │
│ │ [Area Chart: util + memory]    │ │
│ │ ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▂▃▄▅          │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ Temperature History            │ │
│ │ [Line Chart]                   │ │
│ │ ────────────────────────        │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### Multi-GPU Support

For systems with multiple GPUs, display:
- Tabs or dropdown to switch between GPUs
- Summary view showing all GPUs at a glance

### No GPU State

When no GPU is detected:
```
┌─────────────────────────────────────┐
│ 🎮 GPU Monitor                      │
├─────────────────────────────────────┤
│ No GPU detected or drivers not      │
│ installed on the remote system.     │
│                                     │
│ Supported GPUs:                     │
│ • NVIDIA (requires nvidia-smi)      │
│ • AMD (requires rocm-smi or sysfs)  │
└─────────────────────────────────────┘
```

### Color Coding

Use existing color utilities with GPU-specific thresholds:

| Metric | Green | Yellow | Orange | Red |
|--------|-------|--------|--------|-----|
| GPU Utilization | <50% | 50-75% | 75-90% | >90% |
| Memory Usage | <50% | 50-75% | 75-90% | >90% |
| Temperature | <60°C | 60-75°C | 75-85°C | >85°C |
| Fan Speed | <50% | 50-70% | 70-85% | >85% |

---

## Implementation Plan

### Phase 1: Backend (Rust)

1. **Add data structures** to `commands.rs`
2. **Implement `detect_gpu` command**
   - Check for nvidia-smi
   - Check for rocm-smi
   - Fallback to sysfs for AMD
3. **Implement `get_gpu_stats` command**
   - NVIDIA parsing logic
   - AMD ROCm parsing logic  
   - AMD sysfs fallback parsing
4. **Add commands to `lib.rs`** invoke_handler
5. **Write unit tests** for parsing logic

### Phase 2: Frontend (React)

1. **Add TypeScript interfaces** in `system-monitor.tsx`
2. **Add GPU detection state** (runs once per session)
3. **Add GPU stats fetching** with polling interval (5-10 seconds)
4. **Create GPU card component** with:
   - Utilization progress bar
   - Memory progress bar
   - Temperature display with icon
   - Power draw display
   - Fan speed display
5. **Add GPU usage history chart** (Area chart similar to network)
6. **Add temperature history chart** (Line chart)
7. **Handle no-GPU and error states**
8. **Add GPU icon** (use lucide-react `Gpu` or custom SVG)

### Phase 3: Polish

1. **Add collapsible section** for GPU monitor
2. **Implement multi-GPU tabs/selector**
3. **Add tooltips** for detailed info
4. **Performance optimization**
   - Use `requestIdleCallback` for fetches
   - Cache detection results per session
5. **Add loading skeleton** while fetching
6. **Write E2E tests**

---

## Polling Strategy

| Data Type | Interval | Callback |
|-----------|----------|----------|
| GPU Detection | Once per session connect | `fetchGpuDetection()` |
| GPU Stats | 5 seconds | `requestIdleCallback(() => fetchGpuStats())` |
| GPU Processes | 15 seconds (optional) | `requestIdleCallback(() => fetchGpuProcesses())` |

---

## Error Handling

### SSH Command Failures
- Log error to console
- Display "Unable to fetch GPU stats" in UI
- Retry on next interval

### No nvidia-smi/rocm-smi
- Set `available: false` in detection
- Show informative message about requirements

### Partial Data
- Display available metrics
- Show "N/A" for unavailable fields
- Don't fail entire request for missing optional fields

---

## Testing

### Unit Tests (Rust)
- Test NVIDIA output parsing with various formats
- Test AMD rocm-smi JSON parsing
- Test AMD sysfs value parsing
- Test multi-GPU output parsing
- Test edge cases (N/A values, missing fields)

### Integration Tests
- Test with mock SSH responses
- Test detection flow
- Test periodic fetching

### Manual Testing
- Test on system with NVIDIA GPU
- Test on system with AMD GPU  
- Test on system with multiple GPUs
- Test on system with no GPU
- Test with different driver versions

---

## Future Enhancements

1. **GPU Process List** - Show which processes are using GPU
2. **GPU Memory Graph** - Detailed VRAM breakdown
3. **Power Efficiency Metrics** - Performance per watt
4. **Alerts** - Temperature/utilization warnings
5. **Historical Export** - Export GPU metrics to CSV
6. **CUDA/ROCm Info** - Compute capability, libraries

---

## Dependencies

### No new dependencies required

- Uses existing SSH command execution infrastructure
- Uses existing charting library (recharts)
- Uses existing UI components (Card, Progress, Badge)
- Uses existing lucide-react icons

---

## File Changes Summary

| File | Changes |
|------|---------|
| `src-tauri/src/commands.rs` | Add GPU structs and commands |
| `src-tauri/src/lib.rs` | Register new commands |
| `src/components/system-monitor.tsx` | Add GPU monitoring section |

---

## Estimated Effort

| Phase | Estimated Time |
|-------|----------------|
| Phase 1: Backend | 4-6 hours |
| Phase 2: Frontend | 4-6 hours |
| Phase 3: Polish | 2-3 hours |
| Testing | 2-3 hours |
| **Total** | **12-18 hours** |

---

## References

- [NVIDIA SMI Documentation](https://developer.nvidia.com/nvidia-system-management-interface)
- [ROCm SMI Documentation](https://rocmdocs.amd.com/en/latest/ROCm_Tools/ROCm-SMI.html)
- [Linux Kernel GPU sysfs Interface](https://www.kernel.org/doc/html/latest/gpu/amdgpu/driver-misc.html)
