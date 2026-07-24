/**
 * Parallel batches with a concurrency cap, jittered starts, per-item
 * isolation, resume, and a manifest.
 *
 * Jobs file: [{ "id": "optional", "endpoint": "provider@ref",
 *               "input": {...}, "out": "optional/path" }]
 *
 * Resume semantics: an item whose manifest entry is done AND whose first
 * output file still exists is skipped on re-run. --retry-failed narrows the
 * run to items whose last status was failed or timeout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatError } from './errors.js';
import { info, warn } from './log.js';
import { getEntry, parseEndpointId } from './registry.js';
import { runJob } from './gateway.js';

export interface BatchJob {
  id: string;
  endpoint: string;
  input: Record<string, unknown>;
  out?: string;
  timeoutSec?: number;
}

export interface ManifestItem {
  status: 'done' | 'failed' | 'timeout' | 'skipped';
  outPaths?: string[];
  receiptPath?: string;
  requestId?: string | null;
  estCostUsd?: number;
  error?: string;
  finishedAt: string;
}

export interface Manifest {
  jobsFile: string;
  updatedAt: string;
  items: Record<string, ManifestItem>;
}

export function loadJobs(jobsFile: string): BatchJob[] {
  const raw = JSON.parse(fs.readFileSync(jobsFile, 'utf-8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${jobsFile}: expected a JSON array of jobs`);
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const job = item as Partial<BatchJob>;
    if (typeof job.endpoint !== 'string') throw new Error(`${jobsFile}: job ${i + 1} is missing "endpoint"`);
    parseEndpointId(job.endpoint);
    if (job.input === null || typeof job.input !== 'object') {
      throw new Error(`${jobsFile}: job ${i + 1} is missing "input" object`);
    }
    const id = job.id ?? String(i + 1);
    if (seen.has(id)) throw new Error(`${jobsFile}: duplicate job id '${id}'`);
    seen.add(id);
    const defaultOut = path.join(path.dirname(jobsFile), 'out', id);
    return {
      id,
      endpoint: job.endpoint,
      input: job.input as Record<string, unknown>,
      out: job.out ?? defaultOut,
      timeoutSec: job.timeoutSec,
    };
  });
}

function manifestPath(jobsFile: string): string {
  return `${jobsFile}.manifest.json`;
}

export function loadManifest(jobsFile: string): Manifest {
  const file = manifestPath(jobsFile);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')) as Manifest;
  return { jobsFile, updatedAt: new Date().toISOString(), items: {} };
}

function saveManifest(jobsFile: string, manifest: Manifest): void {
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath(jobsFile), JSON.stringify(manifest, null, 2) + '\n');
}

export function estimateBatch(jobs: BatchJob[]): { lines: string[]; totalKnown: number; unknownCount: number } {
  const lines: string[] = [];
  let totalKnown = 0;
  let unknownCount = 0;
  for (const job of jobs) {
    const cost = getEntry(job.endpoint)?.estCostUsd;
    if (cost === undefined) unknownCount++;
    else totalKnown += cost;
    lines.push(`  ${job.id}  ${job.endpoint}  ${cost !== undefined ? `~$${cost.toFixed(2)}` : 'cost unknown'}`);
  }
  return { lines, totalKnown, unknownCount };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BatchSummary {
  done: string[];
  failed: string[];
  skipped: string[];
  totalEstCostUsd: number;
  manifestPath: string;
}

export async function runBatch(
  jobsFile: string,
  opts: { concurrency: number; retryFailed: boolean },
): Promise<BatchSummary> {
  const allJobs = loadJobs(jobsFile);
  const manifest = loadManifest(jobsFile);
  const summary: BatchSummary = {
    done: [],
    failed: [],
    skipped: [],
    totalEstCostUsd: 0,
    manifestPath: manifestPath(jobsFile),
  };

  const queue: BatchJob[] = [];
  for (const job of allJobs) {
    const prior = manifest.items[job.id];
    if (opts.retryFailed) {
      if (prior && (prior.status === 'failed' || prior.status === 'timeout')) queue.push(job);
      else summary.skipped.push(job.id);
      continue;
    }
    if (prior?.status === 'done' && prior.outPaths?.[0] && fs.existsSync(prior.outPaths[0])) {
      summary.skipped.push(job.id);
      continue;
    }
    queue.push(job);
  }

  info(`batch: ${queue.length} to run, ${summary.skipped.length} skipped (concurrency ${opts.concurrency})`);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const job = queue[cursor++];
      await sleep(Math.random() * 1500); // jittered start against burst storms
      try {
        const result = await runJob({
          endpointId: job.endpoint,
          input: job.input,
          out: job.out,
          timeoutSec: job.timeoutSec,
          label: job.id,
        });
        manifest.items[job.id] = {
          status: 'done',
          outPaths: result.outPaths,
          receiptPath: result.receiptPath,
          requestId: result.requestId,
          estCostUsd: result.estCostUsd,
          finishedAt: new Date().toISOString(),
        };
        summary.done.push(job.id);
        if (result.estCostUsd) summary.totalEstCostUsd += result.estCostUsd;
        info(`[${job.id}] done -> ${result.outPaths.join(', ')}`);
      } catch (error) {
        const isTimeout = error instanceof Error && error.message.includes('timed out');
        manifest.items[job.id] = {
          status: isTimeout ? 'timeout' : 'failed',
          error: formatError(error),
          finishedAt: new Date().toISOString(),
        };
        summary.failed.push(job.id);
        warn(`[${job.id}] ${isTimeout ? 'timeout' : 'failed'}: ${formatError(error)}`);
      }
      saveManifest(jobsFile, manifest);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return summary;
}
