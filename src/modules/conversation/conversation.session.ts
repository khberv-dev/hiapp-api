import { Logger } from '@nestjs/common';
import type {
  ChatTurn,
  LlmPort,
  SttConnection,
  SttPort,
  TtsPort,
} from '../ai/ai.types.js';
import { prefetch } from './prefetch.js';
import {
  CloseCode,
  parseClientMessage,
  type ServerMessage,
} from './protocol.js';
import { SentenceSplitter } from './sentence-splitter.js';
import { TurnTimer } from './turn-timer.js';

export interface SessionTransport {
  sendJson(msg: ServerMessage): void;
  sendAudio(pcm: Buffer): void;
  close(code: number, reason: string): void;
}

export interface SessionPorts {
  stt: SttPort;
  llm: LlmPort;
  tts: TtsPort;
}

export interface SessionOptions {
  systemPrompt: string;
  /** Reported in `ready` and in the per-turn timing log. */
  conversationId: string;
  maxHistoryTurns?: number;
  /** Seconds left in the user's daily allowance, reported in `ready`. */
  remainingSec?: number;
  /** Earlier turns of a resumed conversation (LLM context). */
  initialHistory?: ChatTurn[];
  /** Reported as `ready.resumed`. */
  resumed?: boolean;
  /** Also send each turn's timings to the client as `turn_metrics`. */
  sendTurnMetrics?: boolean;
  /**
   * Called for every transcript turn: each final user utterance, and each AI
   * reply as the user heard it (cut at the last fully spoken sentence on barge-in).
   */
  onTurn?: (role: 'user' | 'ai', text: string) => void;
}

interface ActiveTurn {
  id: number;
  controller: AbortController;
  /** Sentences whose audio was fully sent to the client. */
  spoken: string[];
  ttsStarted: boolean;
}

/** Calls `first` when `source` yields its first item. */
async function* tap<T>(
  source: AsyncIterable<T>,
  first: () => void,
): AsyncGenerator<T> {
  let seen = false;
  for await (const item of source) {
    if (!seen) {
      seen = true;
      first();
    }
    yield item;
  }
}

/**
 * One voice conversation (one WebSocket connection):
 *
 *   mic audio → STT → final transcript → LLM stream → sentences → TTS → audio out
 *
 * STT stays open the whole time; reconnecting it is the STT port's job
 * (`ResilientStt`), so the session only reports its status and gives up when
 * the port does. A new final transcript while the AI is still thinking or
 * speaking interrupts it (barge-in): the LLM and TTS requests are aborted and
 * the client is told to flush its playback buffer (`tts_stop`).
 */
export class ConversationSession {
  private readonly logger = new Logger(ConversationSession.name);
  private readonly history: ChatTurn[];
  private stt?: SttConnection;
  private current?: ActiveTurn;
  private turnSeq = 0;
  private closed = false;
  /**
   * For `finalLagMs`: when the client said it stopped talking, and the last
   * interim transcript. Both reset at each final.
   */
  private endOfAudioAt?: number;
  private lastInterimAt?: number;

  constructor(
    private readonly transport: SessionTransport,
    private readonly ports: SessionPorts,
    private readonly opts: SessionOptions,
  ) {
    this.history = (opts.initialHistory ?? []).map((t) => ({ ...t }));
  }

  async start(): Promise<void> {
    await this.connectStt();
    this.transport.sendJson({
      type: 'ready',
      remainingSec: this.opts.remainingSec,
      conversationId: this.opts.conversationId,
      ...(this.opts.resumed ? { resumed: true } : {}),
    });
  }

  handleAudio(pcm: Buffer): void {
    this.stt?.sendAudio(pcm);
  }

