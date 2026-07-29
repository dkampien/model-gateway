---
created: 2026-07-24
updated: 2026-07-26
---

# model-gateway

One CLI (`gen`) + TypeScript library for generating images, video, voice, music, and transcriptions through Replicate, fal.ai, and ElevenLabs, with retries, receipts, resumable parallel batches, and live schema inspection built in.

## Design principles

1. **Passthrough.** Every model keeps its native schema; the input object you write is what the provider receives. No unified shape, no field mapping, no model-specific code anywhere.
2. **Endpoints, not models.** The unit is `provider@ref`; the same model on two providers is two endpoints with two schemas. Nothing needs registering before it can be called.
3. **Live schemas.** `gen inspect` fetches an endpoint's current schema from the provider (cached in `schema-cache/`). The provider's API is the only copy that is never stale.
4. **The provider validates.** The gateway never checks your input against a schema; it delivers the provider's own complaint, field by field when available.

## Setup

```bash
npm install
cp .env.example .env   # fill REPLICATE_API_TOKEN, FAL_KEY, ELEVENLABS_API_KEY
```

Each key is only required when calling that provider. Run everything through the `./gen` wrapper or `npm run gen --`.

## Operating guide

The full operating guide (commands, conventions, spend policy, and when to read which doc) lives in the **model-gateway skill** at `~/.claude/skills/model-gateway/SKILL.md`. It is written for agents and humans alike and is the single source for how to drive the CLI. Quick taste:

```bash
./gen help
./gen models
./gen run replicate@google/nano-banana-2 --input '{"prompt": "..."}'
```

`registry.json` here is the address book (per-endpoint defaults, cost estimates, quirk notes); `docs/script-estimation.md` is the method for sizing clips with spoken lines.

## Library use

Everything the CLI does is importable: `runJob` (src/gateway.ts), `runBatch` (src/batch.ts), `inspectEndpoint` (src/inspect.ts).

## Canon and reference

Provider behavior questions go to the official docs: https://replicate.com/docs (index at /docs/llms.txt), https://fal.ai/docs/api-reference (markdown index at https://docs.fal.ai/llms.txt), https://elevenlabs.io/docs/api-reference. `_reference-repos/` holds clones of the two official JS SDKs this project depends on, for reading their internals only.
