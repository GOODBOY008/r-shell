use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use tokio::sync::{Mutex, OnceCell};

/// Detected OS family of a remote host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OsFamily {
    /// Debian, Ubuntu, Linux Mint, Pop!_OS, etc.
    Debian,
    /// RHEL, CentOS, Fedora, Rocky, AlmaLinux, Amazon Linux, Oracle Linux
    RedHat,
    /// Alpine Linux (musl-based, BusyBox coreutils)
    Alpine,
    /// openSUSE, SLES
    Suse,
    /// Arch Linux, Manjaro
    Arch,
    /// Generic Linux — has /proc but we couldn't identify the family
    GenericLinux,
    /// macOS / Darwin
    MacOS,
    /// FreeBSD / OpenBSD / NetBSD
    Bsd,
    /// Completely unknown
    Unknown,
}

/// Cached information about a remote host's OS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsInfo {
    pub family: OsFamily,
    /// Raw ID from /etc/os-release (e.g. "ubuntu", "centos", "alpine")
    pub id: String,
    /// Human-readable name (e.g. "Ubuntu 22.04 LTS")
    pub pretty_name: String,
    /// Whether the `ss` command is available (vs only `netstat`)
    pub has_ss: bool,
    /// Whether `top` supports `-bn1` batch mode (BusyBox top uses `-bn1` too but output differs)
    pub has_procps_top: bool,
    /// Whether GNU coreutils are available (vs BusyBox)
    pub has_gnu_coreutils: bool,
}

impl Default for OsInfo {
    fn default() -> Self {
        Self {
            family: OsFamily::Unknown,
            id: String::new(),
            pretty_name: String::new(),
            has_ss: true,
            has_procps_top: true,
            has_gnu_coreutils: true,
        }
    }
}

/// Per-connection OS info cache.
///
/// Uses one `OnceCell` per connection so that concurrent callers share a
/// single in-flight detection rather than each spawning their own.
pub struct OsInfoCache {
    cells: Arc<Mutex<HashMap<String, Arc<OnceCell<OsInfo>>>>>,
}

impl OsInfoCache {
    pub fn new() -> Self {
        Self {
            cells: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Return the cached OS info, running `init` exactly once per connection.
    /// Concurrent callers for the same `connection_id` block until the first
    /// detection completes, then all receive the same cached result.
    pub async fn get_or_init<F, Fut>(&self, connection_id: &str, init: F) -> OsInfo
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = OsInfo>,
    {
        let cell = {
            let mut cells = self.cells.lock().await;
            cells
                .entry(connection_id.to_string())
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };
        cell.get_or_init(init).await.clone()
    }

    /// Remove cached info when a connection is closed.
    pub async fn remove(&self, connection_id: &str) {
        self.cells.lock().await.remove(connection_id);
    }
}

/// Detect the remote OS by running a lightweight probe command over SSH.
///
/// The detection runs a single compound command that reads /etc/os-release,
/// falls back to uname, and probes for tool availability — all in one
/// round-trip to minimise latency.
pub async fn detect_os(client: &crate::ssh::SshClient) -> OsInfo {
    // Single compound command — works on virtually every POSIX system.
    // We collect:
    //   1. ID and PRETTY_NAME from /etc/os-release
    //   2. uname -s as fallback kernel name
    //   3. Probe for ss, procps top, and GNU coreutils
    let probe = r#"
(
  # 1. /etc/os-release (present on all modern distros)
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "ID=${ID:-unknown}"
    echo "PRETTY_NAME=${PRETTY_NAME:-unknown}"
    echo "ID_LIKE=${ID_LIKE:-}"
  else
    echo "ID=unknown"
    echo "PRETTY_NAME=unknown"
    echo "ID_LIKE="
  fi

  # 2. Kernel name
  echo "UNAME=$(uname -s 2>/dev/null || echo unknown)"

  # 3. Tool probes
  command -v ss >/dev/null 2>&1 && echo "HAS_SS=1" || echo "HAS_SS=0"

  # procps-ng top prints "top -" in its version line; BusyBox prints "BusyBox"
  if top -v 2>&1 | head -1 | grep -qi busybox; then
    echo "HAS_PROCPS_TOP=0"
  else
    echo "HAS_PROCPS_TOP=1"
  fi

  # GNU ls supports --version; BusyBox does not
  if ls --version 2>&1 | head -1 | grep -qi 'GNU\|coreutils'; then
    echo "HAS_GNU_COREUTILS=1"
  else
    echo "HAS_GNU_COREUTILS=0"
  fi
)
"#;

    let output = match client.execute_command(probe).await {
        Ok(o) => o,
        Err(_) => return OsInfo::default(),
    };

    let mut id = String::new();
    let mut pretty_name = String::new();
    let mut id_like = String::new();
    let mut uname = String::new();
    let mut has_ss = true;
    let mut has_procps_top = true;
    let mut has_gnu_coreutils = true;

    for line in output.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("ID=") {
            id = val.trim_matches('"').to_lowercase();
        } else if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
            pretty_name = val.trim_matches('"').to_string();
        } else if let Some(val) = line.strip_prefix("ID_LIKE=") {
            id_like = val.trim_matches('"').to_lowercase();
        } else if let Some(val) = line.strip_prefix("UNAME=") {
            uname = val.to_lowercase();
        } else if let Some(val) = line.strip_prefix("HAS_SS=") {
            has_ss = val == "1";
        } else if let Some(val) = line.strip_prefix("HAS_PROCPS_TOP=") {
            has_procps_top = val == "1";
        } else if let Some(val) = line.strip_prefix("HAS_GNU_COREUTILS=") {
            has_gnu_coreutils = val == "1";
        }
    }

