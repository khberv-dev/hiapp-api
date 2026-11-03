import { Logger } from '@nestjs/common';
import type {
  ChatTurn,
  LlmPort,
  SttConnection,
  SttPort,
  TtsPort,
} from '../ai/ai.types.js';
import { prefetch } from './prefetch.js';
import { parseClientMessage, type ServerMessage } from './protocol.js';
import { SentenceSplitter } from './sentence-splitter.js';

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
  maxHistoryTurns?: number;
  /** Delays between STT reconnect attempts. */
  sttRetryDelaysMs?: number[];
  /** Seconds left in the user's daily allowance, reported in `ready`. */
  remainingSec?: number;
  /**
   * Called for every transcript turn: each final user utterance, and each AI
   * reply as the user heard it (cut at the last fully spoken sentence on barge-in).
   */
  onTurn?: (role: 'user' | 'ai', text: string) => void;
}

const STT_HEALTHY_AFTER_MS = 5000;

interface ActiveTurn {
  id: number;
  controller: AbortController;
  /** Sentences whose audio was fully sent to the client. */
  spoken: string[];
  ttsStarted: boolean;
}

/**
 * One voice conversation (one WebSocket connection):
 *
 *   mic audio → STT → final transcript → LLM stream → sentences → TTS → audio out
 *
 * STT stays open the whole time. A new final transcript while the AI is still
 * thinking or speaking interrupts it (barge-in): the LLM and TTS requests are
 * aborted and the client is told to flush its playback buffer (`tts_stop`).
 */
export class ConversationSession {
  private readonly logger = new Logger(ConversationSession.name);
  private readonly history: ChatTurn[] = [];
  private stt?: SttConnection;
  /** Bumped per STT connection so callbacks from stale connections are ignored. */
  private sttGen = 0;
  private sttConnectedAt = 0;
  private sttQuickFailures = 0;
  private sttReconnecting = false;
  private current?: ActiveTurn;
  private turnSeq = 0;
  private closed = false;

  constructor(
    private readonly transport: SessionTransport,
    private readonly ports: SessionPorts,
    private readonly opts: SessionOptions,
  ) {}

  async start(): Promise<void> {
    await this.connectStt();
    this.transport.sendJson({
      type: 'ready',
      remainingSec: this.opts.remainingSec,
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
    const gen = ++this.sttGen;
    const live = () => gen === this.sttGen && !this.closed;
    const conn = await this.ports.stt.connect({
      onInterim: (text) => {
        if (live())
          this.transport.sendJson({ type: 'transcript_interim', text });
      },
      onFinal: (text) => {
        if (live()) this.onFinalTranscript(text);
      },
      onUnexpectedClose: (reason) => {
        if (live()) void this.reconnectStt(reason);
      },
    });
    if (!live()) {
      conn.close();
      return;
    }
    this.stt = conn;
    this.sttConnectedAt = Date.now();
  }

  /**
   * Live sessions are time-capped (~10 min) and can drop: reconnect
   * transparently. A connection that dies within a few seconds counts as a
   * failure, so a persistent problem (e.g. bad API key) can't loop forever.
   */
  private async reconnectStt(reason: string): Promise<void> {
    if (this.closed || this.sttReconnecting) return;
    this.sttReconnecting = true;
    this.stt = undefined;
    this.sttGen++; // ignore anything the dead connection still emits
    const delays = this.opts.sttRetryDelaysMs ?? [200, 400, 800];
    const lived = Date.now() - this.sttConnectedAt;
    this.sttQuickFailures =
      lived < STT_HEALTHY_AFTER_MS ? this.sttQuickFailures + 1 : 0;
    this.logger.warn(`STT connection lost (${reason}), reconnecting`);

    try {
      if (this.sttQuickFailures <= delays.length) {
        for (const delay of delays) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (this.closed) return;
          try {
            await this.connectStt();
            return;
          } catch (err) {
            this.logger.warn(`STT reconnect failed: ${String(err)}`);
          }
        }
      }
      this.transport.sendJson({
        type: 'error',
        message: 'speech recognition unavailable',
        retryable: true,
      });
      this.transport.close(1011, 'stt unavailable');
    } finally {
      this.sttReconnecting = false;
    }
  }

  private onFinalTranscript(raw: string): void {
    const text = raw.trim();
    if (!text || this.closed) return;

    this.interrupt();
    const turnId = ++this.turnSeq;
    this.transport.sendJson({ type: 'transcript_final', turnId, text });
    this.opts.onTurn?.('user', text);

    const last = this.history.at(-1);
    if (last?.role === 'user') {
      // The previous utterance never got an answer: treat both as one turn.
      last.text = `${last.text} ${text}`;
    } else {
      this.history.push({ role: 'user', text });
    }
    void this.respond(turnId);
  }

  // ---------- LLM + TTS ----------

  private async respond(id: number): Promise<void> {
    const turn: ActiveTurn = {
      id,
      controller: new AbortController(),
      spoken: [],
      ttsStarted: false,
    };
    this.current = turn;
    const { signal } = turn.controller;
    const splitter = new SentenceSplitter();
    let playback = Promise.resolve();

    // Synthesis starts as soon as a sentence is ready (prefetch), but audio
    // is sent strictly in order through the `playback` chain.
    const speak = (sentence: string) => {
      const audio = prefetch(this.ports.tts.synthesize(sentence, signal));
      playback = playback.then(async () => {
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
          this.transport.sendAudio(chunk);
        }
        if (!signal.aborted) turn.spoken.push(sentence);
      });
    };

    let text = '';
    try {
      const history = this.history.slice(-(this.opts.maxHistoryTurns ?? 20));
      for await (const delta of this.ports.llm.stream({
        systemPrompt: this.opts.systemPrompt,
        history,
        signal,
      })) {
        if (signal.aborted) return;
        text += delta;
        this.transport.sendJson({ type: 'llm_delta', turnId: id, text: delta });
        splitter.push(delta).forEach(speak);
      }
      if (signal.aborted) return;
      splitter.flush().forEach(speak);
      this.transport.sendJson({ type: 'llm_done', turnId: id, text });

      await playback;
      if (signal.aborted) return;
      this.transport.sendJson({ type: 'tts_end', turnId: id });
      if (text.trim()) {
        this.history.push({ role: 'assistant', text: text.trim() });
        this.opts.onTurn?.('ai', text.trim());
      }
      this.current = undefined;
    } catch (err) {
      if (signal.aborted) return;
      this.logger.error(`Turn ${id} failed: ${String(err)}`);
      if (this.current === turn) this.interrupt();
      this.transport.sendJson({
        type: 'error',
        message: 'failed to generate a reply',
        retryable: true,
      });
    } finally {
      // A failed sentence must not surface as an unhandled rejection.
      void playback.catch(() => undefined);
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
