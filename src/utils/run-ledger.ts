import crypto from 'node:crypto';
import type { RunModelResult } from '../types.js';

// MCP clients drop a tool call after a fixed time, Zed and many others at 60
// seconds, and some never tell the server they did. The agent then sees an
// error and makes the same run_model call again, which would start and bill a
// second task. This ledger remembers each run_model submission under a hash of
// the API key, the model and the parameters, for as long as an identical call
// can still be a retry of it, so that call continues the same task.
//
// The ledger lives in the process, so it covers every server this process
// creates for the same API key: one stdio session, or every request of an HTTP
// server that builds a server per request. The hash also goes to Wiro with the
// run request (x-wiro-run-key), and Wiro keeps the same record where every
// server process reads it, so a repeat that reaches another process or host,
// or this one after a restart, continues the task too. `release` says what
// Wiro's record should be told once no call here serves the run any more.

/** What Wiro answered to a run request. It never rejects. */
export type RunSubmission =
  | { ok: true; result: RunModelResult }
  | { ok: false; error: unknown };

export interface RunRecord {
  readonly key: string;
  readonly startedAt: number;
  readonly submission: Promise<RunSubmission>;
  /** The answer, once it came. */
  settled?: RunSubmission;
  /** run_model calls serving this run right now. */
  active: number;
  /** When a call serving this run last ended without its answer reaching the client. */
  unansweredAt?: number;
}

/** How a call serving a run ended. */
export type RunOutcome = 'answered' | 'unanswered' | 'failed';

export interface RunReuseTiming {
  /** How long after a call ended unanswered an identical call continues its run. */
  unansweredWindowMs: number;
  /**
   * How long after an identical call started, while it is still waiting, a new
   * call counts as its retry. Calls an agent sends side by side arrive together
   * and each start their own task; a retry comes after the client gave up.
   */
  retryAfterMs: number;
}

const MAX_RECORDS = 1000;

/** The task a run request created, when it created one this call can follow. */
export function submittedTask(
  submission: RunSubmission | undefined,
): { taskid?: string; tasktoken: string } | undefined {
  if (!submission?.ok || !submission.result.result) return undefined;
  const tasktoken = submission.result.socketaccesstoken ?? '';
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(tasktoken)) return undefined;
  const taskid = submission.result.taskid ? String(submission.result.taskid) : undefined;
  return { taskid, tasktoken };
}

/** JSON with object keys sorted at every level, so key order does not tell two calls apart. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort()
      .map(name => `${JSON.stringify(name)}:${canonicalJson(object[name])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The ledger key of one run: the caller, the model and the parameters. */
export function runKey(identity: string, model: string, params: Record<string, unknown>): string {
  return crypto.createHash('sha256')
    .update(identity)
    .update('\0')
    .update(model.trim().toLowerCase())
    .update('\0')
    .update(canonicalJson(params))
    .digest('hex');
}

export class RunLedger {
  private readonly records = new Map<string, RunRecord>();

  /**
   * The run an identical call should continue: one whose last call ended
   * without its answer reaching the client, within the window, or one an
   * identical call is still waiting for after `retryAfterMs`.
   */
  find(key: string, timing: RunReuseTiming, now = Date.now()): RunRecord | undefined {
    this.prune(timing, now);
    const record = this.records.get(key);
    if (!record) return undefined;
    if (record.unansweredAt !== undefined && now - record.unansweredAt <= timing.unansweredWindowMs) {
      return record;
    }
    if (record.active > 0 && now - record.startedAt >= timing.retryAfterMs) return record;
    return undefined;
  }

  /** Sends a new run request and remembers it under `key`. */
  start(key: string, submit: () => Promise<RunModelResult>, now = Date.now()): RunRecord {
    let submission: Promise<RunSubmission>;
    try {
      submission = submit().then(
        result => ({ ok: true as const, result }),
        error => ({ ok: false as const, error }),
      );
    } catch (error) {
      submission = Promise.resolve({ ok: false as const, error });
    }
    const record: RunRecord = { key, startedAt: now, submission, active: 0 };
    void submission.then(settled => {
      record.settled = settled;
      // An answer that came after every call left: without a task nothing is
      // left to continue.
      if (record.active === 0 && !submittedTask(settled)) this.forget(record);
    });
    this.records.delete(key);
    this.records.set(key, record);
    this.trim();
    return record;
  }

  /** A call starts serving the run. */
  attach(record: RunRecord): void {
    record.active += 1;
  }

  /** A call serving the run lost its client, so its answer will not arrive. */
  markUnanswered(record: RunRecord, now = Date.now()): void {
    record.unansweredAt = now;
  }

  /**
   * A call stops serving the run. `answered`: its client got the task, so an
   * identical call after this one is a new run. `unanswered`: its client did
   * not, so an identical call soon after continues this run. `failed`: there
   * is no task to continue. Returns the outcome for the record Wiro keeps, or
   * undefined while another call in this process still serves the run.
   */
  release(record: RunRecord, outcome: RunOutcome, now = Date.now()): RunOutcome | undefined {
    record.active = Math.max(0, record.active - 1);
    if (outcome === 'failed') {
      this.forget(record);
      return 'failed';
    }
    if (outcome === 'unanswered') {
      record.unansweredAt = now;
      return record.active === 0 ? 'unanswered' : undefined;
    }
    if (record.active > 0) return undefined;
    this.forget(record);
    return 'answered';
  }

  /** Drops the run, unless a newer run already took its key. */
  forget(record: RunRecord): void {
    if (this.records.get(record.key) === record) this.records.delete(record.key);
  }

  private prune(timing: RunReuseTiming, now: number): void {
    for (const record of this.records.values()) {
      if (record.active > 0) continue;
      const unanswered = record.unansweredAt !== undefined
        && now - record.unansweredAt <= timing.unansweredWindowMs;
      // A run request still on its way stays until it answers or its window ends.
      if (!unanswered) this.records.delete(record.key);
    }
  }

  private trim(): void {
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }
}

/** The ledger every run_model tool in this process shares. */
export const runLedger = new RunLedger();
