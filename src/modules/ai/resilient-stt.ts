import { Logger } from '@nestjs/common';
import type { SttCallbacks, SttConnection, SttPort } from './ai.types.js';
import { classifyGeminiError } from './provider-error.js';
import { backoffDelay, type BackoffOpts, sleep } from './retry.js';

export interface ResilientSttOptions {
  backoff: BackoffOpts;
  /** Give up after the upstream has been unusable this long. */
  budgetMs: number;
  /** Audio kept for replay after a reconnect (since the last final). */
  replayBufferMs: number;
  /** A connection that lives this long counts as healthy again. */
  healthyAfterMs: number;
  /** Connections in a row that die before `healthyAfterMs`, before giving up. */
  maxQuickFailures: number;
  /** After a `goAway` handover, the old connection is closed this much later. */
  drainMs: number;
}

export const DEFAULT_RESILIENT_STT: ResilientSttOptions = {
  backoff: { baseMs: 250, maxMs: 4000 },
  budgetMs: 20_000,
  replayBufferMs: 5000,
  healthyAfterMs: 5000,
  maxQuickFailures: 5,
  drainMs: 1500,
};

/** PCM s16le 16 kHz mono. */
const BYTES_PER_MS = 32;

/**
 * Wraps any SttPort so the session sees one connection that never dies on
 * its own: `goAway` is handled make-before-break, a dropped connection is
 * reconnected with jittered backoff and the audio since the last final
 * transcript is replayed. `onUnexpectedClose` fires only when the budget is
 * exhausted or the error can't be fixed by retrying (e.g. a bad API key).
 */
export class ResilientStt implements SttPort {
  private readonly opts: ResilientSttOptions;

  constructor(
    private readonly inner: SttPort,
    opts: Partial<ResilientSttOptions> = {},
    private readonly logger = new Logger(ResilientStt.name),
  ) {
    this.opts = { ...DEFAULT_RESILIENT_STT, ...opts };
  }

  async connect(cb: SttCallbacks): Promise<SttConnection> {
    const conn = new ResilientConnection(
      this.inner,
      this.opts,
      cb,
      this.logger,
    );
    await conn.open();
    return conn;
  }
}

interface Slot {
  conn: SttConnection;
  dead: boolean;
  deadReason?: string;
}

class ResilientConnection implements SttConnection {
  private active?: Slot;
  private draining?: Slot;
  private drainTimer?: NodeJS.Timeout;
  private healthyTimer?: NodeJS.Timeout;
  private closed = false;
  private reconnecting = false;
  private handingOver = false;
  /** The active connection died while a handover was in progress. */
  private lostDuringHandover = false;
  private outageStartedAt?: number;
  private connectedAt = 0;
  private quickFailures = 0;
  private ring: Buffer[] = [];
  private ringBytes = 0;
  private readonly ringCap: number;

  constructor(
    private readonly inner: SttPort,
    private readonly opts: ResilientSttOptions,
    private readonly cb: SttCallbacks,
    private readonly logger: Logger,
  ) {
    this.ringCap = opts.replayBufferMs * BYTES_PER_MS;
  }

  /** Initial connect, retried within the budget. Throws if it can't connect. */
  async open(): Promise<void> {
    this.outageStartedAt = Date.now();
    const slot = await this.connectWithRetry();
    if (!slot) throw new Error('STT closed while connecting');
    this.install(slot);
  }

  sendAudio(pcm: Buffer): void {
    if (this.closed) return;
    this.ring.push(pcm);
    this.ringBytes += pcm.length;
    while (this.ringBytes > this.ringCap && this.ring.length > 0) {
      const over = this.ringBytes - this.ringCap;
      const head = this.ring[0];
      if (head.length <= over) {
        this.ring.shift();
        this.ringBytes -= head.length;
      } else {
        this.ring[0] = head.subarray(over);
        this.ringBytes -= over;
      }
    }
    this.active?.conn.sendAudio(pcm);
  }

