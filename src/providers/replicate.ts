/**
 * Replicate adapter. Transport facts this code relies on:
 *   - replicate.run() uses blocking mode by default (Prefer: wait header holds
 *     the create request server-side), degrading to 500ms polling. The
 *     progress callback receives the prediction on create and every poll tick,
 *     which is where the request id and exact model version are captured.
 *   - useFileOutput: false makes outputs plain URL strings instead of
 *     FileOutput streams; the gateway downloads from URLs itself.
 *   - The SDK retries internally (GETs on 429/5xx, POSTs on 429 only); the
 *     gateway's retry layer sits above and stays coarse.
 *   - The model version object carries the full OpenAPI schema; refs may pin
 *     a version as owner/model:versionId, otherwise latest is used.
 */
import Replicate from 'replicate';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toDataUri, mimeFor } from '../files.js';
import type { InspectResult, JobResult, ProviderAdapter, RunArgs } from './types.js';
import { requireEnv } from './types.js';

const MAX_DATA_URI_BYTES = 10_000_000; // the SDK's own cap for data URIs

let client: Replicate | null = null;

function getClient(): Replicate {
  if (!client) {
    client = new Replicate({
      auth: requireEnv('REPLICATE_API_TOKEN', 'replicate'),
      useFileOutput: false,
    });
  }
  return client;
}

interface PredictionLike {
  id?: string;
  version?: string;
  status?: string;
  logs?: string;
}

async function run({ ref, input, signal, onUpdate }: RunArgs): Promise<JobResult> {
  const replicate = getClient();
  let requestId: string | null = null;
  let resolvedVersion: string | undefined;
  let lastLogs = '';

  const output = await replicate.run(
    ref as `${string}/${string}`,
    { input, signal },
    (prediction: PredictionLike) => {
      if (prediction.id && requestId === null) {
        requestId = prediction.id;
        onUpdate({ requestId: prediction.id, phase: prediction.status });
      } else if (prediction.status) {
        onUpdate({ phase: prediction.status });
      }
      if (prediction.version) resolvedVersion = prediction.version;
      if (prediction.logs && prediction.logs !== lastLogs) {
        const fresh = prediction.logs.slice(lastLogs.length).trim();
        lastLogs = prediction.logs;
        if (fresh !== '') onUpdate({ logLine: fresh.split('\n').slice(-1)[0] });
      }
    },
  );

  return { output, requestId, resolvedVersion };
}

async function upload(filePath: string): Promise<string> {
  const replicate = getClient();
  const buf = fs.readFileSync(filePath);
  try {
    const blob = new Blob([new Uint8Array(buf)], { type: mimeFor(filePath) });
    (blob as Blob & { name?: string }).name = path.basename(filePath);
    const file = (await replicate.files.create(blob)) as { urls?: { get?: string } };
    if (file.urls?.get) return file.urls.get;
    throw new Error('files API returned no URL');
  } catch (error) {
    if (buf.length <= MAX_DATA_URI_BYTES) return toDataUri(filePath);
    throw new Error(
      `Replicate file upload failed and ${filePath} is too large (${buf.length} bytes) for a data URI fallback: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface VersionLike {
  id: string;
  openapi_schema?: {
    components?: { schemas?: Record<string, Record<string, unknown>> };
  };
}

/**
 * Replicate schemas point enum fields at sibling components via $ref
 * (often wrapped in allOf). Inline them so the Input schema is
 * self-contained and enums actually render.
 */
function resolveRefs(node: unknown, components: Record<string, Record<string, unknown>>): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, components));
  if (node === null || typeof node !== 'object') return node;

  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === 'string') {
    const name = obj.$ref.split('/').pop() ?? '';
    const target = components[name];
    return target ? resolveRefs(target, components) : obj;
  }
  if (Array.isArray(obj.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const part of obj.allOf) {
      Object.assign(merged, resolveRefs(part, components) as Record<string, unknown>);
    }
    const { allOf: _dropped, ...rest } = obj;
    return { ...merged, ...(resolveRefs(rest, components) as Record<string, unknown>) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolveRefs(v, components);
  return out;
}

async function inspect(ref: string): Promise<InspectResult> {
  const replicate = getClient();
  const [ownerName, pinnedVersion] = ref.split(':');
  const [owner, name] = ownerName.split('/');
  if (!owner || !name) {
    throw new Error(`Replicate ref must be owner/model or owner/model:version, got '${ref}'`);
  }

  let version: VersionLike;
  let description: string | undefined;
  if (pinnedVersion) {
    version = (await replicate.models.versions.get(owner, name, pinnedVersion)) as VersionLike;
  } else {
    const model = (await replicate.models.get(owner, name)) as {
      description?: string;
      latest_version?: VersionLike;
    };
    description = model.description;
    if (!model.latest_version) throw new Error(`Model ${ref} has no versions`);
    version = model.latest_version;
  }

  const schemas = version.openapi_schema?.components?.schemas ?? {};
  return {
    provider: 'replicate',
    ref,
    inputSchema: schemas.Input
      ? (resolveRefs(schemas.Input, schemas) as Record<string, unknown>)
      : undefined,
    outputSchema: schemas.Output
      ? (resolveRefs(schemas.Output, schemas) as Record<string, unknown>)
      : undefined,
    version: version.id,
    description,
  };
}

async function status(_ref: string, requestId: string): Promise<unknown> {
  return getClient().predictions.get(requestId);
}

async function cancel(_ref: string, requestId: string): Promise<void> {
  await getClient().predictions.cancel(requestId);
}

export const replicateAdapter: ProviderAdapter = {
  name: 'replicate',
  run,
  upload,
  inspect,
  status,
  cancel,
};
