//! Parser for `ls -l`-style directory listings.
//!
//! Supports the formats emitted by the major `ls` implementations we encounter
//! when browsing remote filesystems:
//!
//! | Source | Time column | Example |
//! |--------|-------------|---------|
//! | GNU coreutils (`--time-style=long-iso`) | `YYYY-MM-DD HH:MM` (2 tokens) | `drwxr-xr-x 5 root root 4096 2025-01-15 12:32 dev` |
//! | BusyBox / BSD / default `ls` (recent file) | `Mon DD HH:MM` (3 tokens) | `drwxr-xr-x 5 root root 4096 Jan 15 12:32 dev` |
//! | BusyBox / BSD / default `ls` (older file) | `Mon DD YYYY` (3 tokens) | `-rw-r--r-- 1 root root 85234 Nov 09 2000 gamelist.xml` |
//!
//! Plus the common real-world variants:
//!   - ACL (`+`) or SELinux-context (`.`) suffix on the perms token
//!   - Optional `group` column (busybox-embedded listings sometimes omit it)
//!   - Numeric or symbolic `owner` / `group`
//!   - SELinux security context as an extra column
//!   - Symlink targets (`name -> target`)
//!
//! The parser is column-count agnostic: it locates the date field by pattern
//! and treats everything to its right as the filename, so adding or removing
//! an owner/group/context column does not corrupt the result.
//!
//! `owner`/`group` are extracted from the fixed left-hand columns
//! (`perms links owner group [context] size`): owner is always token 2, and
//! group is token 3 whenever the size token sits at index 3 or later (absent
//! in the no-group BusyBox variant).

use crate::sftp_client::{FileEntry, FileEntryType};

/// Parse a single line from an `ls -l`-style listing into a [`FileEntry`].
///
/// Returns `None` for blank lines, `total NNN` summary lines, or lines that
/// don't match any recognised layout.
pub fn parse_ls_long_line(line: &str) -> Option<FileEntry> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let tokens: Vec<&str> = line.split_whitespace().collect();

    // `ls -l` emits a "total NNN" summary as its first line — never a file entry.
    if tokens.len() >= 2 && tokens[0].eq_ignore_ascii_case("total") {
        return None;
    }

    // Must start with a perms-like token (`d`/`l`/`-` + 9 rwx/- chars, optional `+`/`.`).
    let perms_str = tokens.first()?;
    if !is_perms_token(perms_str) {
        return None;
    }

    let file_type = if perms_str.starts_with('d') {
        FileEntryType::Directory
    } else if perms_str.starts_with('l') {
        FileEntryType::Symlink
    } else {
        FileEntryType::File
    };

    // Locate the date field and figure out how many trailing tokens belong to it.
    // `date_len` is the number of tokens occupied by the date/time columns.
    let (date_start, date_len, modified) = locate_date(&tokens)?;

    // Name is everything after the date columns (preserves embedded spaces).
    let name_end = date_start + date_len;
    if name_end >= tokens.len() {
        return None;
    }
    let name_raw = tokens[name_end..].join(" ");
    // For symlinks, strip the " -> target" suffix.
    let name = if matches!(file_type, FileEntryType::Symlink) {
        name_raw
            .split(" -> ")
            .next()
            .unwrap_or(&name_raw)
            .to_string()
    } else {
        name_raw
    };

    if name.is_empty() || name == "." || name == ".." {
        // Caller filters `.`/`..` too, but be defensive.
        if name == "." || name == ".." {
            return None;
        }
        return None;
    }

    // Size is the rightmost numeric token strictly left of the date columns.
    // Record its index too so owner/group can be read relative to it.
    let size_idx = tokens[..date_start]
        .iter()
        .rposition(|t| t.parse::<u64>().is_ok());
    let size = size_idx
        .and_then(|i| tokens[i].parse::<u64>().ok())
        .unwrap_or(0);

    // Owner/group: `ls -l` lays out `perms links owner group [context] size`.
    // Owner is always the 3rd column; group is the 4th — when the size lands at
    // index 3 the group column is absent (busybox-embedded variants), and when
    // it lands at index 4+ a SELinux context column sits between group and size.
    let owner = tokens.get(2).map(|s| s.to_string());
    let group = match size_idx {
        Some(i) if i > 3 => tokens.get(3).map(|s| s.to_string()),
        _ => None,
    };

    Some(FileEntry {
        name,
        size,
        modified,
        permissions: Some(perms_str.to_string()),
        file_type,
        owner,
        group,
    })
}

