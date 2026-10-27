/**
 * Log Monitor — Business-grade log viewer
 *
 * Inspired by Datadog Log Explorer / Grafana Loki / Kibana:
 *  • Multi-source: log files, journalctl services, Docker containers, custom paths
 *  • Level filter chips (ERROR / WARN / INFO / DEBUG / TRACE)
 *  • Regex search with match highlighting
 *  • Line numbers + parsed timestamps + level badges
 *  • Live tail with configurable refresh interval
 *  • Level statistics in status bar
 *  • Download support
 */

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { notify } from '@/lib/notifications';
import {
  Search,
  RefreshCw,
  Download,
  Plus,
  X,
  Lock,
  Unlock,
  FileText,
  ScrollText,
  Container,
  FolderOpen,
  Play,
  Pause,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Toggle } from "./ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "./ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover";
import { cn } from "@/lib/utils";

// ── Types ──

interface LogMonitorProps {
  connectionId?: string;
  /** When set, auto-add this file path as a custom source and select it */
  externalLogPath?: string;
  /** Increment to re-trigger loading the same externalLogPath */
  externalLogPathKey?: number;
  /**
   * Whether this panel's tab is the visible one. The panel stays mounted so its
   * filters and scroll position survive a tab switch, but while it is hidden it
   * must not run background work: switching the active connection used to
   * re-run log discovery for a panel nobody was looking at, which raised a
   * "no sources" toast for a tab the user had already left.
   */
  active?: boolean;
  /**
   * The owning session's status, used only as a retry signal: it re-triggers
   * discovery when a connection comes up, since the tab can read `connected`
   * before the backend has registered a session for it. Discovery is
   * deliberately NOT gated on it — a status of `disconnected` can still have a
   * live SSH session (the PTY dropped), and refusing to probe would strand the
   * panel. Defaults to `'connected'` for callers that do not track status.
   */
  connectionStatus?: 'connected' | 'connecting' | 'disconnected' | 'pending';
}

interface LogSource {
  id: string;
  name: string;
  source_type: "file" | "journal" | "docker";
  path: string;
  category: string;
  size_human?: string;
}

interface LogSourcesResponse {
  success: boolean;
  sources: LogSource[];
  error?: string;
}

type LogLevel = "error" | "warn" | "info" | "debug" | "trace" | "unknown";

interface ParsedLogLine {
  lineNumber: number;
  raw: string;
  level: LogLevel;
  timestamp?: string;
  message: string;
}

// ── Constants ──

const LOG_LEVELS: LogLevel[] = ["error", "warn", "info", "debug", "trace"];

const LEVEL_COLORS: Record<LogLevel, { bg: string; text: string; badge: string }> = {
  error: {
    bg: "bg-red-500/10",
    text: "text-destructive",
    badge: "bg-red-500/20 text-destructive border-red-500/30",
  },
  warn: {
    bg: "bg-yellow-500/10",
    text: "text-[var(--warning)]",
    badge: "bg-yellow-500/20 text-[var(--warning)] border-yellow-500/30",
  },
  info: {
    bg: "",
    text: "text-primary",
    badge: "bg-primary/15 text-primary border-primary/30",
  },
  debug: {
    bg: "",
    text: "text-muted-foreground",
    badge: "bg-gray-500/20 text-muted-foreground border-gray-500/30",
  },
  trace: {
    bg: "",
    text: "text-[var(--chart-5)]",
    badge: "bg-purple-500/20 text-[var(--chart-5)] border-purple-500/30",
  },
  unknown: {
    bg: "",
    text: "text-foreground",
    badge: "bg-muted text-muted-foreground border-border",
  },
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  error: "E",
  warn: "W",
  info: "I",
  debug: "D",
  trace: "T",
  unknown: "?",
};

const LINE_COUNT_OPTIONS = [50, 100, 200, 500, 1000];

