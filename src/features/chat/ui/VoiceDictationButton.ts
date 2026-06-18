/**
 * Claudian Multi-Selection Fork — Voice dictation button
 *
 * A mic button for the composer toolbar. Tap to start recording, tap again to
 * stop; the audio is transcribed via Groq Whisper and inserted at the cursor in
 * the prompt textarea (mixing with already-typed text, like the Claude app).
 *
 * States: idle → recording → transcribing → idle. Errors surface as a Notice
 * and the button returns to idle, always releasing the mic stream.
 *
 * Audio is captured with MediaRecorder (Chromium's audio/webm;opus inside
 * Obsidian's Electron). The mic permission is requested on first use via
 * getUserMedia and macOS prompts once.
 */

import { Notice, setIcon } from 'obsidian';

import { transcribeAudio } from '../../../app/services/GroqTranscription';

type VoiceState = 'idle' | 'recording' | 'transcribing';

export interface VoiceDictationDeps {
  getApiKey: () => string;
  getLanguage: () => string;
  /** Insert transcribed text into the composer at the cursor. */
  insertText: (text: string) => void;
}

export class VoiceDictationButton {
  private buttonEl: HTMLButtonElement;
  private deps: VoiceDictationDeps;
  private state: VoiceState = 'idle';

  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  constructor(parentEl: HTMLElement, deps: VoiceDictationDeps) {
    this.deps = deps;
    this.buttonEl = parentEl.createEl('button', {
      cls: 'claudian-voice-btn',
      attr: { type: 'button', 'aria-label': 'Голосовой ввод', title: 'Голосовой ввод' },
    });
    setIcon(this.buttonEl, 'mic');
    this.buttonEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.onClick();
    });
  }

  dispose(): void {
    this.teardownStream();
    this.buttonEl.remove();
  }

  private async onClick(): Promise<void> {
    if (this.state === 'transcribing') return; // busy, ignore
    if (this.state === 'recording') { this.stopRecording(); return; }
    await this.startRecording();
  }

  private async startRecording(): Promise<void> {
    const apiKey = this.deps.getApiKey();
    if (!apiKey || !apiKey.trim()) {
      new Notice('Добавьте бесплатный Groq API-ключ в настройках Claudian, чтобы пользоваться голосовым вводом.');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        new Notice('Доступ к микрофону запрещён. Разрешите его для Obsidian в Системных настройках → Конфиденциальность → Микрофон.');
      } else if (name === 'NotFoundError') {
        new Notice('Микрофон не найден.');
      } else {
        new Notice('Не удалось получить доступ к микрофону.');
      }
      return;
    }

    this.mediaStream = stream;
    this.chunks = [];

    const mimeType = this.pickMimeType();
    try {
      this.recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch {
      this.recorder = new MediaRecorder(stream);
    }

    this.recorder.addEventListener('dataavailable', (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    });
    this.recorder.addEventListener('stop', () => { void this.onRecordingStopped(); });

    this.recorder.start();
    this.setState('recording');
  }

  private stopRecording(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      // Transition UI immediately; transcription kicks off in the stop handler.
      this.setState('transcribing');
      this.recorder.stop();
    } else {
      this.teardownStream();
      this.setState('idle');
    }
  }

  private async onRecordingStopped(): Promise<void> {
    const recordedType = this.recorder?.mimeType || (this.chunks[0]?.type ?? 'audio/webm');
    this.teardownStream();

    const blob = new Blob(this.chunks, { type: recordedType });
    this.chunks = [];

    if (blob.size === 0) {
      new Notice('Запись пустая — ничего не услышал.');
      this.setState('idle');
      return;
    }

    let audio: ArrayBuffer;
    try {
      audio = await blob.arrayBuffer();
    } catch {
      new Notice('Не удалось прочитать аудио.');
      this.setState('idle');
      return;
    }

    const result = await transcribeAudio({
      apiKey: this.deps.getApiKey(),
      audio,
      mimeType: blob.type || 'audio/webm',
      language: this.deps.getLanguage(),
    });

    if (!result.ok) {
      new Notice(result.error ?? 'Ошибка транскрипции.');
      this.setState('idle');
      return;
    }

    this.deps.insertText(result.text ?? '');
    this.setState('idle');
  }

  /** Prefer opus-in-webm; fall back to whatever the platform supports. */
  private pickMimeType(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    const supported = (window as unknown as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder?.isTypeSupported;
    if (typeof supported === 'function') {
      for (const c of candidates) {
        try { if (supported(c)) return c; } catch { /* ignore */ }
      }
    }
    return '';
  }

  private teardownStream(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* ignore */ }
    }
    this.recorder = null;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      this.mediaStream = null;
    }
  }

  private setState(state: VoiceState): void {
    this.state = state;
    this.buttonEl.removeClass('claudian-voice-btn--recording');
    this.buttonEl.removeClass('claudian-voice-btn--transcribing');
    this.buttonEl.toggleAttribute('disabled', state === 'transcribing');
    switch (state) {
      case 'idle':
        setIcon(this.buttonEl, 'mic');
        this.buttonEl.setAttr('aria-label', 'Голосовой ввод');
        this.buttonEl.setAttr('title', 'Голосовой ввод');
        break;
      case 'recording':
        setIcon(this.buttonEl, 'square');
        this.buttonEl.addClass('claudian-voice-btn--recording');
        this.buttonEl.setAttr('aria-label', 'Остановить запись');
        this.buttonEl.setAttr('title', 'Остановить и распознать');
        break;
      case 'transcribing':
        setIcon(this.buttonEl, 'loader-2');
        this.buttonEl.addClass('claudian-voice-btn--transcribing');
        this.buttonEl.setAttr('aria-label', 'Распознаю…');
        this.buttonEl.setAttr('title', 'Распознаю…');
        break;
    }
  }
}
