#!/usr/bin/env node
// Usage: TOKEN=<accessToken> node scripts/test-client.mjs <input.pcm> [ws://localhost:3000/v1/conversation]
//
// TOKEN: the accessToken from POST /auth/google, sent as `Authorization: Bearer`.
// input.pcm: PCM s16le, 16 kHz, mono. Make one from any audio file with:
//   ffmpeg -i speech.wav -f s16le -ar 16000 -ac 1 input.pcm
// The AI's voice is written to out.pcm; play it with:
//   ffplay -f s16le -ar 24000 -ac 1 out.pcm   (use the sampleRate from tts_start)
import { createWriteStream, readFileSync } from 'node:fs';
import WebSocket from 'ws';

const [file, url = 'ws://localhost:3000/v1/conversation'] =
  process.argv.slice(2);
const token = process.env.TOKEN;
if (!file || !token) {
  console.error(
    'usage: TOKEN=<accessToken> node scripts/test-client.mjs <input.pcm> [url]',
  );
  process.exit(1);
}

const FRAME_BYTES = 3200; // 100 ms at 16 kHz s16le mono
const pcm = Buffer.concat([readFileSync(file), Buffer.alloc(FRAME_BYTES * 15)]); // + 1.5 s silence
const out = createWriteStream('out.pcm');
const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${token}` },
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    out.write(data);
    return;
  }
  const msg = JSON.parse(data.toString());
  switch (msg.type) {
    case 'ready':
      console.log(
        `ready (conversation ${msg.conversationId}), streaming audio...`,
      );
      void stream();
      break;
    case 'transcript_interim':
      process.stdout.write(`\r… ${msg.text}`);
      break;
    case 'transcript_final':
      console.log(`\nYOU: ${msg.text}`);
      break;
    case 'llm_done':
      console.log(`AI:  ${msg.text}`);
      break;
    case 'tts_start':
      console.log(`(audio at ${msg.sampleRate} Hz)`);
      break;
    case 'tts_end':
      console.log('done, audio saved to out.pcm');
      ws.close(1000);
      break;
    case 'status':
      console.log(`(speech recognition: ${msg.stt})`);
      break;
    case 'error':
      console.error('error:', msg.message);
      break;
  }
});
ws.on('close', (code, reason) => {
  out.end();
  console.log(`closed ${code} ${reason}`);
});

async function stream() {
  for (
    let i = 0;
    i < pcm.length && ws.readyState === WebSocket.OPEN;
    i += FRAME_BYTES
  ) {
    ws.send(pcm.subarray(i, i + FRAME_BYTES));
    await new Promise((r) => setTimeout(r, 100)); // real-time pacing
  }
  ws.send(JSON.stringify({ type: 'end_of_audio' }));
}