    let family = classify_family(&id, &id_like, &uname);

    OsInfo {
        family,
        id,
        pretty_name,
        has_ss,
        has_procps_top,
        has_gnu_coreutils,
    }
}

/// Classify the OS family from the ID, ID_LIKE, and uname fields.
fn classify_family(id: &str, id_like: &str, uname: &str) -> OsFamily {
    // Check ID first (exact match)
    match id {
        "debian" | "ubuntu" | "linuxmint" | "pop" | "elementary" | "zorin" | "kali"
        | "raspbian" | "deepin" | "kylin" => return OsFamily::Debian,

        "rhel" | "centos" | "fedora" | "rocky" | "almalinux" | "ol" | "amzn" | "scientific"
        | "eurolinux" | "anolis" | "openeuler" | "tencentos" | "alinux" => return OsFamily::RedHat,

        "alpine" => return OsFamily::Alpine,

        "opensuse-leap" | "opensuse-tumbleweed" | "sles" | "suse" => return OsFamily::Suse,

        "arch" | "manjaro" | "endeavouros" | "garuda" => return OsFamily::Arch,

        _ => {}
    }

    // Check ID_LIKE for derivative distros
    for token in id_like.split_whitespace() {
        match token {
            "debian" | "ubuntu" => return OsFamily::Debian,
            "rhel" | "fedora" | "centos" => return OsFamily::RedHat,
            "suse" | "opensuse" => return OsFamily::Suse,
            "arch" => return OsFamily::Arch,
            _ => {}
        }
    }

    // Fallback to uname
    match uname.as_ref() {
        "darwin" => OsFamily::MacOS,
        "freebsd" | "openbsd" | "netbsd" => OsFamily::Bsd,
        "linux" => OsFamily::GenericLinux,
        _ => OsFamily::Unknown,
    }
}

// ─── Distro-aware command builders ───────────────────────────────────────────

