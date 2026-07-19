import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export async function transcribeAudio(buffer, mimetype) {
  if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY no configurado');

  const ext  = mimetype?.includes('mp4') ? 'mp4' : mimetype?.includes('webm') ? 'webm' : 'ogg';
  const blob = new Blob([buffer], { type: mimetype || 'audio/ogg' });
  const form = new FormData();
  form.append('file', blob, 'audio.' + ext);
  form.append('model', 'whisper-1');
  form.append('language', 'es');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + config.openai.apiKey },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Whisper error ' + res.status + ': ' + err);
  }

  const data = await res.json();
  const text = data.text?.trim() || '';
  logger.info({ chars: text.length }, 'Audio transcripto');
  return text;
}
