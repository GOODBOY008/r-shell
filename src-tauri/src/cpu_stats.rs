use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// Keep both snapshots in the existing CPU SSH request. Filter before sending
// so large interrupt counters in /proc/stat do not cross the connection.
pub const LINUX_CPU_COMMAND: &str = "awk '/^cpu([0-9]+)? /' /proc/stat || exit; sleep 0.5; printf '\\n---\\n'; awk '/^cpu([0-9]+)? /' /proc/stat";

// Stock macOS top exposes aggregate usage. Report its logical CPU count, but
// never invent per-CPU readings by copying the aggregate into every tile.
pub const MACOS_CPU_COMMAND: &str = r#"LC_ALL=C; export LC_ALL; top -l2 -s1 -n0 | awk '/CPU usage/{gsub(/%/,""); c=$7; found=1} END{if(found) print "total",100-c}'; printf 'count '; sysctl -n hw.logicalcpu"#;

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CpuCoreUsage {
    pub id: u32,
    pub percent: Option<f64>,
}

#[derive(Debug, Default)]
pub struct CpuStats {
    pub percent: Option<f64>,
    pub logical_count: Option<usize>,
    pub cores: Vec<CpuCoreUsage>,
}

#[derive(Clone, Copy)]
struct CpuTicks {
    total: u64,
    idle: u64,
}

impl CpuTicks {
    fn parse(fields: std::str::SplitWhitespace<'_>) -> Option<Self> {
        // guest/guest_nice are already included in user/nice. Only sum the
        // first eight counters, with at least the original four required.
        let ticks: Vec<u64> = fields
            .take(8)
            .map(str::parse)
            .collect::<Result<_, _>>()
            .ok()?;
        let idle = *ticks.get(3)?;
        let total = ticks.into_iter().try_fold(0_u64, u64::checked_add)?;
        Some(Self { total, idle })
    }

    fn usage_since(self, previous: Self) -> Option<f64> {
        let total = self.total.checked_sub(previous.total)?;
        let idle = self.idle.checked_sub(previous.idle)?;
        let busy = total.checked_sub(idle)?;
        if total == 0 {
            None
        } else {
            Some(busy as f64 / total as f64 * 100.0)
        }
    }
}

fn snapshot(output: &str) -> BTreeMap<Option<u32>, Option<CpuTicks>> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let name = fields.next()?;
            let id = if name == "cpu" {
                None
            } else {
                Some(name.strip_prefix("cpu")?.parse().ok()?)
            };
            Some((id, CpuTicks::parse(fields)))
        })
        .collect()
}

pub fn parse_cpu_stats(output: &str) -> CpuStats {
    if let Some((before, after)) = output.split_once("\n---\n") {
        let before = snapshot(before);
        let after = snapshot(after);
        let usage = |id: &Option<u32>, ticks: &Option<CpuTicks>| {
            ticks.as_ref()?.usage_since(*before.get(id)?.as_ref()?)
        };
        let cores: Vec<_> = after
            .iter()
            .filter_map(|(id, ticks)| {
                Some(CpuCoreUsage {
                    id: (*id)?,
                    percent: usage(id, ticks),
                })
            })
            .collect();
        CpuStats {
            percent: after.get(&None).and_then(|ticks| usage(&None, ticks)),
            logical_count: (!cores.is_empty()).then_some(cores.len()),
            cores,
        }
    } else {
        let mut stats = CpuStats::default();
        for line in output.lines() {
            let mut fields = line.split_whitespace();
            match (fields.next(), fields.next()) {
                (Some("total"), Some(value)) => {
                    stats.percent = value
                        .parse::<f64>()
                        .ok()
                        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value));
                }
                (Some("count"), Some(value)) => {
                    stats.logical_count = value.parse::<usize>().ok().filter(|value| *value > 0);
                }
                _ => {}
            }
        }
        stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_hot_and_idle_logical_cpus_without_changing_the_aggregate_scale() {
        let stats = parse_cpu_stats("cpu 100 0 0 100\ncpu0 100 0 0 0\ncpu1 0 0 0 100\n---\ncpu 200 0 0 200\ncpu0 200 0 0 0\ncpu1 0 0 0 200\n");
        assert_eq!(stats.percent, Some(50.0));
        assert_eq!(stats.logical_count, Some(2));
        assert_eq!(
            stats.cores,
            vec![
                CpuCoreUsage {
                    id: 0,
                    percent: Some(100.0)
                },
                CpuCoreUsage {
                    id: 1,
                    percent: Some(0.0)
                }
            ]
        );
    }

    #[test]
    fn ignores_guest_counters_already_included_in_user_and_nice() {
        let stats =
            parse_cpu_stats("cpu 100 0 0 100 0 0 0 0 50 0\n---\ncpu 150 0 0 150 0 0 0 0 100 0\n");
        assert_eq!(stats.percent, Some(50.0));
    }

    #[test]
    fn preserves_sparse_ids_and_handles_cpus_appearing_or_disappearing() {
        let stats = parse_cpu_stats("cpu0 0 0 0 10\ncpu2 0 0 0 10\ncpu10 0 0 0 10\n---\ncpu10 10 0 0 10\ncpu2 0 0 0 20\ncpu7 10 0 0 10\n");
        assert_eq!(stats.logical_count, Some(3));
        assert_eq!(
            stats.cores,
            vec![
                CpuCoreUsage {
                    id: 2,
                    percent: Some(0.0)
                },
                CpuCoreUsage {
                    id: 7,
                    percent: None
                },
                CpuCoreUsage {
                    id: 10,
                    percent: Some(100.0)
                }
            ]
        );
    }

    #[test]
    fn does_not_turn_missing_reset_or_zero_delta_counters_into_idle_readings() {
        for after in ["100 0 0 100", "1 0 0 1", "garbage", "150 0 0 50"] {
            let stats = parse_cpu_stats(&format!("cpu0 100 0 0 100\n---\ncpu0 {after}\n"));
            assert_eq!(
                stats.cores,
                vec![CpuCoreUsage {
                    id: 0,
                    percent: None
                }]
            );
        }
        assert_eq!(
            parse_cpu_stats("cpu0 100 0 0 100\n---\n").logical_count,
            None
        );
        assert!(parse_cpu_stats("cpu0 100 0 0 100\n").cores.is_empty());
    }

    #[test]
    fn macos_reports_count_without_fabricating_per_cpu_usage() {
        let stats = parse_cpu_stats("total 12.5\ncount 16\n");
        assert_eq!(stats.percent, Some(12.5));
        assert_eq!(stats.logical_count, Some(16));
        assert!(stats.cores.is_empty());
        let invalid = parse_cpu_stats("total NaN\ncount 0\n");
        assert_eq!(invalid.percent, None);
        assert_eq!(invalid.logical_count, None);
    }
}
