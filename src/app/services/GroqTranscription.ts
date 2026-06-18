/**
 * Claudian Multi-Selection Fork — Groq Whisper transcription
 *
 * Sends recorded audio to Groq's OpenAI-compatible Whisper endpoint and returns
 * the transcript. Groq's free tier needs no credit card and bundles a generous
 * daily quota; whisper-large-v3-turbo gives near-large-v3 accuracy (excellent
 * multilingual, incl. Russian) at very high speed.
 *
 * We POST multipart/form-data via Obsidian's `requestUrl` (not `fetch`) so the
 * call isn't subject to the renderer's CORS policy. Because `requestUrl` takes
 * a raw body, we assemble the multipart payload by hand.
 *
 * The API key is read from settings at call time and is only ever sent to Groq
 * over HTTPS in the Authorization header — never logged.
 */

import { requestUrl } from 'obsidian';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3-turbo';

export interface TranscriptionParams {
  apiKey: string;
  audio: ArrayBuffer;
  /** MIME type of the audio (e.g. "audio/webm"). */
  mimeType: string;
  /** ISO language code (e.g. "ru"), or "auto"/empty to let Whisper detect. */
  language?: string;
}

export interface TranscriptionResult {
  ok: boolean;
  text?: string;
  /** Human-readable error suitable for a Notice. */
  error?: string;
}

/** Pick a sensible filename extension for the multipart part from the MIME type. */
function extensionFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

/** Build a multipart/form-data body. Returns the bytes and the boundary. */
function buildMultipart(
  fields: Record<string, string>,
  file: { name: string; type: string; data: ArrayBuffer },
): { body: ArrayBuffer; boundary: string } {
  const boundary = '----ClaudianVoice' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(enc.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
    ));
  }

  chunks.push(enc.encode(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
    `Content-Type: ${file.type}\r\n\r\n`,
  ));
  chunks.push(new Uint8Array(file.data));
  chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { body.set(c, offset); offset += c.length; }
  return { body: body.buffer, boundary };
}

export async function transcribeAudio(params: TranscriptionParams): Promise<TranscriptionResult> {
  const { apiKey, audio, mimeType, language } = params;
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, error: 'Groq API-ключ не задан. Впишите его в настройках Claudian.' };
  }
  if (!audio || audio.byteLength === 0) {
    return { ok: false, error: 'Пустая запись — ничего не услышал.' };
  }

  const fields: Record<string, string> = {
    model: MODEL,
    response_format: 'json',
    temperature: '0',
  };
  if (language && language !== 'auto') fields.language = language;

  const { body, boundary } = buildMultipart(fields, {
    name: `audio.${extensionFor(mimeType)}`,
    type: mimeType || 'audio/webm',
    data: audio,
  });

  let resp;
  try {
    resp = await requestUrl({
      url: GROQ_ENDPOINT,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      throw: false,
    });
  } catch {
    return { ok: false, error: 'Сеть недоступна или запрос к Groq не прошёл.' };
  }

  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, error: 'Groq отклонил ключ (401/403). Проверьте API-ключ в настройках.' };
  }
  if (resp.status === 429) {
    return { ok: false, error: 'Groq: превышен лимит запросов (429). Попробуйте чуть позже.' };
  }
  if (resp.status < 200 || resp.status >= 300) {
    let detail = '';
    try {
      const j = resp.json as { error?: { message?: string } };
      detail = j?.error?.message ? ` — ${j.error.message}` : '';
    } catch { /* ignore */ }
    return { ok: false, error: `Groq вернул ошибку ${resp.status}${detail}.` };
  }

  let text: string;
  try {
    const j = resp.json as { text?: string };
    text = (j?.text ?? '').trim();
  } catch {
    return { ok: false, error: 'Не удалось разобрать ответ Groq.' };
  }

  if (!text) return { ok: false, error: 'Транскрипт пустой — речь не распознана.' };
  return { ok: true, text };
}