/** Not-ready discovery retries: enough to outlast a slow SSH handshake. */
const MAX_DISCOVERY_ATTEMPTS = 4;
const RETRY_BASE_MS = 1500;
const REFRESH_INTERVALS = [
  { value: 1, label: "1s" },
  { value: 2, label: "2s" },
  { value: 3, label: "3s" },
  { value: 5, label: "5s" },
  { value: 10, label: "10s" },
];

// ── Utility Functions ──

/** Detect log level from a raw log line */
function detectLevel(line: string): LogLevel {
  const lower = line.toLowerCase();
  if (/\b(error|err\b|fatal|crit(?:ical)?|panic|exception|fail(?:ed|ure)?)\b/.test(lower))
    return "error";
  if (/\b(warn(?:ing)?)\b/.test(lower)) return "warn";
  if (/\b(info|notice)\b/.test(lower)) return "info";
  if (/\b(debug|dbg)\b/.test(lower)) return "debug";
  if (/\b(trace|verbose)\b/.test(lower)) return "trace";
  return "unknown";
}

/** Extract timestamp from common log formats */
function extractTimestamp(line: string): { timestamp?: string; rest: string } {
  // ISO format: 2024-01-15T10:30:01.123Z or 2024-01-15 10:30:01
  const isoMatch = line.match(
    /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/
  );
  if (isoMatch) {
    return { timestamp: isoMatch[1], rest: isoMatch[2] };
  }

  // Syslog format: Jan 15 10:30:01
  const syslogMatch = line.match(
    /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(.*)$/
  );
  if (syslogMatch) {
    return { timestamp: syslogMatch[1], rest: syslogMatch[2] };
  }

  // Brackets format: [2024-01-15 10:30:01]
  const bracketMatch = line.match(
    /^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*(.*)$/
  );
  if (bracketMatch) {
    return { timestamp: bracketMatch[1], rest: bracketMatch[2] };
  }

  // Time only: 10:30:01 or 10:30:01.123
  const timeMatch = line.match(
    /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(.*)$/
  );
  if (timeMatch) {
    return { timestamp: timeMatch[1], rest: timeMatch[2] };
  }

  return { rest: line };
}

/** Parse raw lines into structured log entries */
function parseLogLines(rawLines: string[]): ParsedLogLine[] {
  return rawLines
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      const level = detectLevel(line);
      const { timestamp, rest } = extractTimestamp(line);
      return {
        lineNumber: i + 1,
        raw: line,
        level,
        timestamp,
        message: rest,
      };
    });
}

/** Group log sources by type for the dropdown */
function groupSources(sources: LogSource[]) {
  const groups: Record<string, LogSource[]> = {};
  for (const src of sources) {
    const key = src.source_type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(src);
  }
  return groups;
}

const SOURCE_TYPE_LABELS: Record<string, { icon: React.ReactNode; label: string }> = {
  file: { icon: <FileText className="h-3 w-3 inline mr-1" />, label: "Log Files" },
  journal: { icon: <ScrollText className="h-3 w-3 inline mr-1" />, label: "Services (journalctl)" },
  docker: { icon: <Container className="h-3 w-3 inline mr-1" />, label: "Containers (docker)" },
};

// ── Component ──