/// True for a Unix permission string like `drwxr-xr-x`, `-rw-r--r--`,
/// `lrwxrwxrwx`, optionally with an ACL (`+`) or SELinux-context (`.`) suffix.
fn is_perms_token(s: &str) -> bool {
    // Bare perms are 10 chars: 1 type char (`d`/`l`/`-`) + 9 rwx/- chars.
    // An ACL (`+`) or SELinux-context (`.`) suffix adds one more char → 11.
    let bytes = s.as_bytes();
    let body_len = bytes.len();
    if !(10..=11).contains(&body_len) {
        return false;
    }
    if !matches!(bytes[0], b'd' | b'l' | b'-') {
        return false;
    }
    // Positions 1..=9 (9 chars) must all be r/w/x/-.
    bytes[1..10]
        .iter()
        .all(|&b| matches!(b, b'r' | b'w' | b'x' | b'-'))
}

/// Locate the date columns inside `tokens` and return
/// `(start_index, token_count, parsed_modified_string)`.
///
/// Tries the GNU long-iso layout first (`YYYY-MM-DD` followed by `HH:MM`),
/// then the BusyBox/BSD layout (`Mon DD HH:MM` or `Mon DD YYYY`).
fn locate_date(tokens: &[&str]) -> Option<(usize, usize, Option<String>)> {
    if let Some(idx) = find_long_iso_date(tokens) {
        // GNU long-iso: date(1) + time(1) = 2 tokens, then filename.
        let date_str = tokens[idx];
        let time_str = tokens[idx + 1];
        Some((idx, 2, Some(format!("{} {}", date_str, time_str))))
    } else if let Some(idx) = find_month_date(tokens) {
        // BusyBox/BSD: month + day + time_or_year = 3 tokens, then filename.
        let month = tokens[idx];
        let day = tokens[idx + 1];
        let time_or_year = tokens[idx + 2];
        Some((idx, 3, parse_month_style_date(month, day, time_or_year)))
    } else {
        None
    }
}

/// Find a GNU long-iso date pair (`YYYY-MM-DD` at `i`, `HH:MM` at `i+1`).
fn find_long_iso_date(tokens: &[&str]) -> Option<usize> {
    // Need at least: [.., date, time, name] → 1 token after the pair.
    let upper = tokens.len().saturating_sub(2);
    (0..upper).find(|&i| {
        is_long_iso_date(tokens[i]) && is_hh_mm(tokens.get(i + 1).copied())
    })
}

/// Find a BusyBox/BSD date triple (`Mon` at `i`, day at `i+1`, time/year at `i+2`).
fn find_month_date(tokens: &[&str]) -> Option<usize> {
    let upper = tokens.len().saturating_sub(3);
    (0..upper).find(|&i| {
        is_month_abbr(tokens[i])
            && is_day_token(tokens.get(i + 1).copied())
            && is_time_or_year_token(tokens.get(i + 2).copied())
    })
}

fn is_long_iso_date(s: &str) -> bool {
    // `YYYY-MM-DD` — 10 chars: 4 digits, '-', 2 digits, '-', 2 digits.
    let bytes = s.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes[0..4].iter().all(|b| b.is_ascii_digit())
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(|b| b.is_ascii_digit())
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(|b| b.is_ascii_digit())
}

fn is_hh_mm(s: Option<&str>) -> bool {
    let Some(s) = s else { return false };
    let bytes = s.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    bytes[0..2].iter().all(|b| b.is_ascii_digit())
        && bytes[3..5].iter().all(|b| b.is_ascii_digit())
}

fn is_month_abbr(s: &str) -> bool {
    matches!(
        s,
        "Jan"
            | "Feb"
            | "Mar"
            | "Apr"
            | "May"
            | "Jun"
            | "Jul"
            | "Aug"
            | "Sep"
            | "Oct"
            | "Nov"
            | "Dec"
    )
}

fn is_day_token(s: Option<&str>) -> bool {
    let Some(s) = s else { return false };
    s.trim_end_matches(|c: char| !c.is_ascii_digit())
        .parse::<u32>()
        .map(|d| (1..=31).contains(&d))
        .unwrap_or(false)
}

