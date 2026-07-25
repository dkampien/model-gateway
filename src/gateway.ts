/**
 * runJob: the one verb. Merge registry defaults under the caller's input,
 * resolve @file values through the provider's uploader, dispatch with retry
 * and a hard timeout, land the output bytes on disk, write the receipt, and
 * index the run in runs.jsonl.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GatewayError, classifyError, formatError } from './errors.js';
import {
  collectFileUrls,
  download,
  extFromUrl,
  resolveFileValues,
  writeReceipt,
  type Receipt,
} from './files.js';
import { info, warn } from './log.js';
import { PROJECT_ROOT, getEntry, mergeDefaults, parseEndpointId, type Provider } from './registry.js';
import { withRetry } from './retry.js';
import { appendRun } from './runs.js';
import { elevenlabsAdapter } from './providers/elevenlabs.js';
import { falAdapter } from './providers/fal.js';
import { replicateAdapter } from './providers/replicate.js';
import type { JobResult, ProviderAdapter } from './providers/types.js';

export const adapters: Record<Provider, ProviderAdapter> = {
  replicate: replicateAdapter,
  fal: falAdapter,
  elevenlabs: elevenlabsAdapter,
};

const DEFAULT_TIMEOUT_SEC = 15 * 60;

/**
 * Same file + same provider = one upload per process, even when parallel
 * batch jobs resolve it simultaneously (the cache stores the promise, so
 * concurrent callers share the in-flight upload).
 */
const uploadCache = new Map<string, Promise<string>>();

function cachedUpload(adapter: ProviderAdapter, filePath: string, tag: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 20);
  const key = `${adapter.name}:${hash}`;
  const inFlight = uploadCache.get(key);
  if (inFlight) return inFlight;
  info(`${tag}uploading @file ${filePath} to ${adapter.name}...`);
  const upload = adapter.upload(filePath);
  uploadCache.set(key, upload);
  upload.catch(() => uploadCache.delete(key));
  return upload;
}

export interface RunJobOptions {
  endpointId: string;
  input: Record<string, unknown>;
  out?: string;
  timeoutSec?: number;
  /** Prefix for progress lines, used by batch items. */
  label?: string;
}

export interface RunJobSuccess {
  status: 'done';
  outPaths: string[];
  receiptPath: string;
  requestId: string | null;
  estCostUsd?: number;
  durationSec: number;
  output: unknown;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function defaultOutBase(ref: string): string {
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return path.join(PROJECT_ROOT, 'out', `${ts}-${slug(ref)}`);
}

/** Strip a known media extension so ext choice stays with the result. */
function splitOutArg(out: string): { base: string; forcedExt: string | null } {
  const ext = path.extname(out);
  return ext !== '' && ext.length <= 6
    ? { base: out.slice(0, -ext.length), forcedExt: ext }
    : { base: out, forcedExt: null };
}

export async function runJob(opts: RunJobOptions): Promise<RunJobSuccess> {
  const endpoint = parseEndpointId(opts.endpointId);
  const adapter = adapters[endpoint.provider];
  const entry = getEntry(endpoint.id);
  const tag = opts.label ? `[${opts.label}] ` : '';

  const merged = mergeDefaults(endpoint.id, opts.input);
  const resolvedInput = (await resolveFileValues(merged, (p) =>
    cachedUpload(adapter, p, tag),
  )) as Record<string, unknown>;

  const timeoutSec = opts.timeoutSec ?? entry?.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutSec * 1000);

  const startedAt = new Date();
  let requestId: string | null = null;
  let attempts = 0;
  let lastPhase = '';

  const { base, forcedExt } = splitOutArg(opts.out ?? defaultOutBase(endpoint.ref));

