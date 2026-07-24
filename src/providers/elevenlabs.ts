/**
 * ElevenLabs adapter. Unlike the marketplaces, this is a fixed first-party
 * API: the ref is the path after /v1/, and the input is the request body,
 * passed verbatim. The API is synchronous (bytes come back on the same
 * request), so there is no queue, status, or cancel.
 *
 * Refs:
 *   text-to-speech/{voiceId}                  audio bytes back
 *   text-to-speech/{voiceId}/with-timestamps  JSON back: base64 audio +
 *                                             character alignment, converted
 *                                             here to a word-level
 *                                             .timing.json sidecar
 *   music                                     audio bytes back
 *   models   (GET)                            list available models
 *   voices   (GET, /v2)                       search voices, e.g.
 *                                             input {"search": "Rachel"}
 *
 * One lift: `output_format` inside the input is moved to the query string
 * because that is where this API takes it (default mp3_44100_128).
 */
import { GatewayError } from '../errors.js';
import type { InspectResult, JobResult, ProviderAdapter, RunArgs } from './types.js';
import { requireEnv } from './types.js';

const API = 'https://api.elevenlabs.io';

const GET_REFS: Record<string, string> = {
  models: '/v1/models',
  voices: '/v2/voices',
};

function extForFormat(format: string): string {
  if (format.startsWith('mp3')) return '.mp3';
  if (format.startsWith('opus')) return '.ogg';
  if (format.startsWith('pcm') || format.startsWith('ulaw') || format.startsWith('alaw')) return '.wav';
  return '.mp3';
}

type Alignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

/** Character-level alignment to a word list (split on whitespace). */
function wordsFromAlignment(a: Alignment): Array<{ text: string; startSec: number; endSec: number }> {
  const words: Array<{ text: string; startSec: number; endSec: number }> = [];
  let text = '';
  let start = 0;
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (/\s/.test(ch)) {
      if (text !== '') {
        words.push({ text, startSec: start, endSec: a.character_end_times_seconds[i - 1] ?? start });
      }
      text = '';
    } else {
      if (text === '') start = a.character_start_times_seconds[i];
      text += ch;
    }
  }
  if (text !== '') {
    words.push({
      text,
      startSec: start,
      endSec: a.character_end_times_seconds[a.characters.length - 1] ?? start,
    });
  }
  return words;
}

async function run({ ref, input, signal, onUpdate }: RunArgs): Promise<JobResult> {
  const key = requireEnv('ELEVENLABS_API_KEY', 'elevenlabs');

  let url: string;
  let init: RequestInit;
  if (GET_REFS[ref]) {
    const params = new URLSearchParams(
      Object.entries(input).map(([k, v]) => [k, String(v)]),
    ).toString();
    url = `${API}${GET_REFS[ref]}${params ? `?${params}` : ''}`;
    init = { method: 'GET', headers: { 'xi-api-key': key }, signal };
  } else {
    const { output_format, ...body } = input;
    const format = typeof output_format === 'string' ? output_format : 'mp3_44100_128';
    url = `${API}/v1/${ref}?output_format=${encodeURIComponent(format)}`;
    init = {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    };
  }

  onUpdate({ phase: 'requesting' });
  const res = await fetch(url, init);
  const requestId = res.headers.get('request-id') ?? res.headers.get('x-request-id');

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new GatewayError(
      `ElevenLabs ${res.status} on ${ref}: ${bodyText.slice(0, 400)}`,
      {
        kind: res.status === 401 || res.status === 403 ? 'auth' : res.status === 422 ? 'validation' : res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'transient' : 'permanent',
        provider: 'elevenlabs',
        status: res.status,
        requestId: requestId ?? undefined,
      },
    );
  }
  if (requestId) onUpdate({ requestId });

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data.audio_base64 === 'string') {
      const { audio_base64, ...rest } = data;
      const alignment = (data.normalized_alignment ?? data.alignment) as Alignment | undefined;
      const format = typeof input.output_format === 'string' ? input.output_format : 'mp3_44100_128';
      return {
        output: rest,
        requestId,
        binary: { data: Buffer.from(audio_base64, 'base64'), ext: extForFormat(format) },
        sidecars: alignment ? [{ suffix: '.timing.json', data: { words: wordsFromAlignment(alignment) } }] : undefined,
      };
    }
    return { output: data, requestId };
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const format = typeof input.output_format === 'string' ? input.output_format : 'mp3_44100_128';
  return { output: null, requestId, binary: { data: bytes, ext: extForFormat(format) } };
}

async function upload(): Promise<string> {
  throw new Error('ElevenLabs has no file storage; @file inputs are not supported on this provider.');
}

async function inspect(ref: string): Promise<InspectResult> {
  return {
    provider: 'elevenlabs',
    ref,
    description:
      'Fixed first-party API, no per-model schema. Refs: text-to-speech/{voiceId} (body: text, model_id, voice_settings{stability,similarity_boost,style,speed}, seed, previous_text, next_text, previous_request_ids, next_request_ids), text-to-speech/{voiceId}/with-timestamps (same body; writes a .timing.json word-level sidecar), music (body: prompt, music_length_ms, force_instrumental), models (GET, lists model ids), voices (GET, input {"search": "name"} to find voice ids). output_format in the input is lifted to the query string, default mp3_44100_128. Canon: https://elevenlabs.io/docs/api-reference',
  };
}

export const elevenlabsAdapter: ProviderAdapter = {
  name: 'elevenlabs',
  run,
  upload,
  inspect,
};
