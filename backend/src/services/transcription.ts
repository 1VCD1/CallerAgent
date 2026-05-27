import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { WebSocket } from 'ws';
import { config } from '../config';
import { query } from '../db/client';

const deepgram = createClient(config.deepgram.apiKey);

export type TranscriptCallback = (text: string, isFinal: boolean, speakerChanged: boolean) => void;

export class DeepgramTranscriptionSession {
  private dgSocket: ReturnType<typeof deepgram.listen.live> | null = null;
  private callId: string;
  private onTranscript: TranscriptCallback;
  private buffer: string = '';
  private lastSpeaker: number | null = null;
  private language: string;

  constructor(callId: string, onTranscript: TranscriptCallback, language = 'en-US') {
    this.callId = callId;
    this.onTranscript = onTranscript;
    this.language = language;
  }

  start(): void {
    const isEnglish = this.language.startsWith('en');
    this.dgSocket = deepgram.listen.live({
      model: isEnglish ? 'nova-2-phonecall' : 'nova-2',
      language: this.language,
      smart_format: true,
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      interim_results: true,
      endpointing: 300,
      diarize: true,
    });

    this.dgSocket.on(LiveTranscriptionEvents.Open, () => {
      console.log(`[Deepgram] Session opened for call ${this.callId}`);
    });

    this.dgSocket.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const alt = data.channel?.alternatives?.[0];
      const transcript = alt?.transcript ?? '';
      const isFinal = data.is_final ?? false;

      if (!transcript) return;

      // Detect speaker change via diarization
      const currentSpeaker = alt?.words?.[0]?.speaker ?? null;
      const speakerChanged = currentSpeaker !== null &&
                             this.lastSpeaker !== null &&
                             currentSpeaker !== this.lastSpeaker;
      if (currentSpeaker !== null) this.lastSpeaker = currentSpeaker;

      if (speakerChanged) {
        console.log(`[Deepgram] Speaker changed: ${this.lastSpeaker} → ${currentSpeaker} for call ${this.callId}`);
      }

      this.onTranscript(transcript, isFinal, speakerChanged);

      if (isFinal) {
        this.buffer += ' ' + transcript;
        await this.persistTranscript(transcript);
      }
    });

    this.dgSocket.on(LiveTranscriptionEvents.Error, (err) => {
      console.error(`[Deepgram] Error for call ${this.callId}:`, err);
    });

    this.dgSocket.on(LiveTranscriptionEvents.Close, () => {
      console.log(`[Deepgram] Session closed for call ${this.callId}`);
    });
  }

  sendAudio(audioChunk: Buffer): void {
    if (this.dgSocket?.getReadyState() === WebSocket.OPEN) {
      this.dgSocket.send(audioChunk.buffer.slice(
        audioChunk.byteOffset,
        audioChunk.byteOffset + audioChunk.byteLength
      ) as ArrayBuffer);
    }
  }

  getFullTranscript(): string {
    return this.buffer.trim();
  }

  stop(): void {
    this.dgSocket?.finish();
    this.dgSocket = null;
  }

  private async persistTranscript(text: string): Promise<void> {
    await query(
      `INSERT INTO transcripts (call_id, speaker, text) VALUES ($1, $2, $3)`,
      [this.callId, 'IVR', text]
    );
  }
}