impl OsInfo {
    /// CPU usage percentage command.
    ///
    /// procps `top` (Debian/RHEL/Arch/SUSE) outputs `%Cpu(s): … id …`
    /// BusyBox `top` (Alpine) outputs `CPU:  X% usr  Y% sys … Z% idle`
    /// macOS uses `top -l2` with a different format.
    /// Fallback: read /proc/stat twice (works everywhere with /proc).
    pub fn cpu_cmd(&self) -> &'static str {
        match self.family {
            // `top -l1`'s only sample is an average since the previous
            // snapshot rather than an instantaneous reading, so idle sits at
            // ~0% and the result pins to 100%. `-l2 -s1` yields a second sample
            // measured over a real one-second window; the awk rule overwrites
            // `c` per line so the last one survives into END.
            OsFamily::MacOS => {
                "top -l2 -s1 -n0 | awk '/CPU usage/{gsub(/%/,\"\"); c=$7} END{print 100-c}'"
            }
            OsFamily::Alpine if !self.has_procps_top => {
                // BusyBox top: "CPU:   5% usr   2% sys   0% nic  92% idle ..."
                // Run one iteration in batch mode, extract idle%, compute 100-idle
                "top -bn1 2>/dev/null | awk '/^CPU:/{gsub(/%/,\"\"); for(i=1;i<=NF;i++) if($(i+1)==\"idle\") {print 100-$i; exit}}' || cat /proc/stat | awk '/^cpu /{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf \"%.1f\\n\", u*100/t}'"
            }
            _ => {
                // procps top or /proc/stat fallback
                "top -bn1 2>/dev/null | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}' || cat /proc/stat | awk '/^cpu /{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf \"%.1f\\n\", u*100/t}'"
            }
        }
    }

    /// Memory stats command — `free -m` is universal on Linux.
    /// macOS needs vm_stat + sysctl.
    pub fn memory_cmd(&self) -> &'static str {
        match self.family {
            // Activity Monitor's "Memory Used" is active + wired + compressor,
            // which is also what leaves total - used = cached files. Summing the
            // wrong buckets makes a busy Mac look idle, so the page size is
            // read from vm_stat's own header (4096 on Intel, 16384 on Apple
            // Silicon) rather than assumed, and the compressor is included.
            OsFamily::MacOS => {
                "vm_stat | awk 'NR==1{gsub(/[^0-9]/,\"\");p=$0} /^Pages free/{gsub(/\\./,\"\");fr=$NF} /^Pages (active|wired down|occupied by compressor)/{gsub(/\\./,\"\");u+=$NF} END{t='\"$(sysctl -n hw.memsize)\"'/1048576; used=u*p/1048576; free=fr*p/1048576; printf \"%d %d %d %d\", t, used, free, free}'"
            }
            _ => {
                "free -m 2>/dev/null | awk 'NR==2{printf \"%s %s %s %s\", $2,$3,$4,$7}' || awk '/MemTotal/{t=$2} /MemFree/{f=$2} /MemAvailable/{a=$2} /Buffers/{b=$2} /^Cached:/{c=$2} END{u=t-f-b-c; printf \"%d %d %d %d\", t/1024, u/1024, f/1024, a/1024}' /proc/meminfo"
            }
        }
    }

    /// Swap stats command.
    pub fn swap_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS => {
                "sysctl vm.swapusage 2>/dev/null | awk '{gsub(/M/,\"\"); printf \"%d %d %d\", $4, $7, $10}' || echo '0 0 0'"
            }
            _ => {
                "free -m 2>/dev/null | awk 'NR==3{printf \"%s %s %s\", $2,$3,$4}' || awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{printf \"%d %d %d\", t/1024, (t-f)/1024, f/1024}' /proc/meminfo"
            }
        }
    }

    /// Disk stats for root filesystem — `df -h` is universal.
    pub fn disk_cmd(&self) -> &'static str {
        // df -h / works on all POSIX systems. Column layout is consistent.
        "df -h / | awk 'NR==2{printf \"%s %s %s %s\", $2,$3,$4,$5}'"
    }

    /// Uptime command.
    ///
    /// `uptime -p` is a procps extension (not on BusyBox, old CentOS 6, macOS).
    /// Fallback: parse /proc/uptime or plain `uptime` output.
    pub fn uptime_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::Alpine if !self.has_gnu_coreutils => {
                "cat /proc/uptime 2>/dev/null | awk '{d=int($1/86400); h=int($1%86400/3600); m=int($1%3600/60); if(d>0) printf \"up %d day(s), %d:%02d\", d, h, m; else printf \"up %d:%02d\", h, m}' || uptime | sed 's/.*up /up /' | sed 's/,.*//' "
            }
            OsFamily::MacOS => {
                "uptime | sed 's/.*up /up /' | sed 's/,.*//' "
            }
            _ => {
                // Try uptime -p first (procps), fall back to /proc/uptime parsing
                "uptime -p 2>/dev/null || cat /proc/uptime 2>/dev/null | awk '{d=int($1/86400); h=int($1%86400/3600); m=int($1%3600/60); if(d>0) printf \"up %d day(s), %d:%02d\", d, h, m; else printf \"up %d:%02d\", h, m}' || uptime | sed 's/.*up /up /' | sed 's/,.*//' "
            }
        }
    }

    /// Load average command — works everywhere.
    pub fn load_average_cmd(&self) -> &'static str {
        "uptime | awk -F'load average:' '{print $2}' | xargs"
    }

    /// Process list command.
    ///
    /// `ps aux --sort` is a GNU/procps extension.
    /// BusyBox `ps` has a completely different output format.
    /// macOS `ps` supports `-r` (sort by CPU) and `-m` (sort by memory).
    pub fn process_cmd(&self, sort_by: &str) -> String {
        match self.family {
            OsFamily::MacOS => {
                let flag = if sort_by == "mem" { "-amx" } else { "-arx" };
                format!("ps {} -o user=,pid=,pcpu=,pmem=,command= | head -50", flag)
            }
            OsFamily::Alpine if !self.has_procps_top => {
                // BusyBox ps doesn't support --sort. Use ps + sort pipeline.
                let sort_col = if sort_by == "mem" { "4" } else { "3" };
                format!(
                    "ps aux 2>/dev/null | head -1; ps aux 2>/dev/null | tail -n +2 | sort -k{} -rn | head -49",
                    sort_col
                )
            }
            _ => {
                // procps ps with --sort (Debian, RHEL, Arch, SUSE, generic Linux)
                let sort_option = if sort_by == "mem" { "-%mem" } else { "-%cpu" };
                format!(
                    "ps aux --sort={} 2>/dev/null | head -50 || {{ ps aux 2>/dev/null | head -1; ps aux 2>/dev/null | tail -n +2 | sort -k{} -rn | head -49; }}",
                    sort_option,
                    if sort_by == "mem" { "4" } else { "3" }
                )
            }
        }
    }

    /// Disk usage details command.
    ///
    /// `df -hT` (show filesystem type) is a GNU extension.
    /// BusyBox and macOS `df` don't support `-T`.
    pub fn disk_usage_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS => {
                // macOS df -h output: Filesystem Size Used Avail Capacity iused ifree %iused Mounted
                "df -h | grep -v 'tmpfs\\|devfs\\|Filesystem\\|map ' | awk '{print $1\"|\"$9\"|\"$2\"|\"$3\"|\"$4\"|\"$5}' | head -10"
            }
            OsFamily::Alpine if !self.has_gnu_coreutils => {
                // BusyBox df: no -T flag. Output: Filesystem Size Used Available Use% Mounted
                "df -h 2>/dev/null | grep -v 'tmpfs\\|devtmpfs\\|Filesystem' | awk '{print $1\"|\"$6\"|\"$2\"|\"$3\"|\"$4\"|\"$5}' | head -10"
            }
            _ => {
                // GNU df -hT: Filesystem Type Size Used Avail Use% Mounted
                "df -hT 2>/dev/null | grep -v 'tmpfs\\|devtmpfs\\|Filesystem' | awk '{print $1\"|\"$7\"|\"$3\"|\"$4\"|\"$5\"|\"$6}' | head -10 || df -h 2>/dev/null | grep -v 'tmpfs\\|devtmpfs\\|Filesystem' | awk '{print $1\"|\"$6\"|\"$2\"|\"$3\"|\"$4\"|\"$5}' | head -10"
            }
        }
    }

    /// Network interface stats — /sys/class/net is Linux-only.
    /// macOS uses `netstat -ibn`.
    pub fn network_stats_cmd(&self) -> &'static str {
        match self.family {
            OsFamily::MacOS => {
                r#"netstat -ibn | awk 'NR>1 && $1!="lo" && $4!="" {print $1","$7","$10","$5","$8}'"#
            }
            _ => {
                // /sys/class/net works on all Linux distros (Debian, RHEL, Alpine, etc.)
                r#"
for iface in /sys/class/net/*; do
    name=$(basename $iface)
    if [ "$name" != "lo" ]; then
        rx_bytes=$(cat $iface/statistics/rx_bytes 2>/dev/null || echo 0)
        tx_bytes=$(cat $iface/statistics/tx_bytes 2>/dev/null || echo 0)
        rx_packets=$(cat $iface/statistics/rx_packets 2>/dev/null || echo 0)
        tx_packets=$(cat $iface/statistics/tx_packets 2>/dev/null || echo 0)
        echo "$name,$rx_bytes,$tx_bytes,$rx_packets,$tx_packets"
    fi
done
"#
            }
        }
    }

    /// Network bandwidth sampling command (two reads 1s apart).
    pub fn network_bandwidth_cmd(&self) -> &'static str {
        // Both variants emit two tagged snapshots ("1," then "2,") into a
        // single stream and let the final awk diff them, so the output is a
        // flat `name,rx_per_sec,tx_per_sec` list.
        //
        // The previous shape built a newline-separated interface list and then
        // looped over it with `for iface in $iface_list`. That relies on the
        // shell splitting an unquoted expansion on IFS, which zsh does not do
        // — and zsh is the default login shell for macOS SSH sessions. The
        // whole list was passed to `awk -v i=` as one multi-line string, awk
        // died with "newline in string", and macOS bandwidth silently read
        // 0 KB/s forever. Tagging inside awk keeps this independent of the
        // shell's word-splitting rules.
        match self.family {
            OsFamily::MacOS => {
                r#"
( netstat -ibn | awk 'NR>1 && $1!="lo0" && $4!="" && !seen[$1]++ {print "1,"$1","$7","$10}'
  sleep 1
  netstat -ibn | awk 'NR>1 && $1!="lo0" && $4!="" && !seen[$1]++ {print "2,"$1","$7","$10}' ) | awk -F, '$1=="1"{rx[$2]=$3;tx[$2]=$4;next} $1=="2"{d=$3-rx[$2];u=$4-tx[$2]; if(d<0)d=0; if(u<0)u=0; printf "%s,%.0f,%.0f\n",$2,d,u}'
"#
            }
            _ => {
                // /sys/class/net works on all Linux distros. ${d##*/} strips
                // the directory without needing `basename` or word splitting.
                r#"
( for d in /sys/class/net/*; do n=${d##*/}
    [ "$n" = lo ] || echo "1,$n,$(cat $d/statistics/rx_bytes 2>/dev/null||echo 0),$(cat $d/statistics/tx_bytes 2>/dev/null||echo 0)"
  done
  sleep 1
  for d in /sys/class/net/*; do n=${d##*/}
    [ "$n" = lo ] || echo "2,$n,$(cat $d/statistics/rx_bytes 2>/dev/null||echo 0),$(cat $d/statistics/tx_bytes 2>/dev/null||echo 0)"
  done ) | awk -F, '$1=="1"{rx[$2]=$3;tx[$2]=$4;next} $1=="2"{d=$3-rx[$2];u=$4-tx[$2]; if(d<0)d=0; if(u<0)u=0; printf "%s,%.0f,%.0f\n",$2,d,u}'
