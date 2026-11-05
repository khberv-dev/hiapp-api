import {
  EndSensitivity,
  GoogleGenAI,
  type LiveServerMessage,
  Modality,
  type Session,
} from '@google/genai';
import type { SttCallbacks, SttConnection, SttPort } from './ai.types.js';
import { classifyGeminiError, ProviderError } from './provider-error.js';

const CONNECT_TIMEOUT_MS = 10_000;

export interface GeminiSttOptions {
  model: string;
  /** BCP-47 codes; empty = automatic detection. */
  languageCodes: string[];
  /** Server-side silence before end of speech is committed. */
  silenceDurationMs: number;
}

/** "12.5s" → 12500 (protobuf Duration as JSON). */
function parseDuration(d?: string): number | undefined {
  const m = d ? /^(\d+(?:\.\d+)?)s$/.exec(d) : null;
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

/**
 * One Gemini Live transcription connection. It does not reconnect by itself:
 * `goAway` is reported through `onGoAway`, and a dropped connection through
 * `onUnexpectedClose`; `ResilientStt` handles both.
 */
export class GeminiStt implements SttPort {
  readonly name: string;

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly opts: GeminiSttOptions,
  ) {
    this.name = `gemini:${opts.model}`;
  }

  async connect(cb: SttCallbacks): Promise<SttConnection> {
    let session: Session | undefined;
    let closed = false;
    let rejectConnect: (err: Error) => void = () => undefined;
    const failedEarly = new Promise<never>(
      (_, reject) => (rejectConnect = reject),
    );

    /** Idempotent; always closes the Live session we're leaving. */
    const fail = (reason: string) => {
      if (closed) return;
      closed = true;
      if (session) {
        try {
          session.close();
        } catch {
          // already closed
        }
        cb.onUnexpectedClose(reason);
      } else {
        // The SDK's connect() never settles if the server closes the socket
        // before setup completes (e.g. invalid API key), so reject it ourselves.
        rejectConnect(classifyGeminiError(new Error(reason), this.name));
      }
    };

    const connecting = this.ai.live.connect({
      model: this.opts.model,
      config: {
        responseModalities: [Modality.TEXT],
        inputAudioTranscription: { languageCodes: this.opts.languageCodes },
        realtimeInputConfig: {
          automaticActivityDetection: {
            // Shorter silence wait = earlier final transcript; learners pause
            // a lot, so going much below ~500 ms cuts them off.
            silenceDurationMs: this.opts.silenceDurationMs,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
          },
        },
      },
      callbacks: {
        onmessage: (msg: LiveServerMessage) => {
          if (closed) return;
          const content = msg.serverContent;
          const interim = content?.interimInputTranscription?.text;
          if (interim) cb.onInterim(interim);
          const final = content?.inputTranscription?.text;
          if (final) cb.onFinal(final);
          if (msg.goAway) cb.onGoAway?.(parseDuration(msg.goAway.timeLeft));
        },
        onerror: (e: ErrorEvent) => fail(`error: ${e.message}`),
        onclose: (e: CloseEvent) => fail(`closed: ${e.code} ${e.reason}`),
      },
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        closed = true;
        reject(
          new ProviderError(
            'timeout',
            this.name,
            `connect timed out after ${CONNECT_TIMEOUT_MS} ms`,
          ),
        );
      }, CONNECT_TIMEOUT_MS);
    });

    try {
      session = await Promise.race([connecting, failedEarly, timeout]);
    } catch (err) {
      closed = true;
      // If the SDK resolves later anyway, don't leak the socket.
      void connecting.then((s) => s.close()).catch(() => undefined);
      throw classifyGeminiError(err, this.name);
    } finally {
      clearTimeout(timer);
    }
    const live = session;

    return {
      sendAudio: (pcm) => {
        if (closed) return;
        try {
          live.sendRealtimeInput({
            audio: {
              data: pcm.toString('base64'),
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        } catch (err) {
          fail(`send failed: ${String(err)}`);
        }
      },
      endOfAudio: () => {
        if (closed) return;
        try {
          live.sendRealtimeInput({ audioStreamEnd: true });
        } catch (err) {
          fail(`send failed: ${String(err)}`);
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        try {
          live.close();
        } catch {
          // already closed
        }
      },
    };
  }
}
