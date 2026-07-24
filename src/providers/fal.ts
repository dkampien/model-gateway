/**
 * fal.ai adapter. Transport facts this code relies on:
 *   - subscribe = queue.submit + status polling (500ms) + a separate result
 *     fetch; onEnqueue delivers the request id immediately; onQueueUpdate
 *     delivers queue position and (with logs: true) provider logs.
 *   - The client enforces NO timeout by default; the gateway's watchdog is
 *     the only ceiling. Cancellation goes through queue.cancel(ref, id).
 *   - 422s arrive as ValidationError with field-level detail. They are
 *     surfaced verbatim; the retry layer gives fal 422s limited attempts
 *     first because burst-load 422s clear on retry (production history).
 *   - storage.upload handles multipart automatically above 90MB.
 *   - The per-endpoint OpenAPI schema is public, no key required.
 */
import { createFalClient, ValidationError, type FalClient } from '@fal-ai/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GatewayError } from '../errors.js';
import { mimeFor } from '../files.js';
import type { InspectResult, JobResult, ProviderAdapter, RunArgs } from './types.js';
import { requireEnv } from './types.js';

let client: FalClient | null = null;

function getClient(): FalClient {
  if (!client) {
    client = createFalClient({ credentials: requireEnv('FAL_KEY', 'fal') });
  }
  return client;
}

interface QueueUpdateLike {
  status?: string;
  queue_position?: number;
  logs?: Array<{ message?: string }> | null;
}

async function run({ ref, input, signal, onUpdate }: RunArgs): Promise<JobResult> {
  const fal = getClient();
  let requestId: string | null = null;
  let logCount = 0;

  try {
    const result = await fal.subscribe(ref, {
      input,
      logs: true,
      abortSignal: signal,
      onEnqueue: (id: string) => {
        requestId = id;
        onUpdate({ requestId: id, phase: 'IN_QUEUE' });
      },
      onQueueUpdate: (update: QueueUpdateLike) => {
        onUpdate({ phase: update.status, queuePosition: update.queue_position });
        const logs = update.logs ?? [];
        for (; logCount < logs.length; logCount++) {
          const msg = logs[logCount]?.message;
          if (msg) onUpdate({ logLine: msg });
        }
      },
    });
    return { output: result.data, requestId: result.requestId ?? requestId };
  } catch (error) {
    if (error instanceof ValidationError) {
      const detail = (error as ValidationError & {
        fieldErrors?: Array<{ loc?: Array<string | number>; msg?: string }>;
      }).fieldErrors;
      throw new GatewayError(`fal rejected the input for ${ref}: ${error.message}`, {
        kind: 'validation',
        provider: 'fal',
        status: 422,
        requestId: requestId ?? undefined,
        fieldErrors: detail?.map((fe) => ({
          field: (fe.loc ?? []).filter((p) => p !== 'body').join('.') || 'body',
          message: fe.msg ?? 'invalid',
        })),
        cause: error,
      });
    }
    throw error;
  }
}

async function upload(filePath: string): Promise<string> {
  const fal = getClient();
  const buf = fs.readFileSync(filePath);
  const blob = new File([new Uint8Array(buf)], path.basename(filePath), {
    type: mimeFor(filePath),
  });
  return fal.storage.upload(blob);
}

async function inspect(ref: string): Promise<InspectResult> {
  const url = `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(ref)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fal schema fetch failed: HTTP ${res.status} for endpoint '${ref}'`);
  }
  const doc = (await res.json()) as {
    info?: { ['x-fal-metadata']?: { about?: string } };
    components?: { schemas?: Record<string, Record<string, unknown>> };
  };
  const schemas = doc.components?.schemas ?? {};
  // fal names the request/response schemas per endpoint (e.g.
  // BytedanceSeedanceV1ProImageToVideoInput); Input/Output suffix is the
  // stable convention. QueueStatus is transport machinery, not model schema.
  const inputKey = Object.keys(schemas).find((k) => k.endsWith('Input'));
  const outputKey = Object.keys(schemas).find((k) => k.endsWith('Output'));
  return {
    provider: 'fal',
    ref,
    inputSchema: inputKey ? schemas[inputKey] : undefined,
    outputSchema: outputKey ? schemas[outputKey] : undefined,
    description: doc.info?.['x-fal-metadata']?.about,
  };
}

async function status(ref: string, requestId: string): Promise<unknown> {
  return getClient().queue.status(ref, { requestId, logs: true });
}

async function cancel(ref: string, requestId: string): Promise<void> {
  await getClient().queue.cancel(ref, { requestId });
}

export const falAdapter: ProviderAdapter = {
  name: 'fal',
  run,
  upload,
  inspect,
  status,
  cancel,
};
