import type { ConnectionData } from './connection-storage';
import { isCommandWidget, type CommandDataSource, type Dashboard, type DashboardWidget } from './dashboard-config';
import { appendMonitorSample, parseMonitorOutput, type MonitorData, type MonitorSample } from './monitor-data';
import type { MonitorCommandResult } from './use-monitor-command';

export type DashboardConnectionStatus = 'idle' | 'connecting' | 'connected' | 'retrying' | 'needsAuth' | 'missing';
export interface DashboardConnectionState { status: DashboardConnectionStatus; error?: string }
export interface DashboardSourceReading {
  result?: MonitorCommandResult;
  success?: MonitorCommandResult;
  updatedAt?: number;
  running: boolean;
}
export interface DashboardWidgetReading {
  data?: MonitorData;
  error?: unknown;
  result?: MonitorCommandResult;
  updatedAt?: number;
  samples: MonitorSample[];
  gap: boolean;
}
export interface DashboardRuntimeDependencies {
  connect: (connection: ConnectionData, runtimeId: string, interactive: boolean) => Promise<{ success: boolean; error?: string; needsInput?: boolean }>;
  disconnect: (runtimeId: string) => Promise<unknown>;
  cancelConnect: (runtimeId: string) => void;
  execute: (runtimeId: string, runId: string, source: CommandDataSource) => Promise<MonitorCommandResult>;
  cancel: (runtimeId: string, runId: string) => void;
  fingerprint: (connection: ConnectionData) => string;
  now?: () => number;
}
interface Session extends DashboardConnectionState {
  savedId: string;
  runtimeId: string;
  fingerprint: string;
  connection: ConnectionData;
  refs: Set<string>;
  retired: boolean;
  pending?: Promise<void>;
  retryAt: number;
  failures: number;
}
interface Job {
  key: string;
  boardId: string;
  source: CommandDataSource;
  connectionId: string;
  session?: Session;
  nextAt: number;
  runId?: string;
  runtimeId?: string;
  disposed: boolean;
}
const rawKey = (boardId: string, sourceId: string, connectionId: string) => JSON.stringify([boardId, sourceId, connectionId]);
const widgetKey = (boardId: string, widgetId: string, connectionId: string) => JSON.stringify([boardId, widgetId, connectionId]);
const projection = (widget: DashboardWidget) => isCommandWidget(widget) ? JSON.stringify([widget.sourceId, widget.display, widget.fields.map(field => field.path), widget.arrayPath, widget.tableFormat]) : 'note';
const sourceSchedule = (source: CommandDataSource) => JSON.stringify([source.command, source.intervalSeconds, source.timeoutSeconds]);
const endpoint = (connection?: ConnectionData) => JSON.stringify([connection?.host, connection?.port, connection?.username]);
const failureResult = (error?: unknown, status: MonitorCommandResult['status'] = 'transport_error'): MonitorCommandResult => ({
  stdout: '', stderr: '', exitCode: null, durationMs: 0, status, error: error instanceof Error ? error.message : typeof error === 'string' ? error : null,
});

/** Owns collection independently of React views. The backend enforces the two-channel limit,
 * including queue time in each command's timeout; trials use that same session and queue. */
export class DashboardRuntime {
  private boards = new Map<string, Dashboard>();
  private connections = new Map<string, ConnectionData>();
  private open = new Set<string>();
  private started = new Set<string>();
  private sessions = new Map<string, Session>();
  private jobs = new Map<string, Job>();
  private inFlight = new Map<string, Promise<void>>();
  private raw = new Map<string, DashboardSourceReading>();
  private readings = new Map<string, DashboardWidgetReading>();
  private listeners = new Set<() => void>();
  private trials = new Set<AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private revision = 0;
  private live = false;
  private clock = 0;
  private now: () => number;