fn is_time_or_year_token(s: Option<&str>) -> bool {
    let Some(s) = s else { return false };
    if s.contains(':') {
        // HH:MM
        let parts: Vec<&str> = s.split(':').collect();
        parts.len() == 2
            && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    } else {
        // YYYY — 4-digit year.
        s.len() == 4 && s.bytes().all(|b| b.is_ascii_digit())
    }
}

/// Convert a BusyBox/BSD date triple (`Mon DD HH:MM` or `Mon DD YYYY`) into an
/// ISO-style `"YYYY-MM-DD HH:MM:SS"` string. Returns `None` if the month is
/// unrecognised. For recent files (`HH:MM`), the current year is used because
/// `ls` deliberately omits it.
fn parse_month_style_date(month: &str, day: &str, time_or_year: &str) -> Option<String> {
    let month_num = match month {
        "Jan" => 1u32,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let day: u32 = day.parse().unwrap_or(1);

    if time_or_year.contains(':') {
        // Recent file: "HH:MM" — use current year, seconds = 00.
        let parts: Vec<&str> = time_or_year.splitn(2, ':').collect();
        let hh: u32 = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
        let mm: u32 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let current_year = current_year();
        Some(format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:00",
            current_year, month_num, day, hh, mm
        ))
    } else {
        // Older file: "YYYY" — time is 00:00:00.
        let year: u32 = time_or_year.parse().unwrap_or(1970);
        Some(format!("{:04}-{:02}-{:02} 00:00:00", year, month_num, day))
    }
}

fn current_year() -> u32 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = now / 86400;
    let mut y = 1970i64;
    let mut rem = days as i64;
    loop {
        let dy = if is_leap_year(y) { 366 } else { 365 };
        if rem < dy {
            break;
        }
        rem -= dy;
        y += 1;
    }
    y as u32
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