  handleText(raw: string): void {
    const msg = parseClientMessage(raw);
    if (!msg) {
      this.transport.sendJson({
        type: 'error',
        message: 'unknown message',
        retryable: false,
      });
      return;
    }
    switch (msg.type) {
      case 'end_of_audio':
        // Only while an utterance is pending: if the server's VAD already
        // finalized it, this signal belongs to no turn.
        if (this.lastInterimAt !== undefined)
          this.endOfAudioAt = performance.now();
        this.stt?.endOfAudio();
        break;
      case 'interrupt':
        this.interrupt();
        break;
      case 'ping':
        this.transport.sendJson({ type: 'pong' });
        break;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    this.stt?.close();
    this.stt = undefined;
  }

  // ---------- STT ----------

  private async connectStt(): Promise<void> {
    const conn = await this.ports.stt.connect({
      onInterim: (text) => {
        if (this.closed) return;
        this.lastInterimAt = performance.now();
        this.transport.sendJson({ type: 'transcript_interim', text });
      },
      onFinal: (text) => {
        if (!this.closed) this.onFinalTranscript(text);
      },
      onStatus: (stt) => {
        if (!this.closed) this.transport.sendJson({ type: 'status', stt });
      },
      onUnexpectedClose: (reason) => {
        if (this.closed) return;
        // The port already retried for its whole budget.
        this.logger.warn(`STT gave up: ${reason}`);
        this.stt = undefined;
        this.close(); // aborts the turn in flight
        this.transport.sendJson({
          type: 'error',
          message: 'speech recognition unavailable',
          retryable: true,
        });
        this.transport.close(CloseCode.InternalError, 'stt unavailable');
      },
    });
    if (this.closed) {
      conn.close();
      return;
    }
    this.stt = conn;
  }

  private onFinalTranscript(raw: string): void {
    const text = raw.trim();
    if (!text || this.closed) return;

    this.interrupt();
    const turnId = ++this.turnSeq;
    const timer = new TurnTimer(turnId, this.opts.conversationId);
    timer.mark('final');
    const ref = this.endOfAudioAt ?? this.lastInterimAt;
    if (ref !== undefined) timer.set('finalLagMs', performance.now() - ref);
    this.endOfAudioAt = undefined;
    this.lastInterimAt = undefined;

    this.transport.sendJson({ type: 'transcript_final', turnId, text });
    this.opts.onTurn?.('user', text);

    const last = this.history.at(-1);
    if (last?.role === 'user') {
      // The previous utterance never got an answer: treat both as one turn.
      last.text = `${last.text} ${text}`;
    } else {
      this.history.push({ role: 'user', text });
    }
    void this.respond(turnId, timer);
  }

  // ---------- LLM + TTS ----------

  private async respond(id: number, timer: TurnTimer): Promise<void> {
    const turn: ActiveTurn = {
      id,
      controller: new AbortController(),
      spoken: [],
      ttsStarted: false,
    };
    this.current = turn;
    const { signal } = turn.controller;
    const splitter = new SentenceSplitter({
      minChars: 20,
      firstChunkMaxChars: 60,
    });
    let playback = Promise.resolve();
    let sentences = 0;
    let outcome: 'ttsEnd' | 'aborted' | 'failed' = 'aborted';

    // Synthesis starts as soon as a sentence is ready (prefetch), but audio
    // is sent strictly in order through the `playback` chain. A sentence that
    // still fails after the TTS port's retries is skipped, not fatal: the
    // user hears the rest, and the text is already on screen via llm_delta.
    const speak = (sentence: string) => {
      const index = sentences++;
      timer.mark('firstSentence');
      const source = this.ports.tts.synthesize(sentence, signal, (p) =>
        timer.servedBy('tts', p),
      );
      const audio = prefetch(
        index === 0 ? tap(source, () => timer.mark('ttsFirstChunk')) : source,
      );
      playback = playback.then(async () => {
        try {
          for await (const chunk of audio) {
            if (signal.aborted) return;
            if (!turn.ttsStarted) {
              turn.ttsStarted = true;
              this.transport.sendJson({
                type: 'tts_start',
                turnId: id,
                sampleRate: this.ports.tts.sampleRate,
              });
            }
            timer.mark('firstAudioSent');
            this.transport.sendAudio(chunk);
          }
          if (!signal.aborted) turn.spoken.push(sentence);
        } catch (err) {
          if (signal.aborted) return;
          this.logger.warn(
            `Turn ${id}: sentence ${index + 1} failed, skipping: ${String(err)}`,
          );
        }
      });
    };

    let text = '';
    try {
      const history = this.history.slice(-(this.opts.maxHistoryTurns ?? 20));
      for await (const delta of this.ports.llm.stream({
        systemPrompt: this.opts.systemPrompt,
        history,
        signal,
        onServed: (p) => timer.servedBy('llm', p),
      })) {
        if (signal.aborted) return;
        timer.mark('llmFirstToken');
        text += delta;
        this.transport.sendJson({ type: 'llm_delta', turnId: id, text: delta });
        splitter.push(delta).forEach(speak);
      }
      if (signal.aborted) return;
      splitter.flush().forEach(speak);
      timer.mark('llmDone');
      this.transport.sendJson({ type: 'llm_done', turnId: id, text });

      await playback;
      if (signal.aborted) return;
      if (sentences > 0 && !turn.ttsStarted) {
        throw new Error('no sentence could be synthesized');
      }
      this.transport.sendJson({ type: 'tts_end', turnId: id });
      outcome = 'ttsEnd';
      if (text.trim()) {
        this.history.push({ role: 'assistant', text: text.trim() });
        this.opts.onTurn?.('ai', text.trim());
      }
      this.current = undefined;
    } catch (err) {
      if (signal.aborted) return;
      outcome = 'failed';
      this.logger.error(`Turn ${id} failed: ${String(err)}`);
      if (this.current === turn) this.interrupt();
      this.transport.sendJson({
        type: 'error',
        message: 'failed to generate a reply',
        retryable: true,
      });
    } finally {
      timer.mark(outcome);
      const metrics = timer.toJSON();
      this.logger.log(JSON.stringify({ evt: 'turn', ...metrics }));
      if (this.opts.sendTurnMetrics && !this.closed)
        this.transport.sendJson({ type: 'turn_metrics', ...metrics });
    }
  }

  /** Barge-in: stop the AI's current reply and keep only what was actually heard. */
  private interrupt(): void {
    const turn = this.current;
    if (!turn) return;
    this.current = undefined;
    turn.controller.abort();
    if (turn.ttsStarted)
      this.transport.sendJson({ type: 'tts_stop', turnId: turn.id });
    if (turn.spoken.length > 0) {
      const heard = turn.spoken.join(' ');
      this.history.push({ role: 'assistant', text: heard });
      this.opts.onTurn?.('ai', heard);
    }
  }
}