export function LogMonitor({ connectionId, externalLogPath, externalLogPathKey, active = true, connectionStatus = 'connected' }: LogMonitorProps) {
  const { t } = useTranslation();
  // Source state
  const [sources, setSources] = useState<LogSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);

  // Log data state
  const [rawLines, setRawLines] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Filter state
  const [searchTerm, setSearchTerm] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<LogLevel>>(new Set());
  const [lineCount, setLineCount] = useState(200);

  // Auto-refresh state
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(3);

  // Scroll state
  const [scrollLocked, setScrollLocked] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  // The connection whose state the panel currently holds. Async answers that
  // outlive it — an in-flight read or discovery while the user switched hosts —
  // must be dropped, so loadLog and discoverSources compare against this ref.
  const currentConnectionRef = useRef(connectionId);
  // The connection this panel has already finished discovering for. Kept in a
  // ref so re-running the effect does not re-toast for a connection already
  // shown, and so that a discovery deferred while hidden still happens when the
  // tab is opened.
  const discoveredForRef = useRef<string | null>(null);
  // Not-ready retries: how many have been spent on the current connection, and
  // a nonce to re-trigger the discovery effect from a timer.
  const attemptRef = useRef(0);
  const [retryNonce, setRetryNonce] = useState(0);
  // File-browser sources stay per-connection: A → B → A brings back the file
  // the user opened from A's browser without leaking it into B's list.
  const externalSourceForRef = useRef<Map<string, LogSource>>(new Map());

  // ── Source discovery ──

  /**
   * Run log-source discovery. Resolves to true only when a discovery actually
   * completed — a session that is not ready yet must stay retryable, otherwise
   * opening the tab later would show an empty list with nothing to trigger a
   * retry.
   */
  const discoverSources = useCallback(async (): Promise<boolean> => {
    if (!connectionId) return false;
    setIsDiscovering(true);
    try {
      const result = await invoke<LogSourcesResponse>("discover_log_sources", {
        connectionId,
      });

      // The user switched connections while this discovery was in flight; its
      // answer describes a connection the panel no longer shows — same guard
      // as in loadLog. `true` (completed) so a stale probe never schedules a
      // retry; the effect's `cancelled` flag keeps the stale caller from
      // marking `discoveredForRef`.
      if (currentConnectionRef.current !== connectionId) return true;

      if (result.success) {
        // Keep custom sources already in state — a file-browser entry restored
        // by the connection switch, or one added before discovery finished.
        // The discovered list only knows discovered sources.
        setSources((prev) => {
          const customs = prev.filter(
            (s) => s.category === "custom" && !result.sources.some((r) => r.id === s.id)
          );
          return customs.length > 0 ? [...result.sources, ...customs] : result.sources;
        });
        if (result.sources.length === 0) {
          notify.info(t('logMonitor.noSourcesDiscovered'));
        }
        return true;
      } else if (result.error && (
        result.error.includes('Connection not found') ||
        result.error.includes('Session not found')
      )) {
        // Transient: the SSH session was just created and may not be fully
        // initialized yet. Silently skip — the user can rediscover later.
        console.debug('[LogMonitor] Session not ready yet, skipping source discovery:', result.error);
        return false;
      } else {
        notify.error(t('logMonitor.failedToDiscoverSources'), {
          description: result.error,
        });
        return true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Connection not found') || msg.includes('Session not found')) {
        console.debug('[LogMonitor] Session not ready yet, skipping source discovery:', msg);
        return false;
      } else {
        notify.error(t('logMonitor.failedToDiscoverSources'), {
          description: msg,
        });
        return true;
      }
    } finally {
      setIsDiscovering(false);
    }
  }, [connectionId]);

  // Discover when the panel is looked at — on first activation, and again for
  // each new connection the user switches to *while watching*. A connection
  // switch with the tab hidden does no work, so switching sessions never pops a
  // "no sources" toast at a panel the user already left.
  useEffect(() => {
    if (!connectionId || !active) return;
    if (discoveredForRef.current === connectionId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      const done = await discoverSources();
      if (cancelled) return;
      if (done) {
        discoveredForRef.current = connectionId;
        attemptRef.current = 0;
        return;
      }
      // No backend session for this connection yet. `connectionStatus` in the
      // dependency list is the normal signal — it flips when the session comes
      // up — but it can flip before the backend has actually registered, so a
      // status-only retry would leave the panel permanently empty. Back off and
      // try again a few times regardless.
      if (attemptRef.current >= MAX_DISCOVERY_ATTEMPTS) return;
      attemptRef.current += 1;
      timer = setTimeout(
        () => setRetryNonce((n) => n + 1),
        attemptRef.current * RETRY_BASE_MS,
      );
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connectionId, active, connectionStatus, retryNonce, discoverSources]);

  // The loaded lines and the selected source belong to one specific connection.
  // Without this, switching hosts kept showing the previous connection's log
  // content (and its source in the dropdown) until discovery caught up — the
  // source list refreshed but the text below it did not.
  //
  // Only per-connection state is dropped. Filters, line count, the custom-path
  // box and the live-tail toggle are the user's own settings and survive the
  // switch, which is the reason this panel stays mounted at all.
  useEffect(() => {
    if (currentConnectionRef.current === connectionId) return;
    currentConnectionRef.current = connectionId;
    // The sources this connection had are being thrown away, so the
    // "already discovered" mark has to go with them. Leaving it set strands
    // the panel: A → B → A would come back marked as discovered with an empty
    // list and no toast to explain it.
    discoveredForRef.current = null;
    attemptRef.current = 0;
    setRetryNonce(0);
    setSources([]);
    setSelectedSourceId("");
    setRawLines([]);
    // A file the user opened from this connection's file browser comes back
    // with the connection — it is user state, like the filters above.
    const remembered = connectionId
      ? externalSourceForRef.current.get(connectionId)
      : undefined;
    if (remembered) {
      setSources((prev) =>
        prev.some((s) => s.id === remembered.id) ? prev : [...prev, remembered]
      );
      setSelectedSourceId(remembered.id);
    }
  }, [connectionId]);

  // ── Find selected source ──
  const selectedSource = useMemo(
    () => sources.find((s) => s.id === selectedSourceId) ?? null,
    [sources, selectedSourceId]
  );

  // ── Load log content ──

  const loadLog = useCallback(
    async (isAutoRefresh = false) => {
      if (!connectionId || !selectedSourceId) return;

      // Determine source type and path
      let sourceType = "file";
      let path = selectedSourceId;

      if (selectedSourceId.startsWith("custom:")) {
        sourceType = "custom";
        path = selectedSourceId.replace("custom:", "");
      } else if (selectedSource) {
        sourceType = selectedSource.source_type;
        path = selectedSource.path;
      }

      if (!isAutoRefresh) setIsLoading(true);

      const requestedFor = connectionId;

      try {
        const result = await invoke<{
          success: boolean;
          output?: string;
          error?: string;
        }>("read_log", {
          connectionId,
          sourceType,
          path,
          lines: lineCount,
        });

        // The user switched hosts while this read was in flight; its answer
        // describes a connection the panel is no longer showing.
        if (currentConnectionRef.current !== requestedFor) return;

        if (result.success && result.output) {
          const _prevScrollHeight = scrollRef.current?.scrollHeight ?? 0;
          const wasAtBottom = scrollRef.current
            ? scrollRef.current.scrollHeight -
                scrollRef.current.scrollTop -
                scrollRef.current.clientHeight <
              50
            : true;

          setRawLines(result.output.split("\n"));

          // Auto-scroll to bottom if locked
          if (scrollLocked || wasAtBottom) {
            requestAnimationFrame(() => {
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
            });
          }
        } else if (!isAutoRefresh) {
          notify.error(t('logMonitor.failedToLoadLog'), {
            description: result.error ?? t('logMonitor.unknownError'),
          });
        }
      } catch (err) {
        if (!isAutoRefresh) {
          notify.error(t('logMonitor.failedToLoadLog'), {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (!isAutoRefresh) setIsLoading(false);
      }
    },
    [connectionId, selectedSourceId, selectedSource, lineCount, scrollLocked]
  );

  // Load when source changes
  useEffect(() => {
    if (selectedSourceId) {
      setRawLines([]);
      loadLog();
    }
  }, [selectedSourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh timer. Suspended while hidden so a live tail does not keep
  // reading the remote file for a panel the user cannot see.
  useEffect(() => {
    if (!autoRefresh || !selectedSourceId || !active) return;
    const interval = setInterval(
      () => { void loadLog(true); },
      refreshInterval * 1000
    );
    return () => clearInterval(interval);
  }, [autoRefresh, selectedSourceId, refreshInterval, loadLog, active]);

  // Handle external log path (sent from file browser)
  useEffect(() => {
    if (!externalLogPath) return;
    const path = externalLogPath.trim();
    if (!path) return;

    const id = `custom:${path}`;
    const name = path.split("/").pop() ?? path;

    // Add to sources if not already present
    setSources((prev) => {
      if (prev.some((s) => s.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          name,
          source_type: "file" as const,
          path,
          category: "custom",
          size_human: undefined,
        },
      ];
    });

    // Remember the owning connection so leaving and coming back restores it.
    if (connectionId) {
      externalSourceForRef.current.set(connectionId, {
        id,
        name,
        source_type: "file",
        path,
        category: "custom",
        size_human: undefined,
      });
    }

    // Select and load it
    setSelectedSourceId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connectionId is deliberately not a dep: re-running on a switch would re-add the previous connection's file to the new one's list
  }, [externalLogPath, externalLogPathKey]);

  // ── Parse and filter lines ──

  const parsedLines = useMemo(() => parseLogLines(rawLines), [rawLines]);

  const invalidRegex = useMemo(() => {
    if (!isRegex || !searchTerm) return false;
    try {
      new RegExp(searchTerm);
      return false;
    } catch {
      return true;
    }
  }, [isRegex, searchTerm]);

  const filteredLines = useMemo(() => {
    if (invalidRegex) return [];
    let lines = parsedLines;

    // Filter by level
    if (activeFilters.size > 0) {
      lines = lines.filter((l) => activeFilters.has(l.level));
    }

    // Filter by search term
    if (searchTerm) {
      if (isRegex) {
        try {
          const re = new RegExp(searchTerm, "i");
          lines = lines.filter((l) => re.test(l.raw));
        } catch {
          // Invalid regex, fall back to literal
          const lower = searchTerm.toLowerCase();
          lines = lines.filter((l) => l.raw.toLowerCase().includes(lower));
        }
      } else {
        const lower = searchTerm.toLowerCase();
        lines = lines.filter((l) => l.raw.toLowerCase().includes(lower));
      }
    }

    return lines;
  }, [parsedLines, activeFilters, searchTerm, isRegex, invalidRegex]);

  // ── Level statistics ──

  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = {
      error: 0,
      warn: 0,
      info: 0,
      debug: 0,
      trace: 0,
      unknown: 0,
    };
    for (const line of parsedLines) {
      counts[line.level]++;
    }
    return counts;
  }, [parsedLines]);

  // ── Event handlers ──

  const handleSourceChange = useCallback((value: string) => {
    setSelectedSourceId(value);
    setAutoRefresh(false);
  }, []);

  const handleAddCustomPath = useCallback(() => {
    const path = customPath.trim();
    if (!path) return;

    const id = `custom:${path}`;
    const name = path.split("/").pop() ?? path;

    // Add to sources if not already present
    setSources((prev) => {
      if (prev.some((s) => s.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          name,
          source_type: "file" as const,
          path,
          category: "custom",
          size_human: undefined,
        },
      ];
    });

    setSelectedSourceId(id);
    setCustomPath("");
    setShowCustomInput(false);
  }, [customPath]);

  const toggleLevel = useCallback((level: LogLevel) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const isAtBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;

    if (isAtBottom && !scrollLocked) {
      setScrollLocked(true);
    } else if (
      !isAtBottom &&
      scrollLocked &&
      el.scrollTop < lastScrollTop.current
    ) {
      setScrollLocked(false);
    }

    lastScrollTop.current = el.scrollTop;
  }, [scrollLocked]);

  const handleDownload = useCallback(() => {
    const text = rawLines.join("\n");
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const sourceName =
      selectedSource?.name ?? selectedSourceId.replace("custom:", "").split("/").pop() ?? "log";
    a.download = `${sourceName}_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rawLines, selectedSource, selectedSourceId]);

  // ── Search highlight helper ──

  const highlightSearch = useCallback(
    (text: string) => {
      if (!searchTerm) return text;

      try {
        const re = isRegex
          ? new RegExp(searchTerm, "gi")
          : new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

        const parts: React.ReactNode[] = [];
        let cursor = 0;
        for (const match of text.matchAll(re)) {
          if (!match[0]) continue;
          const index = match.index;
          parts.push(text.slice(cursor, index));
          parts.push(
            <mark key={index} className="rounded-sm bg-primary/20 text-inherit underline decoration-primary/60 underline-offset-2">
              {match[0]}
            </mark>
          );
          cursor = index + match[0].length;
        }
        parts.push(text.slice(cursor));
        return parts;

      } catch {
        return text;
      }
    },
    [searchTerm, isRegex]
  );

  // ── Grouped sources for dropdown ──

  const groupedSources = useMemo(() => groupSources(sources), [sources]);

  // ── No connection state ──

  if (!connectionId) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t('logMonitor.connectToViewLogs')}
      </div>
    );
  }

  // ── Render ──

  return (
    <TooltipProvider delayDuration={300}>
      <div className="log-panel h-full min-w-0 flex flex-col text-foreground">
        {/* ── Row 1: Source selector ── */}
        <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b border-border bg-sidebar/40 shrink-0">
          <Select value={selectedSourceId} onValueChange={handleSourceChange}>
            <SelectTrigger aria-label={t('logMonitor.selectLogSource')} className="log-source-selector h-8! text-xs min-w-0">
              <SelectValue placeholder={t('logMonitor.selectLogSource')} />
            </SelectTrigger>
            <SelectContent className="max-h-[300px]">
              {Object.entries(groupedSources).map(([type, items]) => {
                const meta = SOURCE_TYPE_LABELS[type] ?? {
                  icon: <FileText className="h-3 w-3 inline mr-1" />,
                  label: type,
                };
                return (
                  <SelectGroup key={type}>
                    <SelectLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      {meta.icon}
                      {meta.label}
                    </SelectLabel>
                    {items.map((src) => (
                      <SelectItem
                        key={src.id}
                        value={src.id}
                        className="text-xs"
                      >
                        <div className="flex items-center justify-between gap-2 w-full">
                          <span className="truncate">{src.name}</span>
                          {src.size_human && (
                            <span className="text-[11px] text-muted-foreground shrink-0">
                              {src.size_human}
                            </span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                );
              })}

              {/* Custom sources */}
              {sources.some((s) => s.category === "custom") && (
                <SelectGroup>
                  <SelectLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <FolderOpen className="h-3 w-3 inline mr-1" />
                    {t('logMonitor.customPaths')}
                  </SelectLabel>
                  {sources
                    .filter((s) => s.category === "custom")
                    .map((src) => (
                      <SelectItem
                        key={src.id}
                        value={src.id}
                        className="text-xs"
                      >
                        {src.path}
                      </SelectItem>
                    ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={discoverSources}
                aria-label={t('logMonitor.rediscoverSources')}
                disabled={isDiscovering}
              >
                <RefreshCw
                  className={cn(
                    "h-3.5 w-3.5",
                    isDiscovering && "animate-spin"
                  )}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.rediscoverSources')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={showCustomInput ? "secondary" : "ghost"}
                className="h-7 w-7 shrink-0"
                onClick={() => setShowCustomInput(!showCustomInput)}
                aria-label={t('logMonitor.addCustomPath')}
                aria-expanded={showCustomInput}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.addCustomPath')}</TooltipContent>
          </Tooltip>


          {/* Auto-refresh toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={autoRefresh ? "default" : "ghost"}
                className={cn(
                  "h-7 w-7 shrink-0",
                  autoRefresh && "bg-primary text-primary-foreground"
                )}
                onClick={() => setAutoRefresh(!autoRefresh)}
                aria-label={autoRefresh ? t('logMonitor.stopLiveTail') : t('logMonitor.startLiveTail')}
                aria-pressed={autoRefresh}
                disabled={!selectedSourceId}
              >
                {autoRefresh ? (
                  <Pause className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {autoRefresh ? t('logMonitor.stopLiveTail') : t('logMonitor.startLiveTail')}
            </TooltipContent>
          </Tooltip>

          {/* Refresh interval selector */}
          {autoRefresh && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-[11px] shrink-0 gap-0.5"
                  aria-label={t('logMonitor.refreshInterval')}
                >
                  {refreshInterval}s
                  <ChevronDown className="h-2.5 w-2.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-1" side="bottom" align="end">
                <div className="flex flex-col gap-0.5">
                  {REFRESH_INTERVALS.map((opt) => (
                    <Button
                      key={opt.value}
                      variant={
                        refreshInterval === opt.value ? "secondary" : "ghost"
                      }
                      size="sm"
                      className="h-6 text-xs justify-start"
                      onClick={() => setRefreshInterval(opt.value)}
                    >
                      {opt.label}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={handleDownload}
                aria-label={t('logMonitor.downloadLogs')}
                disabled={rawLines.length === 0}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.downloadLogs')}</TooltipContent>
          </Tooltip>
        </div>

        {selectedSource && (
          <div className="truncate border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground" title={selectedSource.path ?? selectedSource.name}>
            {selectedSource.path ?? selectedSource.name}
          </div>
        )}

        {/* ── Optional: Custom path input ── */}
        {showCustomInput && (
          <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border bg-muted/20 shrink-0">
            <Input
              placeholder={t('logMonitor.customPathPlaceholder')}
              value={customPath}
              aria-label={t('logMonitor.addCustomPath')}
              onChange={(e) => setCustomPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddCustomPath()}
              className="h-7 text-xs flex-1"
              autoFocus
            />
            <Button
              size="sm"
              className="h-7 text-xs px-2"
              onClick={handleAddCustomPath}
              disabled={!customPath.trim()}
            >
              {t('logMonitor.add')}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setShowCustomInput(false)}
              aria-label={t('common.cancel')}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {/* ── Row 2: Filters ── */}
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
          {/* Search input */}
          <div className="log-search relative min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
            <Input
              placeholder={t('logMonitor.searchLogs')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-8 text-xs pl-7 pr-7"
              aria-label={t('logMonitor.searchLogs')}
              aria-invalid={invalidRegex}
              aria-describedby={invalidRegex ? 'log-regex-error' : undefined}
              onKeyDown={(event) => { if (event.key === 'Escape') setSearchTerm(''); }}
            />
            {searchTerm && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setSearchTerm("")}
                aria-label={t('logMonitor.clearSearch')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Regex toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                size="sm"
                pressed={isRegex}
                onPressedChange={setIsRegex}
                aria-label={t('logMonitor.toggleRegex')}
                className="h-7 w-7 shrink-0 text-[11px] font-mono data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                .*
              </Toggle>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.toggleRegex')}</TooltipContent>
          </Tooltip>

          {/* Level filter chips */}
          {LOG_LEVELS.map((level) => {
            const active = activeFilters.has(level);
            const count = levelCounts[level];
            const colors = LEVEL_COLORS[level];
            return (
              <Tooltip key={level}>
                <TooltipTrigger asChild>
                  <button
                    className={cn(
                      "h-6 min-w-6 px-1.5 rounded text-[11px] font-semibold border border-border transition-all shrink-0",
                      active ? colors.badge : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                    onClick={() => toggleLevel(level)}
                    aria-pressed={active}
                    aria-label={t('logMonitor.filterLevel', { level: level.toUpperCase(), count })}
                  >
                    {LEVEL_LABELS[level]}
                    {count > 0 && active && (
                      <span className="ml-0.5 font-normal">{count}</span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t('logMonitor.filterLevel', { level: level.toUpperCase(), count })}
                </TooltipContent>
              </Tooltip>
            );
          })}

          {/* Line count selector */}
          <Select
            value={String(lineCount)}
            onValueChange={(v) => setLineCount(Number(v))}
          >
            <SelectTrigger aria-label={t('logMonitor.lineLimit')} className="h-7! w-[88px] text-[11px] px-2 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LINE_COUNT_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)} className="text-xs">
                  {t('logMonitor.nLines', { count: n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Manual load button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                className="h-7 text-xs px-2 shrink-0"
                onClick={() => loadLog()}
                disabled={!selectedSourceId || isLoading}
              >
                {isLoading ? (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                ) : (
                  t('logMonitor.load')
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('logMonitor.reloadContent')}</TooltipContent>
          </Tooltip>
        </div>

        {invalidRegex && (
          <p id="log-regex-error" role="alert" className="border-b border-border bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t('logMonitor.invalidRegex')}
          </p>
        )}

        {/* ── Log content area ── */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-auto bg-card/40 font-mono text-xs leading-5"
          onScroll={handleScroll}
        >
          {!selectedSourceId ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
              <FileText className="h-8 w-8 opacity-40" />
              <p className="text-xs">{t('logMonitor.selectSourceToBegin')}</p>
              {sources.length === 0 && !isDiscovering && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={discoverSources}
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  {t('logMonitor.discoverSources')}
                </Button>
              )}
            </div>
          ) : isLoading && rawLines.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-xs">{t('logMonitor.loadingLogs')}</span>
            </div>
          ) : filteredLines.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-1">
              <AlertCircle className="h-6 w-6 opacity-40" />
              <p className="text-xs">
                {rawLines.length > 0
                  ? t('logMonitor.noMatchingLines')
                  : t('logMonitor.noLogContent')}
              </p>
            </div>
          ) : (
            <div className="py-0.5">
              {filteredLines.map((line) => (
                <div
                  key={`${line.lineNumber}-${line.raw.substring(0, 20)}`}
                  className={cn(
                    "flex items-start gap-2 px-2 py-1.5 hover:bg-muted/40 transition-colors group",
                    line.level !== "unknown" && LEVEL_COLORS[line.level].bg
                  )}
                >
                  {/* Line number */}
                  <span className="w-6 text-right text-[11px] text-muted-foreground/70 select-none shrink-0 pt-px tabular-nums">
                    {line.lineNumber}
                  </span>

                  <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                  {/* Timestamp */}
                  {line.timestamp && (
                    <span className="text-muted-foreground text-[11px] break-all">
                      {line.timestamp}
                    </span>
                  )}

                  {/* Level badge */}
                  {line.level !== "unknown" && (
                    <span
                      className={cn(
                        "inline-block text-center text-[11px] font-semibold shrink-0",
                        LEVEL_COLORS[line.level].text
                      )}
                    >
                      {LEVEL_LABELS[line.level]}
                    </span>
                  )}

                  {/* Message */}
                  <span
                    className={cn(
                      "log-message break-words whitespace-pre-wrap min-w-0 [overflow-wrap:anywhere]",
                      LEVEL_COLORS[line.level].text
                    )}
                  >
                    {highlightSearch(line.message)}
                  </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Status bar ── */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5 text-[11px] text-muted-foreground border-t border-border bg-muted/30 shrink-0">
          {/* Line counts */}
          <span>
            {filteredLines.length === parsedLines.length
              ? t('logMonitor.nLines', { count: parsedLines.length })
              : t('logMonitor.filteredLines', { filtered: filteredLines.length, total: parsedLines.length })}
          </span>

          {/* Level statistics */}
          <div className="flex items-center gap-1.5">
            {LOG_LEVELS.map((level) => {
              const count = levelCounts[level];
              if (count === 0) return null;
              return (
                <span
                  key={level}
                  className={cn("font-medium", LEVEL_COLORS[level].text)}
                >
                  {LEVEL_LABELS[level]}:{count}
                </span>
              );
            })}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1.5">
            {autoRefresh && (
              <span className="flex items-center gap-1">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--success)] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--success)]" />
                </span>
                <span className="text-[var(--success)]">{t('logMonitor.live')}</span>
              </span>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted hover:text-foreground transition-colors"
                  aria-label={scrollLocked ? t('logMonitor.scrollLocked') : t('logMonitor.scrollUnlocked')}
                  aria-pressed={scrollLocked}
                  onClick={() => setScrollLocked(!scrollLocked)}
                >
                  {scrollLocked ? (
                    <Lock className="h-3 w-3" />
                  ) : (
                    <Unlock className="h-3 w-3" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {scrollLocked
                  ? t('logMonitor.scrollLocked')
                  : t('logMonitor.scrollUnlocked')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
