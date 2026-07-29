---
name: model-gateway
description: Generate AI media through the local `gen` CLI (the model gateway) instead of writing one-off API scripts. Use this skill whenever the user wants to create images, video clips, talking characters, voiceovers or TTS, music, sound effects, voice conversion, or audio transcription, or mentions Replicate, fal.ai, ElevenLabs, or model names like nano-banana, grok, kling, seedance, flux, gpt-image, Scribe. Also triggers on phrases like "make a picture of", "animate this image", "generate a clip", "clone a voice", "what models do we have". Not for the full BibleChat ad pipeline (ad-draft/ad-produce/ad-iterate own that) and not for LLM text generation.
---

# model-gateway

One CLI reaches Replicate, fal.ai, and ElevenLabs with retries, receipts, and parallel batches built in. It lives at:

```
/Users/dennisk/Documents/project - model-gateway/
```

Run it as `./gen <command>` from that directory. Never write a fresh API script for a generation task; the gateway is the way.

## The operating loop

```
./gen models                        # Dennis's curated endpoints, costs, quirk notes
./gen inspect <provider@ref>        # live schema of any endpoint; the ONLY truth for fields
./gen run <provider@ref> --input '{...}' [-o path] [--timeout <sec>]
./gen batch jobs.json --dry-run     # review effective inputs + cost BEFORE spending
./gen batch jobs.json               # parallel (4 at a time), resumable
./gen runs | status <id> | cancel <id> | upload <file>
```

Endpoints are `provider@ref` (e.g. `replicate@google/nano-banana-2`). Inputs are each model's NATIVE schema, passed through verbatim; never assume field names from memory, inspect first. Piped output is JSON. Exit codes: 2 fix the named fields, 3 content-flagged (rewrite, do not retry), 4 missing API key, 5 timed out.

## Conventions

- **`@file` values**: any input string starting with `@` is a local file path; it uploads to the provider automatically and the URL lands in that same field (`"start_image": "@./frame.png"`). A literal leading `@` escapes as `@@`.
- **Receipts**: every run writes `<output>.receipt.json` (exact input, request id, cost) beside the output, and appends to `runs.jsonl` at the gateway root; that index is what `status`/`cancel` look up.
- **Batch jobs file**: a JSON array; re-running skips completed items, `--retry-failed` reruns failures only.

```json
[{ "id": "name", "endpoint": "provider@ref", "input": { ... }, "out": "optional/path" }]
```

## Spend policy

Images cost cents; video costs dollars (grok is ~$0.08/second). Always dry-run batches. Confirm with Dennis before any single run or batch expected to exceed ~$1, and state the estimate when asking.

## Two moves worth knowing by name

- **Casting**: to compare models, put the same prompt on several endpoints in one jobs file (each job in that model's native fields) and batch it; results land side by side for judging.
- **Adding a model**: any `provider@ref` works without registration. If it earns a place, add an entry to the gateway's `registry.json` (defaults in native field names, estCostUsd, quirk notes) so future sessions inherit it.

## Deeper knowledge (read on demand)

- **Scripted or talking video** (choosing clip durations, pacing, trimming): read `docs/script-estimation.md` in the gateway repo BEFORE sizing any clip with spoken lines.
- **Model quirks** (reference-image field names, URL requirements): `./gen models` notes and `registry.json`.
- Provider API behavior: their docs are canon (`replicate.com/docs/llms.txt`, `docs.fal.ai/llms.txt`, `elevenlabs.io/docs/llms.txt`).
