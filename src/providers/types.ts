/**
 * The provider adapter contract: transport only. An adapter knows how to
 * authenticate, submit, wait, extract output, cancel, upload, and fetch
 * schemas for ITS provider. It never contains model-specific logic and never
 * modifies the input object beyond what the gateway already resolved.
 *
 * run() is a single verb (not submit-then-wait) because Replicate's blocking
 * mode has no clean seam between the two. onUpdate emits the request id as
 * soon as it is known so the gateway can index the run and support cancel.
 */

export interface JobUpdate {
  requestId?: string;
  queuePosition?: number;
  logLine?: string;
  phase?: string;
}

export interface JobResult {
  /** The provider's raw output payload, untouched. */
  output: unknown;
  requestId: string | null;
  /** Replicate: exact model version id that ran. */
  resolvedVersion?: string;
  /** Providers that return bytes directly (ElevenLabs) instead of URLs. */
  binary?: { data: Buffer; ext: string };
  /** Extra files written next to the output, keyed by filename suffix. */
  sidecars?: Array<{ suffix: string; data: unknown }>;
  /**
   * The output is metadata (a listing, a transcription), not generated
   * files: write it as JSON and never download URLs found inside it.
   */
  dataOnly?: boolean;
}

export interface RunArgs {
  ref: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  onUpdate: (u: JobUpdate) => void;
}

export interface ProviderAdapter {
  name: string;
  run(args: RunArgs): Promise<JobResult>;
  /** Upload a local file, return a URL usable in inputs. */
  upload(filePath: string): Promise<string>;
  /** Fetch the endpoint's live schema (shape is provider-specific). */
  inspect(ref: string): Promise<InspectResult>;
  status?(ref: string, requestId: string): Promise<unknown>;
  cancel?(ref: string, requestId: string): Promise<void>;
}

export interface InspectResult {
  provider: string;
  ref: string;
  /** JSON Schema of the input object, when the provider exposes one. */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Replicate: version id the schema belongs to. */
  version?: string;
  description?: string;
  /** Free-form extra material (e.g. ElevenLabs static docs pointer). */
  extra?: Record<string, unknown>;
}

export function requireEnv(name: string, provider: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name} in .env: required for ${provider} calls. Other providers still work without it.`,
    );
  }
  return value;
}
