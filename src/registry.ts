/**
 * Endpoint ids are `provider@ref` where ref is the provider's own untouched
 * model string, e.g. replicate@bytedance/seedance-1-pro or
 * fal@fal-ai/bytedance/seedance/v1/pro/image-to-video.
 *
 * registry.json is an address book, never a schema store: optional per-endpoint
 * defaults (in the model's native field names, shallow-merged, caller wins),
 * a rough cost figure for dry-run estimates, a timeout override, free-text
 * notes, and an optional fallback endpoint for when retries run out. Any endpoint works without an entry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type Provider = 'replicate' | 'fal' | 'elevenlabs';

export interface EndpointId {
  provider: Provider;
  ref: string;
  /** The full original id string. */
  id: string;
}

export interface RegistryEntry {
  defaults?: Record<string, unknown>;
  estCostUsd?: number;
  timeoutSec?: number;
  notes?: string;
  /** Another endpoint id taking the same input, tried once when this one's retries on a rate limit or provider fault run out. */
  fallback?: string;
}

export function parseEndpointId(id: string): EndpointId {
  const at = id.indexOf('@');
  if (at <= 0 || at === id.length - 1) {
    throw new Error(
      `Invalid endpoint id '${id}'. Expected provider@ref, e.g. replicate@bytedance/seedance-1-pro`,
    );
  }
  const provider = id.slice(0, at);
  const ref = id.slice(at + 1);
  if (provider !== 'replicate' && provider !== 'fal' && provider !== 'elevenlabs') {
    throw new Error(
      `Unknown provider '${provider}' in '${id}'. Supported: replicate, fal, elevenlabs`,
    );
  }
  return { provider, ref, id };
}

let registryCache: Record<string, RegistryEntry> | null = null;

export function loadRegistry(): Record<string, RegistryEntry> {
  if (registryCache) return registryCache;
  const file = path.join(PROJECT_ROOT, 'registry.json');
  if (!fs.existsSync(file)) {
    registryCache = {};
    return registryCache;
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  const entries: Record<string, RegistryEntry> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('_')) continue; // top-level notes like _note
    entries[key] = value as RegistryEntry;
  }
  registryCache = entries;
  return entries;
}

export function getEntry(id: string): RegistryEntry | undefined {
  return loadRegistry()[id];
}

/** Shallow merge: registry defaults underneath, caller input on top. */
export function mergeDefaults(
  id: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const entry = getEntry(id);
  if (!entry?.defaults) return input;
  return { ...entry.defaults, ...input };
}
