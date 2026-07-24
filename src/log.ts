/**
 * Output convention (borrowed from the Replicate CLI):
 *   - progress, queue positions, provider logs, warnings: always stderr
 *   - the final result: stdout. Machine-readable JSON when --json was passed
 *     OR stdout is not a terminal (piped); human lines otherwise.
 * This keeps `gen ... | jq` and agent invocations clean with zero flags.
 */

let jsonFlag = false;

export function setJsonFlag(v: boolean): void {
  jsonFlag = v;
}

export function jsonMode(): boolean {
  return jsonFlag || !process.stdout.isTTY;
}

export function info(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`! ${msg}\n`);
}

export function fail(msg: string): void {
  process.stderr.write(`✗ ${msg}\n`);
}

/** Final command result. Exactly one of these per CLI invocation. */
export function result(machine: unknown, human: string): void {
  if (jsonMode()) {
    process.stdout.write(JSON.stringify(machine, null, 2) + '\n');
  } else {
    process.stdout.write(human.endsWith('\n') ? human : human + '\n');
  }
}