  constructor(private deps: DashboardRuntimeDependencies) { this.now = deps.now ?? Date.now; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.revision;
  getTime = () => this.clock;
  private emit() { this.clock = this.now(); this.revision++; this.listeners.forEach(listener => listener()); }
  start() { this.live = true; this.timer ??= setInterval(() => this.pump(), 250); this.pump(); }
  stop() {
    this.live = false;
    clearInterval(this.timer); this.timer = undefined;
    for (const trial of this.trials) trial.abort();
    for (const job of this.jobs.values()) this.removeJob(job);
    for (const session of this.sessions.values()) this.retire(session);
    this.sessions.clear();
  }

  configure(boards: Dashboard[], connections: ConnectionData[], openIds: string[], visibleIds: string[]) {
    const nextBoards = new Map(boards.map(board => [board.id, board]));
    const nextConnections = new Map(connections.map(connection => [connection.id, connection]));
    const nextOpen = new Set(openIds);
    for (const id of this.open) if (!nextOpen.has(id)) {
      this.started.delete(id);
      this.clearBoard(id);
    }
    // A saved command must never inherit values produced by the previous command.
    for (const board of boards) {
      const previous = this.boards.get(board.id);
      for (const source of board.sources) {
        const old = previous?.sources.find(item => item.id === source.id);
        for (const connectionId of source.connectionIds) {
          if ((old && old.command !== source.command)
            || (this.connections.has(connectionId) && endpoint(this.connections.get(connectionId)) !== endpoint(nextConnections.get(connectionId)))) {
            this.raw.delete(rawKey(board.id, source.id, connectionId));
            for (const widget of board.widgets.filter(item => item.sourceId === source.id)) this.readings.delete(widgetKey(board.id, widget.id, connectionId));
          }
        }
      }
      for (const widget of board.widgets) {
        const old = previous?.widgets.find(item => item.id === widget.id);
        if (old && projection(old) !== projection(widget)) this.clearWidget(board.id, widget.id);
        if (old?.enabled && !widget.enabled) for (const source of board.sources.filter(item => item.id === widget.sourceId)) {
          for (const id of source.connectionIds) {
            const key = widgetKey(board.id, widget.id, id);
            const reading = this.readings.get(key);
            if (reading) this.readings.set(key, { ...reading, gap: true });
          }
        }
      }
    }
    this.boards = nextBoards;
    this.connections = nextConnections;
    this.open = nextOpen;
    for (const id of visibleIds) if (this.open.has(id)) this.started.add(id);
    for (const [id, session] of this.sessions) {
      const connection = this.connections.get(id);
      if (!connection || connection.protocol !== 'SSH' || this.deps.fingerprint(connection) !== session.fingerprint) {
        this.retire(session); this.sessions.delete(id);
      }
    }
    const desired = new Map<string, { board: Dashboard; source: CommandDataSource; connectionId: string }>();
    for (const board of boards) if (this.isRunning(board.id)) {
      for (const source of board.sources) if (board.widgets.some(widget => widget.enabled && widget.sourceId === source.id)) {
        for (const connectionId of source.connectionIds) desired.set(rawKey(board.id, source.id, connectionId), { board, source, connectionId });
      }
    }
    // Keep a physical connection across a scheduling/command edit, even if its last
    // old job is replaced. Release this temporary lease after installing new jobs.
    const retained = [...new Set([...desired.values()].map(item => item.connectionId))]
      .map(id => this.sessions.get(id)).filter((session): session is Session => !!session && !session.retired);
    for (const session of retained) session.refs.add('reconcile');
    for (const job of this.jobs.values()) {
      const next = desired.get(job.key);
      if (!next || sourceSchedule(next.source) !== sourceSchedule(job.source) || job.session?.retired
        || (!job.session && this.connections.get(job.connectionId)?.protocol === 'SSH')) this.removeJob(job);
    }
    for (const [key, { board, source, connectionId }] of desired) {
      if (!this.jobs.has(key)) {
        const session = this.acquire(connectionId, key);
        this.jobs.set(key, { key, boardId: board.id, source, connectionId, session, nextAt: 0, disposed: false });
      } else this.jobs.get(key)!.source = source;
    }
    for (const session of retained) this.release(session, 'reconcile');
    // New/edited cards can preview the latest successful output without a new command.
    for (const board of boards) for (const source of board.sources) for (const connectionId of source.connectionIds) this.project(board, source, connectionId);
    this.prune();
    this.emit(); this.pump();
  }
  isOpen(id: string) { return this.open.has(id); }
  isRunning(id: string) {
    const board = this.boards.get(id);
    return this.open.has(id) && this.started.has(id) && board?.paused === false && board.widgets.some(widget => isCommandWidget(widget) && widget.enabled);
  }
  collectionState(id: string): 'closed' | 'paused' | 'waiting' | 'idle' | 'running' | 'static' {
    const enabled = this.boards.get(id)?.widgets.filter(widget => widget.enabled) ?? [];
    if (this.open.has(id) && enabled.length && enabled.every(widget => !isCommandWidget(widget))) return 'static';
    if (this.boards.get(id)?.paused) return 'paused';
    if (!this.open.has(id)) return 'closed';
    if (!this.started.has(id)) return 'waiting';
    return this.isRunning(id) ? 'running' : 'idle';
  }
  hasStarted(id: string) { return this.started.has(id); }
  connectionState(id: string): DashboardConnectionState {
    if (this.connections.get(id)?.protocol !== 'SSH') return { status: 'missing' };
    const session = this.sessions.get(id);
    return session ? { status: session.status, error: session.error } : { status: 'idle' };
  }
  sourceReading(boardId: string, sourceId: string, connectionId: string) { return this.raw.get(rawKey(boardId, sourceId, connectionId)); }
  widgetReading(boardId: string, id: string, connectionId: string) { return this.readings.get(widgetKey(boardId, id, connectionId)); }
  retry(connectionId: string) {
    const session = this.sessions.get(connectionId);
    if (!session || session.retired || session.pending) return;
    if (session.status === 'connected') {
      for (const job of this.jobs.values()) if (job.connectionId === connectionId) job.nextAt = 0;
      this.pump();
    } else { session.retryAt = 0; void this.connect(session, true); }
  }

  private acquire(id: string, owner: string) {
    const connection = this.connections.get(id);
    if (!connection || connection.protocol !== 'SSH') return undefined;
    let session = this.sessions.get(id);
    if (!session) {
      session = { savedId: id, runtimeId: '', fingerprint: this.deps.fingerprint(connection), connection,
        refs: new Set(), status: 'idle', retired: false, retryAt: 0, failures: 0 };
      this.sessions.set(id, session);
    }
    session.refs.add(owner);
    return session;
  }
  private release(session: Session | undefined, owner: string) {
    if (!session) return;
    session.refs.delete(owner);
    if (!session.refs.size) {
      this.retire(session);
      if (this.sessions.get(session.savedId) === session) this.sessions.delete(session.savedId);
    }
  }
  private retire(session: Session) {
    if (session.retired) return;
    session.retired = true;
    if (!session.runtimeId) return;
    this.deps.cancelConnect(session.runtimeId);
    void this.deps.disconnect(session.runtimeId).catch(() => {});
  }
  private connect(session: Session, interactive = false): Promise<void> {
    if (session.pending) return session.pending;
    if (session.retired || !session.refs.size) return Promise.resolve();
    const runtimeId = `dashboard-${crypto.randomUUID()}`;
    session.runtimeId = runtimeId;
    session.status = 'connecting'; session.error = undefined; this.emit();
    const pending = (async () => {
      try {
        const result = await this.deps.connect(session.connection, runtimeId, interactive);
        if (session.retired || session.runtimeId !== runtimeId) {
          if (result.success) await this.deps.disconnect(runtimeId).catch(() => {});
          return;
        }
        if (result.success) { session.status = 'connected'; session.failures = 0; }
        else {
          session.status = result.needsInput ? 'needsAuth' : 'retrying';
          session.error = result.error;
          session.retryAt = this.now() + [10_000, 20_000, 40_000, 60_000][Math.min(session.failures++, 3)];
        }
      } catch (error) {
        if (!session.retired) {
          session.status = 'retrying'; session.error = String(error);
          session.retryAt = this.now() + [10_000, 20_000, 40_000, 60_000][Math.min(session.failures++, 3)];
        }
      } finally { session.pending = undefined; this.emit(); }
    })();
    session.pending = pending;
    return pending;
  }
  private pump() {
    if (!this.live) return;
    if (this.open.size && this.now() - this.clock >= 5000) this.emit();
    for (const session of this.sessions.values()) if (!session.retired && session.refs.size && !session.pending
      && (session.status === 'idle' || (session.status === 'retrying' && session.retryAt <= this.now()))) void this.connect(session);
    for (const job of this.jobs.values()) if (!job.disposed && job.session?.status === 'connected'
      && !job.session.retired && !this.inFlight.has(job.key) && job.nextAt <= this.now()) this.run(job);
  }
  private run(job: Job) {
    const session = job.session!;
    const runtimeId = session.runtimeId;
    const runId = crypto.randomUUID();
    job.runId = runId; job.runtimeId = runtimeId;
    job.nextAt = this.now() + job.source.intervalSeconds * 1000;
    this.raw.set(job.key, { ...this.raw.get(job.key), running: true }); this.emit();
    const promise = (async () => {
      let result: MonitorCommandResult;
      try { result = await this.deps.execute(runtimeId, runId, job.source); }
      catch (error) { result = failureResult(error); }
      if (job.disposed || session.retired || session.runtimeId !== runtimeId) return;
      const previous = this.raw.get(job.key);
      this.raw.set(job.key, { ...previous, result, running: false,
        ...(result.status === 'success' ? { success: result, updatedAt: this.now() } : {}) });
      const board = this.boards.get(job.boardId);
      if (board) this.project(board, job.source, job.connectionId);
      if (result.status === 'transport_error') {
        session.status = 'retrying'; session.error = result.error ?? undefined;
        session.retryAt = this.now() + [10_000, 20_000, 40_000, 60_000][Math.min(session.failures++, 3)];
        // Retire the physical attempt without dropping references to this saved connection.
        for (const other of this.jobs.values()) if (other.session === session && other.runId && other.runtimeId === runtimeId) {
          this.deps.cancel(runtimeId, other.runId);
          const raw = this.raw.get(other.key);
          this.raw.set(other.key, { ...raw, result, running: false });
          const owner = this.boards.get(other.boardId);
          if (owner) this.project(owner, other.source, other.connectionId);
        }
        session.runtimeId = '';
        void this.deps.disconnect(runtimeId).catch(() => {});
      }
      this.emit();
    })().finally(() => {
      if (this.inFlight.get(job.key) === promise) this.inFlight.delete(job.key);
      job.runId = undefined; job.runtimeId = undefined;
      this.pump();
    });
    this.inFlight.set(job.key, promise);
  }
  private removeJob(job: Job) {
    job.disposed = true;
    if (job.runId && job.runtimeId) this.deps.cancel(job.runtimeId, job.runId);
    this.jobs.delete(job.key);
    const raw = this.raw.get(job.key);
    if (raw) this.raw.set(job.key, { ...raw, running: false });
    const board = this.boards.get(job.boardId);
    if (board) for (const widget of board.widgets.filter(item => item.sourceId === job.source.id)) {
      const key = widgetKey(board.id, widget.id, job.connectionId);
      const reading = this.readings.get(key);
      if (reading) this.readings.set(key, { ...reading, gap: true });
    }
    this.release(job.session, job.key);
  }
  private project(board: Dashboard, source: CommandDataSource, connectionId: string) {
    const raw = this.raw.get(rawKey(board.id, source.id, connectionId));
    if (!raw) return;
    for (const widget of board.widgets.filter(isCommandWidget).filter(item => item.sourceId === source.id && item.enabled)) {
      const key = widgetKey(board.id, widget.id, connectionId);
      const previous = this.readings.get(key);
      const error = raw.result?.status !== 'success' ? raw.result?.status : undefined;
      let next: DashboardWidgetReading = { samples: [], gap: false, ...previous, result: raw.result, error };
      if (raw.success && (!previous || previous.updatedAt !== raw.updatedAt)) {
        try {
          const data = parseMonitorOutput(widget, raw.success.stdout);
          next = { ...next, data, updatedAt: raw.updatedAt, samples: widget.display === 'chart' && data.kind === 'numbers'
            ? appendMonitorSample(next.samples, data.values, raw.updatedAt!, source.intervalSeconds * 1000, next.gap) : [], gap: false };
        } catch (parseError) { next.error = parseError; next.gap = true; }
      }
      if (error) next.gap = true;
      // Prune while paused/hidden as well; old points must not masquerade as a live five-minute window.
      next.samples = next.samples.filter(sample => this.now() - sample.timestamp <= 300_000);
      this.readings.set(key, next);
    }
  }
  private clearWidget(boardId: string, id: string) {
    for (const key of this.readings.keys()) { const parts = JSON.parse(key) as string[]; if (parts[0] === boardId && parts[1] === id) this.readings.delete(key); }
  }
  private clearBoard(id: string) {
    for (const map of [this.raw, this.readings]) for (const key of map.keys()) if ((JSON.parse(key) as string[])[0] === id) map.delete(key);
  }
  private prune() {
    for (const key of this.raw.keys()) {
      const [boardId, sourceId, connectionId] = JSON.parse(key) as string[];
      if (!this.open.has(boardId) || !this.boards.get(boardId)?.sources.some(source => source.id === sourceId && source.connectionIds.includes(connectionId))) this.raw.delete(key);
    }
    for (const key of this.readings.keys()) {
      const [boardId, id, connectionId] = JSON.parse(key) as string[];
      const board = this.boards.get(boardId);
      const widget = board?.widgets.find(item => item.id === id);
      if (!this.open.has(boardId) || !widget || !board?.sources.find(source => source.id === widget.sourceId)?.connectionIds.includes(connectionId)) this.readings.delete(key);
    }
  }

  /** Explicit one-shot work. Aborting the editor cancels queued commands and connection attempts.
   * Trial output never enters the production cache and cannot replay after a reconnect. */
  async trial(source: CommandDataSource, connectionIds: string[], signal: AbortSignal,
    onResult: (connectionId: string, result: MonitorCommandResult) => void): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    this.trials.add(controller);
    try {
      await Promise.all(connectionIds.map(async connectionId => {
        const owner = `trial-${crypto.randomUUID()}`;
        const session = this.acquire(connectionId, owner);
        if (!session) { if (!controller.signal.aborted) onResult(connectionId, failureResult()); return; }
        let runtimeId: string | undefined;
        const runId = crypto.randomUUID();
        const cancel = () => {
          if (runtimeId) this.deps.cancel(runtimeId, runId);
          this.release(session, owner);
        };
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          if (controller.signal.aborted) return;
          if (session.status !== 'connected') await this.connect(session);
          if (controller.signal.aborted || session.retired) return;
          if (session.status !== 'connected') { onResult(connectionId, failureResult(session.error)); return; }
          runtimeId = session.runtimeId;
          const result = await this.deps.execute(runtimeId, runId, source);
          if (!controller.signal.aborted && !session.retired && session.runtimeId === runtimeId) onResult(connectionId, result);
        } catch (error) { if (!controller.signal.aborted) onResult(connectionId, failureResult(error)); }
        finally { controller.signal.removeEventListener('abort', cancel); this.release(session, owner); this.emit(); }
      }));
    } finally { signal.removeEventListener('abort', abort); this.trials.delete(controller); }
  }
}
