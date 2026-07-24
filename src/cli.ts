#!/usr/bin/env tsx
/**
 * gen: the gateway CLI.
 *
 *   gen inspect <provider@ref> [--refresh]
 *   gen run <provider@ref> --input '<json>' [-o path] [--timeout <sec>]
 *   gen batch <jobs.json> [--concurrency 4] [--dry-run] [--retry-failed]
 *   gen status <request-id>
 *   gen cancel <request-id>
 *   gen runs [-n 20]
 *   gen models
 *   gen upload <file> [--provider fal]
 *
 * --json (or piping stdout) switches the final result to machine-readable
 * JSON. Progress always goes to stderr. Exit codes: 0 ok, 2 validation,
 * 3 content policy, 4 auth, 5 timeout, 1 anything else.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { config as loadDotenv } from 'dotenv';
import { GatewayError } from './errors.js';
import { estimateBatch, loadJobs, runBatch } from './batch.js';
import { adapters, runJob } from './gateway.js';
import { inspectEndpoint, renderInspect } from './inspect.js';
import { fail, info, jsonMode, result, setJsonFlag } from './log.js';
import { PROJECT_ROOT, loadRegistry, parseEndpointId } from './registry.js';
import { appendRun, findRun, listRuns } from './runs.js';

loadDotenv({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

const HELP = `gen: passthrough gateway for AI content models (replicate, fal, elevenlabs)

Usage:
  gen inspect <provider@ref> [--refresh]      live input/output schema
  gen run <provider@ref> --input '<json>'     run one job
      [-o <path>] [--timeout <sec>]           @file values in input upload automatically
  gen batch <jobs.json> [--concurrency 4]     parallel jobs with resume + manifest
      [--dry-run] [--retry-failed]
  gen status <request-id>                     look up a run (via runs.jsonl)
  gen cancel <request-id>                     cancel a run
  gen runs [-n 20]                            recent runs
  gen models                                  registry entries (defaults, costs, notes)
  gen upload <file> [--provider fal]          upload a file, print its URL

Endpoint ids: provider@ref, e.g. replicate@bytedance/seedance-1-pro
or fal@fal-ai/bytedance/seedance/v1/pro/image-to-video.
--json anywhere forces machine output (automatic when piped).`;

function readInputArg(raw: string | undefined): Record<string, unknown> {
  if (!raw) throw new GatewayError('Missing --input. Pass JSON or @path/to/job.json', { kind: 'validation' });
  const text = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf-8') : raw;
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError('--input must be a JSON object', { kind: 'validation' });
  }
  return parsed as Record<string, unknown>;
}

async function cmdInspect(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { refresh: { type: 'boolean' }, json: { type: 'boolean' } },
    allowPositionals: true,
  });
  setJsonFlag(values.json ?? false);
  const id = positionals[0];
  if (!id) throw new GatewayError('Usage: gen inspect <provider@ref>', { kind: 'validation' });
  const cached = await inspectEndpoint(id, values.refresh ?? false);
  result(cached, renderInspect(cached));
}

async function cmdRun(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      out: { type: 'string', short: 'o' },
      timeout: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  setJsonFlag(values.json ?? false);
  const id = positionals[0];
  if (!id) throw new GatewayError('Usage: gen run <provider@ref> --input \'<json>\'', { kind: 'validation' });
  const res = await runJob({
    endpointId: id,
    input: readInputArg(values.input),
    out: values.out,
    timeoutSec: values.timeout ? Number(values.timeout) : undefined,
  });
  result(
    res,
    [
      `done in ${res.durationSec}s${res.estCostUsd ? ` (~$${res.estCostUsd.toFixed(2)})` : ''}`,
      ...res.outPaths.map((p) => `output:  ${p}`),
      `receipt: ${res.receiptPath}`,
    ].join('\n'),
  );
}

async function cmdBatch(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      concurrency: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'retry-failed': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  setJsonFlag(values.json ?? false);
  const jobsFile = positionals[0];
  if (!jobsFile) throw new GatewayError('Usage: gen batch <jobs.json>', { kind: 'validation' });

  if (values['dry-run']) {
    const jobs = loadJobs(jobsFile);
    const est = estimateBatch(jobs);
    result(
      { jobs: jobs.length, totalKnownCostUsd: est.totalKnown, unknownCostJobs: est.unknownCount },
      [
        `${jobs.length} jobs:`,
        ...est.lines,
        `estimated total: ~$${est.totalKnown.toFixed(2)}${est.unknownCount > 0 ? ` plus ${est.unknownCount} of unknown cost` : ''}`,
        'dry run: nothing was submitted.',
      ].join('\n'),
    );
    return;
  }

  const summary = await runBatch(jobsFile, {
    concurrency: values.concurrency ? Number(values.concurrency) : 4,
    retryFailed: values['retry-failed'] ?? false,
  });
  result(
    summary,
    [
      `done: ${summary.done.length}  failed: ${summary.failed.length}  skipped: ${summary.skipped.length}`,
      summary.failed.length > 0 ? `failed ids: ${summary.failed.join(', ')} (re-run with --retry-failed)` : '',
      `est. spend this run: ~$${summary.totalEstCostUsd.toFixed(2)}`,
      `manifest: ${summary.manifestPath}`,
    ]
      .filter((l) => l !== '')
      .join('\n'),
  );
  if (summary.failed.length > 0) process.exitCode = 1;
}

async function cmdStatusOrCancel(argv: string[], action: 'status' | 'cancel'): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' } },
    allowPositionals: true,
  });
  setJsonFlag(values.json ?? false);
  const requestId = positionals[0];
  if (!requestId) throw new GatewayError(`Usage: gen ${action} <request-id>`, { kind: 'validation' });

  const run = findRun(requestId);
  if (!run) {
    throw new GatewayError(
      `Request ${requestId} not found in runs.jsonl. Only runs made through this gateway can be looked up.`,
      { kind: 'permanent' },
    );
  }
  const endpoint = parseEndpointId(run.endpoint);
  const adapter = adapters[endpoint.provider];

  if (action === 'status') {
    if (!adapter.status) {
      result(run, `${requestId}  ${run.endpoint}  last known: ${run.status} (provider has no live status API)`);
      return;
    }
    const live = await adapter.status(endpoint.ref, requestId);
    result({ run, live }, `${requestId}  ${run.endpoint}\nlast known: ${run.status}\nlive: ${JSON.stringify(live, null, 2)}`);
  } else {
    if (!adapter.cancel) {
      throw new GatewayError(`${endpoint.provider} does not support cancel`, { kind: 'permanent' });
    }
    await adapter.cancel(endpoint.ref, requestId);
    appendRun({ ts: new Date().toISOString(), requestId, endpoint: run.endpoint, status: 'canceled' });
    result({ requestId, canceled: true }, `cancel requested for ${requestId} (${run.endpoint})`);
  }
}

function cmdRuns(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { n: { type: 'string', short: 'n' }, json: { type: 'boolean' } },
    allowPositionals: true,
  });
  setJsonFlag(values.json ?? false);
  const runs = listRuns(values.n ? Number(values.n) : 20);
  result(
    runs,
    runs.length === 0
      ? 'no runs yet'
      : runs
          .map((r) => `${r.ts}  ${r.status.padEnd(9)}  ${r.requestId}  ${r.endpoint}${r.outPath ? `  ${r.outPath}` : ''}`)
          .join('\n'),
  );
}

function cmdModels(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' } },
    allowPositionals: true,
  });
  setJsonFlag(values.json ?? false);
  const registry = loadRegistry();
  const entries = Object.entries(registry);
  result(
    registry,
    entries.length === 0
      ? 'registry.json is empty; any provider@ref still works unregistered'
      : entries
          .map(([id, e]) => {
            const cost = e.estCostUsd !== undefined ? `  ~$${e.estCostUsd.toFixed(2)}` : '';
            const notes = e.notes ? `\n      ${e.notes}` : '';
            const defaults = e.defaults ? `\n      defaults: ${JSON.stringify(e.defaults)}` : '';
            return `  ${id}${cost}${defaults}${notes}`;
          })
          .join('\n'),
  );
}

async function cmdUpload(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { provider: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
  });
  setJsonFlag(values.json ?? false);
  const file = positionals[0];
  if (!file || !fs.existsSync(file)) {
    throw new GatewayError('Usage: gen upload <existing-file> [--provider fal|replicate]', { kind: 'validation' });
  }
  const provider = values.provider ?? 'fal';
  const adapter = adapters[provider as keyof typeof adapters];
  if (!adapter) throw new GatewayError(`Unknown provider '${provider}'`, { kind: 'validation' });
  info(`uploading ${file} to ${provider}...`);
  const url = await adapter.upload(file);
  result({ url, provider, file }, url);
}

const EXIT_CODES: Record<string, number> = {
  validation: 2,
  content_policy: 3,
  auth: 4,
  timeout: 5,
};

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (argv.includes('--json')) setJsonFlag(true);

  switch (command) {
    case 'inspect':
      return cmdInspect(argv);
    case 'run':
      return cmdRun(argv);
    case 'batch':
      return cmdBatch(argv);
    case 'status':
      return cmdStatusOrCancel(argv, 'status');
    case 'cancel':
      return cmdStatusOrCancel(argv, 'cancel');
    case 'runs':
      return cmdRuns(argv);
    case 'models':
      return cmdModels(argv);
    case 'upload':
      return cmdUpload(argv);
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(HELP + '\n');
      return;
    default:
      throw new GatewayError(`Unknown command '${command}'. Run gen help.`, { kind: 'validation' });
  }
}

main().catch((error: unknown) => {
  if (error instanceof GatewayError) {
    fail(`${error.kind}: ${error.message}`);
    for (const fe of error.fieldErrors ?? []) fail(`  ${fe.field}: ${fe.message}`);
    if (error.kind === 'content_policy') fail('  This input was flagged by a safety system. Rewrite the prompt; retrying will not help.');
    if (jsonMode()) {
      process.stdout.write(
        JSON.stringify({ error: { kind: error.kind, message: error.message, fieldErrors: error.fieldErrors, requestId: error.requestId } }, null, 2) + '\n',
      );
    }
    process.exit(EXIT_CODES[error.kind] ?? 1);
  }
  fail(error instanceof Error ? error.message : String(error));
  if (jsonMode()) {
    process.stdout.write(JSON.stringify({ error: { kind: 'unknown', message: String(error) } }, null, 2) + '\n');
  }
  process.exit(1);
});
