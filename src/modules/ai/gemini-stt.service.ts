import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenAI,
  type LiveServerMessage,
  Modality,
  type Session,
} from '@google/genai';
import { GENAI } from './genai.provider.js';
import type { SttCallbacks, SttConnection, SttPort } from './ai.types.js';

const CONNECT_TIMEOUT_MS = 10_000;

/** Streaming speech-to-text over the Gemini Live API. */
@Injectable()
export class GeminiSttService implements SttPort {
  private readonly model: string;

  constructor(
    @Inject(GENAI) private readonly ai: GoogleGenAI,
    config: ConfigService,
  ) {
    this.model = config.get('STT_MODEL') ?? 'gemini-3.5-transcribe-live';
  }

  async connect(cb: SttCallbacks): Promise<SttConnection> {
    let connected = false;
    let closed = false;
    let rejectConnect: (err: Error) => void = () => undefined;
    const failedEarly = new Promise<never>(
      (_, reject) => (rejectConnect = reject),
    );

    const fail = (reason: string) => {
      if (closed) return;
      closed = true;
      // The SDK's connect() never settles if the server closes the socket
      // before setup completes (e.g. invalid API key), so reject it ourselves.
      if (connected) cb.onUnexpectedClose(reason);
      else rejectConnect(new Error(`STT connect failed: ${reason}`));
    };

    const connecting = this.ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.TEXT],
        // Empty list = automatic language detection.
        inputAudioTranscription: { languageCodes: [] },
      },
      callbacks: {
        onmessage: (msg: LiveServerMessage) => {
          const content = msg.serverContent;
          const interim = content?.interimInputTranscription?.text;
          if (interim) cb.onInterim(interim);
          const final = content?.inputTranscription?.text;
          if (final) cb.onFinal(final);
          // Sessions are time-capped; let the caller reconnect.
          if (msg.goAway) fail('goAway');
        },
        onerror: (e: ErrorEvent) => fail(`error: ${e.message}`),
        onclose: (e: CloseEvent) => fail(`closed: ${e.code} ${e.reason}`),
      },
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        fail('timeout');
        reject(
          new Error(`STT connect timed out after ${CONNECT_TIMEOUT_MS} ms`),
        );
      }, CONNECT_TIMEOUT_MS);
    });

    let session: Session;
    try {
      session = await Promise.race([connecting, failedEarly, timeout]);
    } catch (err) {
      // If the SDK resolves later anyway, don't leak the socket.
      void connecting.then((s) => s.close()).catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    connected = true;

    return {
      sendAudio: (pcm) => {
        if (closed) return;
        session.sendRealtimeInput({
          audio: {
            data: pcm.toString('base64'),
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      },
      endOfAudio: () => {
        if (!closed) session.sendRealtimeInput({ audioStreamEnd: true });
      },
      close: () => {
        if (closed) return;
        closed = true;
        session.close();
      },
    };
  }
}
