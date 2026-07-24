/**
 * Live schema inspection with a disk cache. The provider's API is the only
 * copy of a schema that is never stale; the cache (schema-cache/, gitignored)
 * just makes repeat lookups instant. --refresh bypasses it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECT_ROOT, parseEndpointId } from './registry.js';
import { adapters } from './gateway.js';
import type { InspectResult } from './providers/types.js';

export interface CachedInspect {
  fetchedAt: string;
  fromCache: boolean;
  result: InspectResult;
}

function cachePath(provider: string, ref: string): string {
  const safe = ref.replace(/[^a-zA-Z0-9.-]+/g, '__');
  return path.join(PROJECT_ROOT, 'schema-cache', provider, `${safe}.json`);
}

export async function inspectEndpoint(endpointId: string, refresh = false): Promise<CachedInspect> {
  const endpoint = parseEndpointId(endpointId);
  const file = cachePath(endpoint.provider, endpoint.ref);

  if (!refresh && fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf-8')) as CachedInspect;
    return { ...cached, fromCache: true };
  }

  const result = await adapters[endpoint.provider].inspect(endpoint.ref);
  const entry: CachedInspect = { fetchedAt: new Date().toISOString(), fromCache: false, result };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n');
  return entry;
}

type Prop = Record<string, unknown>;

/** Order fields the way the model author intended (x-order), else as-is. */
function orderedProps(schema: Record<string, unknown>): Array<[string, Prop]> {
  const props = (schema.properties ?? {}) as Record<string, Prop>;
  return Object.entries(props).sort((a, b) => {
    const oa = typeof a[1]['x-order'] === 'number' ? (a[1]['x-order'] as number) : Number.MAX_SAFE_INTEGER;
    const ob = typeof b[1]['x-order'] === 'number' ? (b[1]['x-order'] as number) : Number.MAX_SAFE_INTEGER;
    return oa - ob;
  });
}

function typeOf(prop: Prop): string {
  if (typeof prop.type === 'string') {
    if (prop.type === 'array' && prop.items && typeof prop.items === 'object') {
      const itemType = (prop.items as Prop).type;
      return `array of ${typeof itemType === 'string' ? itemType : 'object'}`;
    }
    return prop.type;
  }
  if (Array.isArray(prop.anyOf)) {
    const types = prop.anyOf
      .map((p) => (typeof (p as Prop).type === 'string' ? ((p as Prop).type as string) : ''))
      .filter((t) => t !== '' && t !== 'null');
    if (types.length > 0) return types.join(' | ');
  }
  return 'object';
}

export function renderInspect(cached: CachedInspect): string {
  const { result } = cached;
  const lines: string[] = [];
  lines.push(`${result.provider}@${result.ref}`);
  if (result.version) lines.push(`version: ${result.version}`);
  if (result.description) lines.push(result.description.trim());
  lines.push(`schema fetched ${cached.fetchedAt}${cached.fromCache ? ' (cached; --refresh to refetch)' : ''}`);

  if (result.inputSchema) {
    const required = new Set((result.inputSchema.required as string[] | undefined) ?? []);
    lines.push('', 'INPUT');
    for (const [name, prop] of orderedProps(result.inputSchema)) {
      const bits: string[] = [`  ${name}`];
      bits.push(`(${typeOf(prop)}${required.has(name) ? ', required' : ''})`);
      if (prop.default !== undefined) bits.push(`default=${JSON.stringify(prop.default)}`);
      if (typeof prop.minimum === 'number' || typeof prop.maximum === 'number') {
        bits.push(`range ${prop.minimum ?? ''}..${prop.maximum ?? ''}`);
      }
      lines.push(bits.join('  '));
      if (typeof prop.description === 'string' && prop.description !== '') {
        lines.push(`      ${prop.description.split('\n')[0]}`);
      }
      if (Array.isArray(prop.enum)) {
        lines.push(`      one of: ${prop.enum.map((e) => JSON.stringify(e)).join(', ')}`);
      }
    }
  } else {
    lines.push('', 'No machine-readable input schema for this endpoint.');
  }

  if (result.outputSchema) {
    lines.push('', 'OUTPUT');
    const out = result.outputSchema as Prop;
    if (out.type === 'array') {
      lines.push(`  array of ${typeof (out.items as Prop | undefined)?.type === 'string' ? ((out.items as Prop).type as string) : 'object'}`);
    } else if (out.properties) {
      for (const [name, prop] of orderedProps(out)) {
        lines.push(`  ${name}  (${typeOf(prop)})`);
      }
    } else {
      lines.push(`  ${typeof out.type === 'string' ? (out.type as string) : 'object'}`);
    }
  }
  return lines.join('\n');
}
