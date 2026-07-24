/**
 * File plumbing: the @file input convention, output downloads, receipts.
 *
 * The @file convention: any string VALUE in the input object that starts with
 * '@' is a local file path (e.g. "start_image": "@./frame.png"). Before
 * dispatch the gateway resolves it through the provider's uploader and
 * substitutes the resulting URL in place. Field names are never touched.
 * To pass a literal string starting with '@', escape it as '@@'.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
};

export function mimeFor(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export type Uploader = (filePath: string) => Promise<string>;

/** Recursively resolve @file string values through the uploader. */
export async function resolveFileValues(value: unknown, upload: Uploader): Promise<unknown> {
  if (typeof value === 'string') {
    if (value.startsWith('@@')) return value.slice(1);
    if (value.startsWith('@')) {
      const filePath = value.slice(1);
      if (!fs.existsSync(filePath)) {
        throw new Error(`@file input not found: ${filePath}`);
      }
      return upload(filePath);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => resolveFileValues(v, upload)));
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await resolveFileValues(v, upload);
    }
    return out;
  }
  return value;
}

export function toDataUri(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return `data:${mimeFor(filePath)};base64,${buf.toString('base64')}`;
}

/** Download a URL to disk. Node fetch follows redirects by default. */
export async function download(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url.slice(0, 120)}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

/**
 * The output heuristic shared with the Replicate SDK: a leaf string that
 * starts with https: or data: is a generated file. Collects them in order.
 */
export function collectFileUrls(output: unknown): string[] {
  const urls: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.startsWith('https:') || v.startsWith('http:') || v.startsWith('data:')) urls.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v !== null && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(output);
  return urls;
}

export function extFromUrl(url: string, fallback: string): string {
  if (url.startsWith('data:')) {
    const mime = url.slice(5, url.indexOf(';'));
    const found = Object.entries(MIME_BY_EXT).find(([, m]) => m === mime);
    return found ? found[0] : fallback;
  }
  const clean = url.split('?')[0];
  const ext = path.extname(clean).toLowerCase();
  return ext !== '' && ext.length <= 6 ? ext : fallback;
}

export interface Receipt {
  endpoint: string;
  input: Record<string, unknown>;
  requestId: string | null;
  /** Replicate: the exact model version that ran (refs without :version mean latest). */
  resolvedVersion?: string;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  attempts: number;
  estCostUsd?: number;
  outPaths: string[];
  status: 'done' | 'failed' | 'timeout';
  error?: string;
}

export function writeReceipt(outPath: string, receipt: Receipt): string {
  const receiptPath = `${outPath}.receipt.json`;
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return receiptPath;
}
