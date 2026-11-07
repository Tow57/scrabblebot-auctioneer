import { Worker } from "node:worker_threads";
import type { Decision, MatchSnapshot } from "./client.js";

interface Job {
  id: number;
  snapshot: MatchSnapshot;
  resolve: (decision: Decision | null) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** One reusable worker, one active job, and at most one newest pending state. */
export class StrategyWorker {
  private worker: Worker | undefined;
  private active: Job | undefined;
  private pending: Job | undefined;
  private nextId = 0;
  private stopped = false;
  private ready = false;
  private startup: Promise<void> | undefined;

  constructor(private readonly dictionaryPath?: string, private readonly timeoutMs = 150) {}

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Worker has stopped"));
    if (this.ready) return Promise.resolve();
    if (this.startup) return this.startup;
    this.startup = new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL("./worker-bootstrap.mjs", import.meta.url), {
        execArgv: [],
        workerData: { dictionaryPath: this.dictionaryPath },
      });
      this.worker = worker;
      let initialized = false;
      const startupTimer = setTimeout(() => failed(new Error("Dictionary/worker startup exceeded 15 seconds")), 15_000);
      const failed = (error: Error) => {
        if (this.worker !== worker) return;
        clearTimeout(startupTimer);
        this.ready = false;
        this.worker = undefined;
        this.startup = undefined;
        if (this.active) this.finish(this.active, null);
        void worker.terminate();
        if (!initialized) reject(new Error(`Could not initialize strategy dictionary/worker: ${error.message}`));
        else if (this.pending && !this.stopped) void this.start().catch(() => this.failPending());
      };
      worker.on("error", failed);
      worker.on("exit", code => {
        if (this.worker === worker && !this.stopped) failed(new Error(`Strategy worker exited (${code})`));
      });
      worker.on("message", message => {
        if (this.worker !== worker) return;
        if (message.ready === true) {
          initialized = true;
          clearTimeout(startupTimer);
          this.ready = true;
          this.startup = undefined;
          resolve();
          this.dispatch();
          return;
        }
        const job = this.active;
        if (!job || message.id !== job.id || message.matchId !== job.snapshot.matchId || message.auctionId !== job.snapshot.auctionId) return;
        this.finish(job, message.error ? null : message.decision);
        this.dispatch();
      });
    });
    return this.startup;
  }

  evaluate(snapshot: MatchSnapshot): Promise<Decision | null> {
    if (this.stopped) return Promise.resolve(null);
    return new Promise(resolve => {
      if (this.pending) this.finish(this.pending, null);
      const job: Job = { id: ++this.nextId, snapshot, resolve };
      this.pending = job;
      // The deadline includes queue time, so fallback never waits for another
      // job or a restarted worker to finish initializing.
      job.timer = setTimeout(() => this.timeout(job), this.timeoutMs);
      if (this.ready) this.dispatch();
      else void this.start().catch(() => this.failPending());
    });
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.active) this.finish(this.active, null);
    this.failPending();
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
  }

  private failPending(): void {
    if (this.pending) this.finish(this.pending, null);
    this.pending = undefined;
  }

  private finish(job: Job, decision: Decision | null): void {
    if (job.timer) clearTimeout(job.timer);
    if (this.active === job) this.active = undefined;
    job.resolve(decision);
  }

  private dispatch(): void {
    if (!this.ready || !this.worker || this.active || !this.pending || this.stopped) return;
    const job = this.pending;
    this.pending = undefined;
    this.active = job;
    this.worker.postMessage({ id: job.id, snapshot: job.snapshot });
  }

  private timeout(job: Job): void {
    if (this.pending === job) {
      this.pending = undefined;
      this.finish(job, null);
      return;
    }
    if (this.active !== job) return;
    const worker = this.worker;
    this.ready = false;
    this.worker = undefined;
    this.startup = undefined;
    this.finish(job, null);
    if (worker) void worker.terminate();
    if (this.pending && !this.stopped) void this.start().catch(() => this.failPending());
  }
}