"#
            }
        }
    }

    /// Active network connections command.
    /// Prefers `ss` (modern), falls back to `netstat`.
    pub fn active_connections_cmd(&self) -> &'static str {
        if self.has_ss {
            "ss -tunp 2>/dev/null | tail -n +2 | head -50"
        } else {
            "netstat -tunp 2>/dev/null | tail -n +3 | head -50"
        }
    }

    /// List files command.
    /// GNU ls supports `--time-style=long-iso`; BusyBox and macOS do not.
    pub fn list_files_cmd(&self, path: &str) -> String {
        fn shell_quote(value: &str) -> String {
            format!("'{}'", value.replace('\'', "'\"'\"'"))
        }

        let quoted_path = shell_quote(path);
        if self.has_gnu_coreutils {
            format!("ls -la --time-style=long-iso {}", quoted_path)
        } else {
            // BusyBox / macOS ls — no --time-style, but -la still works
            format!("ls -la {}", quoted_path)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_debian() {
        assert_eq!(classify_family("ubuntu", "", "linux"), OsFamily::Debian);
        assert_eq!(classify_family("debian", "", "linux"), OsFamily::Debian);
        assert_eq!(
            classify_family("linuxmint", "ubuntu debian", "linux"),
            OsFamily::Debian
        );
    }

    #[test]
    fn test_classify_redhat() {
        assert_eq!(classify_family("centos", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("rhel", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("fedora", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("rocky", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("almalinux", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("amzn", "", "linux"), OsFamily::RedHat);
        assert_eq!(classify_family("ol", "", "linux"), OsFamily::RedHat);
    }

    #[test]
    fn test_classify_alpine() {
        assert_eq!(classify_family("alpine", "", "linux"), OsFamily::Alpine);
    }

    #[test]
    fn test_classify_suse() {
        assert_eq!(
            classify_family("opensuse-leap", "", "linux"),
            OsFamily::Suse
        );
        assert_eq!(classify_family("sles", "", "linux"), OsFamily::Suse);
    }

    #[test]
    fn test_classify_arch() {
        assert_eq!(classify_family("arch", "", "linux"), OsFamily::Arch);
        assert_eq!(classify_family("manjaro", "", "linux"), OsFamily::Arch);
    }

    #[test]
    fn test_classify_by_id_like() {
        assert_eq!(
            classify_family("pop", "ubuntu debian", "linux"),
            OsFamily::Debian
        );
        assert_eq!(
            classify_family("eurolinux", "rhel fedora centos", "linux"),
            OsFamily::RedHat
        );
    }

    #[test]
    fn test_classify_macos() {
        assert_eq!(classify_family("unknown", "", "darwin"), OsFamily::MacOS);
    }

    #[test]
    fn test_classify_unknown_linux() {
        assert_eq!(
            classify_family("unknown", "", "linux"),
            OsFamily::GenericLinux
        );
    }

    #[test]
    fn test_process_cmd_fallback() {
        let info = OsInfo {
            family: OsFamily::Alpine,
            has_procps_top: false,
            has_gnu_coreutils: false,
            ..Default::default()
        };
        let cmd = info.process_cmd("cpu");
        assert!(cmd.contains("sort -k3"));
    }

    #[test]
    fn test_disk_usage_cmd_gnu() {
        let info = OsInfo {
            family: OsFamily::Debian,
            has_gnu_coreutils: true,
            ..Default::default()
        };
        let cmd = info.disk_usage_cmd();
        assert!(cmd.contains("df -hT"));
    }

    #[test]
    fn test_disk_usage_cmd_busybox() {
        let info = OsInfo {
            family: OsFamily::Alpine,
            has_gnu_coreutils: false,
            ..Default::default()
        };
        let cmd = info.disk_usage_cmd();
        assert!(!cmd.starts_with("df -hT"));
    }

    #[test]
    fn test_list_files_gnu() {
        let info = OsInfo {
            has_gnu_coreutils: true,
            ..Default::default()
        };
        assert!(info.list_files_cmd("/tmp").contains("--time-style"));
    }

    #[test]
    fn test_list_files_busybox() {
        let info = OsInfo {
            has_gnu_coreutils: false,
            ..Default::default()
        };
        assert!(!info.list_files_cmd("/tmp").contains("--time-style"));
    }

    #[test]
    fn test_list_files_quotes_apostrophes() {
        let info = OsInfo {
            has_gnu_coreutils: true,
            ..Default::default()
        };

        assert_eq!(
            info.list_files_cmd("/tmp/dir's folder"),
            "ls -la --time-style=long-iso '/tmp/dir'\"'\"'s folder'"
        );
    }

    // Regression for #188: the macOS memory command parsed vm_stat with the
    // page size hardcoded to 4096 (Apple Silicon uses 16384), counted the
    // `Pages free` bucket as used, and ignored the compressor. It now reads
    // the page size from vm_stat's header and sums the same three buckets
    // Activity Monitor does.
    #[test]
    fn test_memory_cmd_macos_sums_the_activity_monitor_buckets() {
        let info = OsInfo {
            family: OsFamily::MacOS,
            ..Default::default()
        };
        let cmd = info.memory_cmd();
        assert!(cmd.contains("vm_stat"));
        // The compressor is most of the footprint on a memory-pressured Mac.
        assert!(cmd.contains("occupied by compressor"));
        // The page size must come from vm_stat, never be hardcoded.
        assert!(cmd.contains("NR==1"));
        assert!(!cmd.contains("4096"));
        // Free pages belong in their own accumulator, never in the `used` sum
        // — the old regex alternation included `free` in the used buckets.
        assert!(cmd.contains("/^Pages free/"));
        let used_buckets = cmd
            .split("^Pages (")
            .nth(1)
            .and_then(|rest| rest.split(')').next())
            .unwrap_or_default();
        assert!(
            !used_buckets.contains("free"),
            "free pages must not feed the used total: {used_buckets}"
        );
    }

    // Regression for #188: `top -l1`'s first sample is an average since the
    // previous snapshot, so idle sat at ~0% and the reading pinned to 100%.
    #[test]
    fn test_cpu_cmd_macos_takes_the_second_sample() {
        let info = OsInfo {
            family: OsFamily::MacOS,
            ..Default::default()
        };
        let cmd = info.cpu_cmd();
        assert!(cmd.contains("-l2"));
        assert!(!cmd.contains("-l1"));
    }

    #[test]
    fn test_memory_cmd_linux_uses_free() {
        let info = OsInfo {
            family: OsFamily::Debian,
            ..Default::default()
        };
        assert!(info.memory_cmd().starts_with("free -m"));
    }

    // Regression for #188: the bandwidth command iterated a newline-separated
    // interface list with `for iface in $iface_list`, which relies on the shell
    // splitting an unquoted expansion. zsh — the default login shell for macOS
    // SSH sessions — does not, so the entire list reached `awk -v i=` as one
    // multi-line string, awk aborted with "newline in string", and the card
    // read 0 KB/s on every macOS host.
    #[test]
    fn test_network_bandwidth_cmd_avoids_shell_word_splitting() {
        let macos = OsInfo {
            family: OsFamily::MacOS,
            ..Default::default()
        };
        let linux = OsInfo {
            family: OsFamily::Debian,
            ..Default::default()
        };

        for cmd in [macos.network_bandwidth_cmd(), linux.network_bandwidth_cmd()] {
            // No `for x in $var` — that is the construct zsh silently refuses
            // to split.
            assert!(!cmd.contains("for iface in $"));
            // The interface name is stripped with parameter expansion, which is
            // POSIX and behaves the same in every shell.
            assert!(!cmd.contains("iface_list"));
        }
    }

    // Both snapshots are tagged and diffed by the trailing awk, so the backend
    // receives a flat `interface,rx_per_sec,tx_per_sec` list.
    #[test]
    fn test_network_bandwidth_cmd_emits_tagged_snapshots() {
        for family in [OsFamily::MacOS, OsFamily::Debian] {
            let cmd = OsInfo {
                family: family.clone(),
                ..Default::default()
            }
            .network_bandwidth_cmd();
            assert!(cmd.contains(r#""1,"#), "{family:?} missing first tag");
            assert!(cmd.contains(r#""2,"#), "{family:?} missing second tag");
            // The pipe must close on the same line as the subshell, or the
            // shell treats `| awk` as a separate (invalid) command.
            assert!(cmd.contains(") | awk -F,"), "{family:?} pipe not attached");
        }
    }
}
