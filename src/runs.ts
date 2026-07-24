/**
 * runs.jsonl: one append-only line per run event at the project root.
 * A run appears at least twice (submitted, then done/failed/timeout); the
 * latest line per requestId wins. This index is what lets `gen status` and
 * `gen cancel` work from a bare request id: the id alone identifies neither
 * the provider nor, for fal, the endpoint its status URL needs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECT_ROOT } from './registry.js';

export interface RunRecord {
  ts: string;
  requestId: string;
  endpoint: string;
  status: 'submitted' | 'done' | 'failed' | 'timeout' | 'canceled';
  outPath?: string;
  receiptPath?: string;
  error?: string;
}

const RUNS_FILE = path.join(PROJECT_ROOT, 'runs.jsonl');

export function appendRun(record: RunRecord): void {
  fs.appendFileSync(RUNS_FILE, JSON.stringify(record) + '\n');
}

function readAll(): RunRecord[] {
  if (!fs.existsSync(RUNS_FILE)) return [];
  return fs
    .readFileSync(RUNS_FILE, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RunRecord);
}

/** Latest record for a request id, or undefined. */
export function findRun(requestId: string): RunRecord | undefined {
  const all = readAll();
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].requestId === requestId) return all[i];
  }
  return undefined;
}

/** Latest record per request id, newest first, limited to n. */
export function listRuns(n: number): RunRecord[] {
  const latest = new Map<string, RunRecord>();
  for (const rec of readAll()) latest.set(rec.requestId, rec);
  return [...latest.values()].reverse().slice(0, n);
}