  endOfAudio(): void {
    if (!this.closed) this.active?.conn.endOfAudio();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.healthyTimer);
    this.finishDrain();
    this.active?.conn.close();
    this.active = undefined;
    this.ring = [];
  }

  // ---------- internals ----------

  private async attach(): Promise<Slot> {
    const slot = { dead: false } as Slot;
    slot.conn = await this.inner.connect({
      onInterim: (text) => {
        if (!this.closed && slot === this.active) this.cb.onInterim(text);
      },
      onFinal: (text) => {
        if (this.closed) return;
        if (slot !== this.active && slot !== this.draining) return;
        this.clearRing();
        this.cb.onFinal(text);
        if (slot === this.draining) this.finishDrain();
      },
      onGoAway: (timeLeftMs) => {
        if (this.closed || slot !== this.active) return;
        this.logger.log(
          `STT goAway (${timeLeftMs ?? '?'} ms left), handing over`,
        );
        void this.handover();
      },
      onUnexpectedClose: (reason) => {
        slot.dead = true;
        slot.deadReason = reason;
        if (this.closed) return;
        if (slot === this.draining) this.finishDrain();
        else if (slot === this.active) this.lost(reason);
      },
    });
    return slot;
  }

  private install(slot: Slot): void {
    this.active = slot;
    this.connectedAt = Date.now();
    clearTimeout(this.healthyTimer);
    this.healthyTimer = setTimeout(() => {
      this.quickFailures = 0;
      this.outageStartedAt = undefined;
    }, this.opts.healthyAfterMs);
  }

  /**
   * Connects with full-jitter backoff until the outage budget runs out.
   * Returns undefined if closed meanwhile; throws on a non-retryable error
   * or when the budget is exhausted.
   */
  private async connectWithRetry(): Promise<Slot | undefined> {
    const started = this.outageStartedAt ?? Date.now();
    for (let n = 0; ; n++) {
      if (this.closed) return undefined;
      try {
        const slot = await this.attach();
        if (this.closed) {
          slot.conn.close();
          return undefined;
        }
        if (!slot.dead) return slot;
        throw new Error(slot.deadReason ?? 'closed right after connecting');
      } catch (err) {
        const error = classifyGeminiError(err, 'stt');
        if (!error.retryable) throw error;
        const delay = backoffDelay(n, this.opts.backoff);
        if (Date.now() - started + delay > this.opts.budgetMs) throw error;
        this.logger.warn(
          `STT connect failed (${error.kind}: ${error.message.slice(0, 200)}), retrying in ${Math.round(delay)} ms`,
        );
        await sleep(delay);
      }
    }
  }

  private lost(reason: string): void {
    this.active = undefined;
    clearTimeout(this.healthyTimer);
    const lived = Date.now() - this.connectedAt;
    this.quickFailures =
      lived < this.opts.healthyAfterMs ? this.quickFailures + 1 : 0;
    this.outageStartedAt ??= Date.now();
    this.logger.warn(`STT connection lost (${reason}), reconnecting`);

    const error = classifyGeminiError(new Error(reason), 'stt');
    if (!error.retryable || this.quickFailures > this.opts.maxQuickFailures) {
      this.fatal(reason);
      return;
    }
    this.cb.onStatus?.('reconnecting');
    if (this.handingOver) {
      this.lostDuringHandover = true;
      return;
    }
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    try {
      const slot = await this.connectWithRetry();
      if (!slot) return;
      this.install(slot);
      this.replay();
      this.cb.onStatus?.('ok');
    } catch (err) {
      this.fatal(String(err));
    } finally {
      this.reconnecting = false;
    }
  }

  /** Make-before-break: keep the old connection until the new one is up. */
  private async handover(): Promise<void> {
    if (this.handingOver || this.reconnecting || this.closed) return;
    this.handingOver = true;
    const old = this.active;
    let slot: Slot | undefined;
    try {
      slot = await this.attach();
    } catch (err) {
      // Keep using the old connection; when it closes, `lost` reconnects.
      this.logger.warn(`STT handover failed: ${String(err)}`);
    } finally {
      this.handingOver = false;
    }

    const oldLost = this.lostDuringHandover;
    this.lostDuringHandover = false;
    if (this.closed) {
      slot?.conn.close();
      return;
    }
    if (!slot || slot.dead) {
      if (oldLost) void this.reconnect();
      return;
    }

    this.install(slot);
    if (oldLost) {
      // The old connection never finalized its audio: replay it here.
      this.replay();
      this.cb.onStatus?.('ok');
    } else if (old) {
      this.finishDrain();
      this.draining = old;
      old.conn.endOfAudio(); // finalize any pending utterance
      this.drainTimer = setTimeout(() => this.finishDrain(), this.opts.drainMs);
    }
  }

  private finishDrain(): void {
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    const old = this.draining;
    this.draining = undefined;
    old?.conn.close();
  }

  private replay(): void {
    for (const chunk of this.ring) this.active?.conn.sendAudio(chunk);
  }

  private clearRing(): void {
    this.ring = [];
    this.ringBytes = 0;
  }

  private fatal(reason: string): void {
    if (this.closed) return;
    this.close();
    this.cb.onUnexpectedClose(`stt unavailable: ${reason}`);
  }
}
