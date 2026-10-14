/**
 * A per-provider limit on jobs in flight, shared by every gen process on the machine: a slot is a file
 * <gateway>/.slots/<provider>/<i> created exclusively (flag wx) and holding the owner's pid; a job takes a free
 * slot before it submits and gives it back when its output has landed. A slot whose pid is gone (a killed
 * process) is reclaimed. Limits: replicate 16 and fal 16 (two runs at 8 each went through with no 429),
 * elevenlabs 4; GEN_SLOTS_<PROVIDER> overrides one, e.g. GEN_SLOTS_FAL=24.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { info } from './log.js';
import { PROJECT_ROOT, type Provider } from './registry.js';

const DEFAULTS: Record<Provider, number> = { replicate: 16, fal: 16, elevenlabs: 4 };
const DIR = path.join(PROJECT_ROOT, '.slots');
const held = new Set<string>();

export function slotLimit(provider: Provider): number {
  const env = Number(process.env[`GEN_SLOTS_${provider.toUpperCase()}`]);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : DEFAULTS[provider];
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

function tryTake(file: string): boolean {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(file, 'utf-8').trim() || 0);
    if (pid && pid !== process.pid && !alive(pid)) {
      try { fs.unlinkSync(file); } catch { /* another process reclaimed it first */ }
    }
    return false;
  }
}

/** Waits for a free slot of the provider and returns its release. */
export async function acquireSlot(provider: Provider, tag: string): Promise<() => void> {
  const limit = slotLimit(provider);
  const dir = path.join(DIR, provider);
  fs.mkdirSync(dir, { recursive: true });
  let said = false;
  for (;;) {
    for (let i = 0; i < limit; i++) {
      const file = path.join(dir, String(i));
      if (held.has(file)) continue;
      if (tryTake(file)) {
        held.add(file);
        return () => {
          if (!held.delete(file)) return;
          try { fs.unlinkSync(file); } catch { /* already gone */ }
        };
      }
    }
    if (!said) { info(`${tag}waiting for a ${provider} slot (${limit} in flight across processes)`); said = true; }
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
  }
}

// a process that exits gives its slots back; one killed outright leaves them to be reclaimed by pid
process.on('exit', () => { for (const f of held) { try { fs.unlinkSync(f); } catch { /* gone */ } } });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => process.exit(130));