  const finish = (
    status: Receipt['status'],
    result: JobResult | null,
    outPaths: string[],
    error?: string,
  ): string => {
    const finishedAt = new Date();
    const receiptPath = writeReceipt(base, {
      endpoint: endpoint.id,
      input: resolvedInput,
      requestId,
      resolvedVersion: result?.resolvedVersion,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 100) / 10,
      attempts,
      estCostUsd: entry?.estCostUsd,
      outPaths,
      status,
      error,
    });
    if (requestId) {
      appendRun({
        ts: finishedAt.toISOString(),
        requestId,
        endpoint: endpoint.id,
        status: status === 'done' ? 'done' : status,
        outPath: outPaths[0],
        receiptPath,
        error,
      });
    }
    return receiptPath;
  };

  let result: JobResult;
  try {
    result = await withRetry(
      async () => {
        attempts++;
        return adapter.run({
          ref: endpoint.ref,
          input: resolvedInput,
          signal: controller.signal,
          onUpdate: (u) => {
            if (u.requestId && requestId === null) {
              requestId = u.requestId;
              appendRun({
                ts: new Date().toISOString(),
                requestId: u.requestId,
                endpoint: endpoint.id,
                status: 'submitted',
              });
              info(`${tag}submitted: ${u.requestId}`);
            }
            if (u.phase && u.phase !== lastPhase) {
              lastPhase = u.phase;
              const pos = u.queuePosition !== undefined ? ` (queue position ${u.queuePosition})` : '';
              info(`${tag}${u.phase}${pos}`);
            }
            if (u.logLine) info(`${tag}| ${u.logLine}`);
          },
        });
      },
      {
        provider: endpoint.provider,
        onRetry: ({ attempt, maxAttempts, delayMs, kind, message }) =>
          warn(`${tag}${kind} error, retry ${attempt}/${maxAttempts - 1} in ${Math.round(delayMs / 1000)}s: ${message}`),
      },
    );
  } catch (error) {
    clearTimeout(timer);
    if (timedOut) {
      if (requestId && adapter.cancel) {
        await adapter.cancel(endpoint.ref, requestId).catch(() => undefined);
      }
      finish('timeout', null, [], `timed out after ${timeoutSec}s`);
      throw new GatewayError(
        `${endpoint.id} timed out after ${timeoutSec}s (request ${requestId ?? 'not yet submitted'}, cancel attempted). Raise with --timeout if the model is just slow.`,
        { kind: 'timeout', provider: endpoint.provider, requestId: requestId ?? undefined, cause: error },
      );
    }
    const kind = classifyError(error, endpoint.provider);
    finish('failed', null, [], formatError(error));
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(`${endpoint.id} failed (${kind}): ${formatError(error)}`, {
      kind,
      provider: endpoint.provider,
      requestId: requestId ?? undefined,
      cause: error,
    });
  }
  clearTimeout(timer);

  // Land the result on disk: direct bytes, else URLs, else the raw JSON.
  const outPaths: string[] = [];
  if (result.binary) {
    const outPath = `${base}${forcedExt ?? result.binary.ext}`;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.binary.data);
    outPaths.push(outPath);
  } else {
    const urls = result.dataOnly ? [] : collectFileUrls(result.output);
    if (urls.length === 1) {
      const outPath = `${base}${forcedExt ?? extFromUrl(urls[0], '.bin')}`;
      await download(urls[0], outPath);
      outPaths.push(outPath);
    } else if (urls.length > 1) {
      for (let i = 0; i < urls.length; i++) {
        const outPath = `${base}-${i + 1}${forcedExt ?? extFromUrl(urls[i], '.bin')}`;
        await download(urls[i], outPath);
        outPaths.push(outPath);
      }
    } else {
      const outPath = `${base}${forcedExt ?? '.json'}`;
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result.output, null, 2) + '\n');
      outPaths.push(outPath);
    }
  }
  for (const sidecar of result.sidecars ?? []) {
    fs.writeFileSync(`${base}${sidecar.suffix}`, JSON.stringify(sidecar.data, null, 2) + '\n');
  }

  const receiptPath = finish('done', result, outPaths);
  const durationSec = Math.round((Date.now() - startedAt.getTime()) / 100) / 10;
  return {
    status: 'done',
    outPaths,
    receiptPath,
    requestId,
    estCostUsd: entry?.estCostUsd,
    durationSec,
    output: result.output,
  };
}
