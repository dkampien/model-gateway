---
created: 2026-07-24
updated: 2026-07-24
---

# model-gateway

One CLI + TypeScript library for generating images, video, voice, music, and transcriptions through Replicate, fal.ai, and ElevenLabs. You (or an agent) do the prompting; the gateway does the calling: retries, timeouts, file handling, receipts, parallel batches. It knows nothing about ads or any other domain.

## Design principles

1. **Passthrough.** Every model keeps its native schema. The input object you write is what the provider receives. There is no unified shape, no field mapping, and no model-specific code anywhere.
2. **Endpoints, not models.** The unit is `provider@ref`: the same model on two providers is two endpoints with two schemas (really: Seedance takes `image` on Replicate and `image_url` on fal). Nothing needs registering before it can be called.
3. **Live schemas.** `gen inspect` fetches the endpoint's current schema from the provider (cached in `schema-cache/`). The provider's API is the only copy that is never stale.
4. **The provider validates.** The gateway never checks your input against the schema; it delivers the provider's own complaint, field by field when available.

## Setup

```bash
npm install
cp .env.example .env   # fill REPLICATE_API_TOKEN, FAL_KEY, ELEVENLABS_API_KEY
```

Each key is only required when calling that provider. Run everything through the `./gen` wrapper or `npm run gen --`.

## Commands

```bash
gen inspect replicate@bytedance/seedance-1-pro          # live schema, cached; --refresh refetches
gen run replicate@google/nano-banana-2 \
  --input '{"prompt": "a lighthouse at dawn"}' \
  -o out/lighthouse.png                                  # -o optional; default lands in out/
gen batch jobs.json --dry-run                            # print jobs + cost estimate, zero spend
gen batch jobs.json --concurrency 4                      # run; re-run resumes; --retry-failed
gen status <request-id>                                  # live provider status
gen cancel <request-id>
gen runs -n 20                                           # recent history
gen models                                               # registry entries
gen upload ./frame.png --provider fal                    # file -> URL
```

`--json` (automatic when stdout is piped) makes the final result machine-readable JSON. Progress and provider logs always go to stderr. Exit codes: 0 ok, 2 validation, 3 content policy, 4 auth, 5 timeout, 1 other.

## Conventions

**`@file` values.** Any string value in an input that starts with `@` is a local file path; it is uploaded to the provider and the URL is substituted in place. The field name stays native: `{"start_image": "@./frame.png"}`. Escape a literal leading `@` as `@@`.

**Receipts.** Every run writes `<output>.receipt.json`: endpoint, the exact resolved input, provider request id, the Replicate model version that actually ran, timing, attempts, estimated cost. `runs.jsonl` at the project root indexes every run; it is what makes `gen status`/`gen cancel` work from a bare request id.

**Timeouts.** 15 minutes per job by default; override per registry entry (`timeoutSec`) or per call (`--timeout`). On expiry the job is aborted and a cancel is attempted.

**Retries.** Transient provider errors (capacity, 5xx, rate limits) retry with backoff and jitter. Validation and content-policy failures never retry; a content flag means rewrite the prompt.

**Batch jobs file.**
```json
[
  { "id": "hook-a", "endpoint": "replicate@google/nano-banana-2",
    "input": { "prompt": "..." }, "out": "out/hook-a" }
]
```
`id` and `out` are optional. A manifest (`<jobs>.manifest.json`) tracks per-item outcomes; re-running skips completed items whose files still exist.

## Registry

`registry.json` is an address book: per-endpoint defaults (native field names, your input wins), a rough cost for dry-run totals, a timeout override, and free-text notes. It is optional convenience; unregistered endpoints work identically.

## Library use

Everything the CLI does is importable: `runJob` (src/gateway.ts), `runBatch` (src/batch.ts), `inspectEndpoint` (src/inspect.ts).

## Canon and reference

Provider behavior questions go to the official docs: https://replicate.com/docs (index at /docs/llms.txt) and https://fal.ai/docs/api-reference (markdown index at https://docs.fal.ai/llms.txt), https://elevenlabs.io/docs/api-reference. `_reference-repos/` holds clones of the two official JS SDKs this project depends on, for reading their internals only.