// =============================================================================
// Unit tests
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    // ---- GNU long-iso format (SSH with --time-style=long-iso) ----

    #[test]
    fn test_gnu_long_iso_directory() {
        let line = "drwxr-xr-x  5 root root  4096 2025-01-15 12:32 dev";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "dev");
        assert!(matches!(entry.file_type, FileEntryType::Directory));
        assert_eq!(entry.size, 4096);
        assert_eq!(entry.modified.as_deref(), Some("2025-01-15 12:32"));
        assert_eq!(entry.permissions.as_deref(), Some("drwxr-xr-x"));
        assert_eq!(entry.owner.as_deref(), Some("root"));
        assert_eq!(entry.group.as_deref(), Some("root"));
    }

    #[test]
    fn test_gnu_long_iso_file() {
        let line = "-rw-r--r--  1 root root 85234 2000-11-09 00:00 gamelist.xml";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "gamelist.xml");
        assert!(matches!(entry.file_type, FileEntryType::File));
        assert_eq!(entry.size, 85234);
        assert_eq!(entry.modified.as_deref(), Some("2000-11-09 00:00"));
    }

    #[test]
    fn test_gnu_long_iso_name_with_spaces() {
        let line = "-rw-r--r--  1 root root  100 2024-12-25 23:59 my report.pdf";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "my report.pdf");
        assert_eq!(entry.size, 100);
        assert_eq!(entry.modified.as_deref(), Some("2024-12-25 23:59"));
    }

    #[test]
    fn test_gnu_long_iso_symlink() {
        let line = "lrwxrwxrwx  1 root root    10 2024-03-01 09:00 link -> target";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "link");
        assert!(matches!(entry.file_type, FileEntryType::Symlink));
    }

    // ---- BusyBox / default ls format (SSH without --time-style) ----

    #[test]
    fn test_busybox_recent_directory() {
        // The exact line that produced the user-reported "12:32 dev" bug.
        let line = "drwxr-xr-x  5 root root  4096 Jan 15 12:32 dev";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "dev");
        assert!(matches!(entry.file_type, FileEntryType::Directory));
        assert_eq!(entry.size, 4096);
        // Recent file → current year, time preserved.
        assert!(
            entry.modified.as_deref().unwrap_or("").ends_with("-01-15 12:32:00"),
            "modified should preserve Jan 15 12:32, got: {:?}",
            entry.modified
        );
    }

    #[test]
    fn test_busybox_recent_file() {
        let line = "drwxr-xr-x  2 root root  4096 Jul 25 12:46 Pacman";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "Pacman");
        assert_eq!(entry.size, 4096);
    }

    #[test]
    fn test_busybox_old_file_year() {
        // Older file → year shown instead of time.
        let line = "-rw-r--r--  1 root root 85234 Nov  9  2000 gamelist.xml";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "gamelist.xml");
        assert_eq!(entry.size, 85234);
        assert_eq!(entry.modified.as_deref(), Some("2000-11-09 00:00:00"));
    }

    #[test]
    fn test_busybox_padded_day_double_space() {
        // GNU/BSD pad single-digit days with a leading space → two spaces in output.
        let line = "-rw-r--r-- 1 root root 85234 Nov 09  2000 gamelist.xml";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "gamelist.xml");
        assert_eq!(entry.modified.as_deref(), Some("2000-11-09 00:00:00"));
    }

    // ---- Real-world column variants ----

    #[test]
    fn test_no_group_column_busybox() {
        // Embedded BusyBox sometimes omits the group column entirely.
        let line = "-rw-r--r-- 1 root 85234 Jan 15 12:32 gamelist.xml";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "gamelist.xml");
        assert_eq!(entry.size, 85234);
        assert!(entry.modified.is_some());
        // No group column → owner parsed, group left as None.
        assert_eq!(entry.owner.as_deref(), Some("root"));
        assert_eq!(entry.group, None);
    }

    #[test]
    fn test_acl_plus_suffix() {
        let line = "drwxr-xr-x+ 3 root root 4096 Feb 28  2024 with spaces in name";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "with spaces in name");
        assert_eq!(entry.size, 4096);
        assert_eq!(entry.modified.as_deref(), Some("2024-02-28 00:00:00"));
    }

    #[test]
    fn test_selinux_context_suffix() {
        let line = "drwxr-xr-x. 2 root root system_u:object_r:default_t 4096 Jan 15 12:32 dev";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "dev");
        assert_eq!(entry.size, 4096);
        // SELinux context column sits between group and size — group still found.
        assert_eq!(entry.owner.as_deref(), Some("root"));
        assert_eq!(entry.group.as_deref(), Some("root"));
    }

    #[test]
    fn test_numeric_owner_group() {
        let line = "drwxr-xr-x 2 1000 1000 4096 Mar 01 09:15 shared";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "shared");
        assert_eq!(entry.size, 4096);
        // Numeric uid/gid are the two tokens left of the numeric size.
        assert_eq!(entry.owner.as_deref(), Some("1000"));
        assert_eq!(entry.group.as_deref(), Some("1000"));
    }

    #[test]
    fn test_selinux_context_with_long_iso() {
        // SELinux context column + GNU long-iso date.
        let line =
            "drwxr-xr-x. 2 root root system_u:object_r:default_t 4096 2025-01-15 12:32 dev";
        let entry = parse_ls_long_line(line).expect("should parse");
        assert_eq!(entry.name, "dev");
        assert_eq!(entry.size, 4096);
        assert_eq!(entry.modified.as_deref(), Some("2025-01-15 12:32"));
    }

    // ---- Edge cases ----

    #[test]
    fn test_empty_line() {
        assert!(parse_ls_long_line("").is_none());
        assert!(parse_ls_long_line("   ").is_none());
    }

    #[test]
    fn test_total_line_ignored() {
        assert!(parse_ls_long_line("total 123").is_none());
        assert!(parse_ls_long_line("total 0").is_none());
    }

    #[test]
    fn test_dot_entries_filtered() {
        assert!(parse_ls_long_line("drwxr-xr-x 2 root root 4096 Jan 01 00:00 .").is_none());
        assert!(parse_ls_long_line("drwxr-xr-x 2 root root 4096 Jan 01 00:00 ..").is_none());
    }

    #[test]
    fn test_non_ls_line_ignored() {
        // Random shell output that doesn't look like an ls entry.
        assert!(parse_ls_long_line("drwxr-xr-x").is_none()); // too few tokens
        assert!(parse_ls_long_line("hello world foo bar").is_none()); // no perms
    }

    /// End-to-end regression test reproducing the user-reported symptoms on a
    /// MAME/arcade-style SSH host whose `ls` is BusyBox (no `--time-style`).
    #[test]
    fn test_user_scenario_arcade_box_busybox() {
        let lines = [
            "drwxr-xr-x 2 root root 4096 Jan 15 12:32 dev",
            "drwxr-xr-x 2 root root 4096 Jan 15 12:32 proc",
            "drwxr-xr-x 2 root root 4096 Jan 15 12:32 sys",
            "drwxr-xr-x 2 root root 4096 Jul 25 12:46 Pacman",
            "drwxr-xr-x 2 root root 4096 Jul 25 12:46 SEGA",
            "drwxr-xr-x 2 root root 4096 Jul 25 12:46 Taito",
            "-rw-r--r-- 1 root root 85234 Nov 09  2000 gamelist.xml",
        ];

        for (i, line) in lines.iter().enumerate() {
            let entry = parse_ls_long_line(line)
                .unwrap_or_else(|| panic!("line {} should parse: {}", i, line));
            // The buggy old parser produced names like "12:32 dev", "2000 gamelist.xml".
            assert!(
                !entry.name.starts_with('1') && !entry.name.starts_with('2'),
                "name should not leak time/year token, got: {:?}",
                entry.name
            );
        }

        let dev = parse_ls_long_line(lines[0]).unwrap();
        assert_eq!(dev.name, "dev");

        let pacman = parse_ls_long_line(lines[3]).unwrap();
        assert_eq!(pacman.name, "Pacman");

        let gamelist = parse_ls_long_line(lines[6]).unwrap();
        assert_eq!(gamelist.name, "gamelist.xml");
        assert_eq!(gamelist.size, 85234);
        assert_eq!(gamelist.modified.as_deref(), Some("2000-11-09 00:00:00"));
    }

    /// OpenWrt ships BusyBox `ls` by default, so the backend runs plain
    /// `ls -la` (no `--time-style`). This reproduces the exact failure the user
    /// saw on their OpenWrt router: right-aligned, space-padded columns and the
    /// default `Mon DD HH:MM` / `Mon DD YYYY` date layout.
    #[test]
    fn test_user_scenario_openwrt_busybox() {
        let lines = [
            "drwxr-xr-x    1 root     root           104 Jan 15 12:32 dev",
            "drwxr-xr-x    1 root     root             0 Jan 15 12:32 proc",
            "drwxr-xr-x    1 root     root             0 Jan 15 12:32 sys",
            "drwxr-xr-x    2 root     root          4096 Jul 25 12:46 Pacman",
            "drwxr-xr-x    2 root     root          4096 Jul 25 12:46 SEGA",
            "-rw-r--r--    1 root     root         85234 Nov  9  2000 gamelist.xml",
            "lrwxrwxrwx    1 root     root            11 Jan 15 12:32 sbin -> usr/sbin",
        ];

        let dev = parse_ls_long_line(lines[0]).expect("dev must parse");
        assert_eq!(dev.name, "dev");
        assert_eq!(dev.size, 104);
        assert!(matches!(dev.file_type, FileEntryType::Directory));
        assert_eq!(dev.owner.as_deref(), Some("root"));
        assert_eq!(dev.group.as_deref(), Some("root"));

        let proc_entry = parse_ls_long_line(lines[1]).expect("proc must parse");
        assert_eq!(proc_entry.name, "proc");
        assert_eq!(proc_entry.size, 0);

        let pacman = parse_ls_long_line(lines[3]).expect("Pacman must parse");
        assert_eq!(pacman.name, "Pacman");
        assert_eq!(pacman.size, 4096);

        // Older file → year is shown; time defaults to 00:00:00.
        let gamelist = parse_ls_long_line(lines[5]).expect("gamelist.xml must parse");
        assert_eq!(gamelist.name, "gamelist.xml");
        assert_eq!(gamelist.size, 85234);
        assert_eq!(gamelist.modified.as_deref(), Some("2000-11-09 00:00:00"));

        // Symlink target must be stripped from the name.
        let sbin = parse_ls_long_line(lines[6]).expect("sbin symlink must parse");
        assert_eq!(sbin.name, "sbin");
        assert!(matches!(sbin.file_type, FileEntryType::Symlink));
    }
}
