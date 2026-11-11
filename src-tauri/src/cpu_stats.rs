use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, ops::RangeInclusive};

// Keep both snapshots in the existing CPU SSH request. Filter before sending
// so large interrupt counters in /proc/stat do not cross the connection.
pub const LINUX_CPU_COMMAND: &str = r#"awk '/^cpu([0-9]+)? /' /proc/stat || exit
sleep 0.5
printf '\n---\n'
awk '/^cpu([0-9]+)? /' /proc/stat || exit
sh -c '
for kind in core atom lowpower; do
    if IFS= read -r ids 2>/dev/null < "/sys/bus/event_source/devices/cpu_${kind}/cpus"; then
        printf "pmu %s %s\n" "$kind" "$ids"
    fi
done
for file in /sys/devices/system/cpu/cpu[0-9]*/cpu_capacity; do
    if IFS= read -r capacity 2>/dev/null < "$file"; then
        dir=${file%/cpu_capacity}
        printf "capacity %s %s\n" "${dir##*/cpu}" "$capacity"
    fi
done
'"#;

// Stock macOS top only exposes aggregate usage. The named perf levels provide
// counts but don't tell us which CPU IDs belong to each group.
pub const MACOS_CPU_COMMAND: &str = r#"LC_ALL=C top -l2 -s1 -n0 | LC_ALL=C awk '/CPU usage/{gsub(/%/,""); c=$7; found=1} END{if(found) print "total",100-c}'
sysctl hw 2>/dev/null | awk '
    $1 == "hw.logicalcpu:" {print "count", $2}
    $1 == "hw.nperflevels:" {levels=$2}
    /^hw\.perflevel[0-9]+\.(name|logicalcpu):/ {
        split($1, key, ".")
        if (key[3] == "name:") names[key[2]]=$2
        else counts[key[2]]=$2
    }
    END {
        if (levels > 1) for (level in names)
            if (level in counts) print "group", names[level], counts[level]
    }'"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CpuCoreKind {
    Super,
    Performance,
    Intermediate,
    Efficiency,
    LowPowerEfficiency,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CpuCoreUsage {
    pub id: u32,
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<CpuCoreKind>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CpuCoreGroup {
    pub kind: CpuCoreKind,
    pub logical_count: usize,
}

#[derive(Debug, Default)]
pub struct CpuStats {
    pub percent: Option<f64>,
    pub logical_count: Option<usize>,
    pub cores: Vec<CpuCoreUsage>,
    pub core_groups: Vec<CpuCoreGroup>,
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

fn cpu_list(list: &str) -> Option<Vec<RangeInclusive<u32>>> {
    list.split(',')
        .map(|part| {
            let (first, last) = part.split_once('-').unwrap_or((part, part));
            let first = first.parse().ok()?;
            let last = last.parse().ok()?;
            (first <= last).then_some(first..=last)
        })
        .collect()
}

fn linux_core_kinds(output: &str, ids: &[u32]) -> BTreeMap<u32, CpuCoreKind> {
    let mut pmus = BTreeMap::new();
    let mut capacity = BTreeMap::new();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        match (fields.next(), fields.next(), fields.next()) {
            (Some("pmu"), Some(name), Some(list)) => {
                let kind = match name {
                    "core" => CpuCoreKind::Performance,
                    "atom" => CpuCoreKind::Efficiency,
                    "lowpower" => CpuCoreKind::LowPowerEfficiency,
                    _ => continue,
                };
                if let Some(ranges) = cpu_list(list) {
                    pmus.insert(kind, ranges);
                }
            }
            (Some("capacity"), Some(id), Some(value)) => {
                if let (Ok(id), Ok(value @ 1..)) = (id.parse::<u32>(), value.parse::<u32>()) {
                    capacity.insert(id, value);
                }
            }
            _ => {}
        }
    }

    // The Intel hybrid PMUs identify logical CPU IDs, including both SMT
    // siblings of a P-core. Do not infer membership from ID order.
    if pmus.len() >= 2 {
        return ids
            .iter()
            .filter_map(|id| {
                let mut matches = pmus
                    .iter()
                    .filter(|(_, ranges)| ranges.iter().any(|range| range.contains(id)));
                let (&kind, _) = matches.next()?;
                matches.next().is_none().then_some((*id, kind))
            })
            .collect();
    }

    // On systems such as Arm big.LITTLE, cpu_capacity is the kernel's
    // normalized maximum capacity, independent of the current clock/load.
    // Only compare tiers when all sampled IDs have a capacity.
    let Some(values) = ids
        .iter()
        .map(|id| capacity.get(id))
        .collect::<Option<Vec<_>>>()
    else {
        return BTreeMap::new();
    };
    let (Some(min), Some(max)) = (values.iter().min(), values.iter().max()) else {
        return BTreeMap::new();
    };
    if min == max {
        return BTreeMap::new();
    }
    ids.iter()
        .map(|id| {
            let value = &capacity[id];
            let kind = if value == *max {
                CpuCoreKind::Performance
            } else if value == *min {
                CpuCoreKind::Efficiency
            } else {
                CpuCoreKind::Intermediate
            };
            (*id, kind)
        })
        .collect()
}

pub fn parse_cpu_stats(output: &str) -> CpuStats {
    if let Some((before, after_output)) = output.split_once("\n---\n") {
        let before = snapshot(before);
        let after = snapshot(after_output);
        let ids: Vec<_> = after.keys().filter_map(|id| *id).collect();
        let kinds = linux_core_kinds(after_output, &ids);
        let mut counts = BTreeMap::new();
        for &kind in kinds.values() {
            *counts.entry(kind).or_default() += 1;
        }
        let usage = |id: &Option<u32>, ticks: &Option<CpuTicks>| {
            ticks.as_ref()?.usage_since(*before.get(id)?.as_ref()?)
        };
        let cores: Vec<_> = after
            .iter()
            .filter_map(|(id, ticks)| {
                let cpu_id = (*id)?;
                Some(CpuCoreUsage {
                    id: cpu_id,
                    percent: usage(id, ticks),
                    kind: kinds.get(&cpu_id).copied(),
                })
            })
            .collect();
        CpuStats {
            percent: after.get(&None).and_then(|ticks| usage(&None, ticks)),
            logical_count: (!cores.is_empty()).then_some(cores.len()),
            cores,
            core_groups: counts
                .into_iter()
                .map(|(kind, logical_count)| CpuCoreGroup {
                    kind,
                    logical_count,
                })
                .collect(),
        }
    } else {
        let mut stats = CpuStats::default();
        let mut groups = BTreeMap::new();
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
                (Some("group"), Some(name)) => {
                    // Read the name, not the rank: on M5 Pro/Max, level 1 is
                    // Performance, while level 0 is Super.
                    let kind = match name {
                        "Super" => CpuCoreKind::Super,
                        "Performance" => CpuCoreKind::Performance,
                        "Efficiency" => CpuCoreKind::Efficiency,
                        _ => continue,
                    };
                    if let Some(count) = fields
                        .next()
                        .and_then(|value| value.parse::<usize>().ok())
                        .filter(|value| *value > 0)
                    {
                        groups.insert(kind, count);
                    }
                }
                _ => {}
            }
        }
        stats.core_groups = groups
            .into_iter()
            .map(|(kind, logical_count)| CpuCoreGroup {
                kind,
                logical_count,
            })
            .collect();
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
                    percent: Some(100.0),
                    kind: None,
                },
                CpuCoreUsage {
                    id: 1,
                    percent: Some(0.0),
                    kind: None,
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
                    percent: Some(0.0),
                    kind: None,
                },
                CpuCoreUsage {
                    id: 7,
                    percent: None,
                    kind: None,
                },
                CpuCoreUsage {
                    id: 10,
                    percent: Some(100.0),
                    kind: None,
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
                    percent: None,
                    kind: None,
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

    #[test]
    fn intel_hybrid_matches_sparse_cpu_ids_to_pmu_lists() {
        let stats = parse_cpu_stats(concat!(
            "cpu0 0 0 0 10\ncpu3 0 0 0 10\ncpu8 0 0 0 10\ncpu9 0 0 0 10\n---\n",
            "cpu0 0 0 0 20\ncpu3 10 0 0 10\ncpu8 0 0 0 20\ncpu9 0 0 0 20\n",
            "pmu core 3,8-9\npmu atom 0,4-6\n",
        ));
        assert_eq!(
            stats
                .cores
                .iter()
                .map(|cpu| (cpu.id, cpu.kind))
                .collect::<Vec<_>>(),
            vec![
                (0, Some(CpuCoreKind::Efficiency)),
                (3, Some(CpuCoreKind::Performance)),
                (8, Some(CpuCoreKind::Performance)),
                (9, Some(CpuCoreKind::Performance)),
            ],
        );
        let three_types = parse_cpu_stats(concat!(
            "cpu0 0 0 0 10\ncpu1 0 0 0 10\ncpu2 0 0 0 10\ncpu3 0 0 0 10\n---\n",
            "cpu0 0 0 0 20\ncpu1 0 0 0 20\ncpu2 0 0 0 20\ncpu3 0 0 0 20\n",
            "pmu core 0\npmu atom 1,3\npmu lowpower 2-3\n",
        ));
        assert_eq!(
            three_types
                .cores
                .iter()
                .map(|cpu| cpu.kind)
                .collect::<Vec<_>>(),
            vec![
                Some(CpuCoreKind::Performance),
                Some(CpuCoreKind::Efficiency),
                Some(CpuCoreKind::LowPowerEfficiency),
                None
            ],
        );
        assert_eq!(
            stats.core_groups,
            vec![
                CpuCoreGroup {
                    kind: CpuCoreKind::Performance,
                    logical_count: 3
                },
                CpuCoreGroup {
                    kind: CpuCoreKind::Efficiency,
                    logical_count: 1
                },
            ]
        );
    }

    #[test]
    fn arm_capacity_distinguishes_tiers_only_with_complete_heterogeneous_data() {
        let ticks = "cpu0 0 0 0 10\ncpu2 0 0 0 10\ncpu4 0 0 0 10";
        let sample = format!("{ticks}\n---\n{ticks}\n");
        let stats = parse_cpu_stats(&format!(
            "{sample}capacity 0 512\ncapacity 2 1024\ncapacity 4 768\n"
        ));
        assert_eq!(
            stats.cores.iter().map(|cpu| cpu.kind).collect::<Vec<_>>(),
            vec![
                Some(CpuCoreKind::Efficiency),
                Some(CpuCoreKind::Performance),
                Some(CpuCoreKind::Intermediate)
            ],
        );
        for metadata in [
            "capacity 0 512\ncapacity 2 1024\n",
            "capacity 0 1024\ncapacity 2 1024\ncapacity 4 1024\n",
            "pmu core 0-4\npmu atom malformed\n",
        ] {
            let stats = parse_cpu_stats(&format!("{sample}{metadata}"));
            assert!(stats.core_groups.is_empty());
            assert!(stats.cores.iter().all(|cpu| cpu.kind.is_none()));
        }
    }

    #[test]
    fn macos_uses_named_groups_and_does_not_call_super_or_performance_cores_efficiency() {
        let stats = parse_cpu_stats("total 12.5\ncount 18\ngroup Super 6\ngroup Performance 12\n");
        assert_eq!(
            stats.core_groups,
            vec![
                CpuCoreGroup {
                    kind: CpuCoreKind::Super,
                    logical_count: 6
                },
                CpuCoreGroup {
                    kind: CpuCoreKind::Performance,
                    logical_count: 12
                },
            ]
        );
        assert_eq!(stats.logical_count, Some(18));
        assert!(stats.cores.is_empty());
    }
}
