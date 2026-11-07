# NebulaLab Lane C migration

NebulaLab's C runs on OpenAI first. Since 2026-11-03 the other six repositories also use
provider bundles, for a last resort only (see the end of this page).

| Lane | First pass | Regular review | Cross-provider route |
| --- | --- | --- | --- |
| A | Muse Spark 1.3 Contributor on Go | Same | CC through C / command-code |
| B | Sonnet 5.5 on Anthropic | Haiku 5.5 on Anthropic | Haiku on Go (A), then Command Code (C) |
| C | GPT-6.1 Sol on OpenAI, high reasoning | GPT-6.1 Terra on OpenAI, high reasoning | GPT-6 Luna high on Go (A), then Command Code (C) |

First-pass models never cross providers. Failure enters the regular model chain in
the same round. Only a valid first pass records completion; otherwise the next push
tries again. Success ends the lane's round, and its report stays folded in later comments.
Existing PRs without a C first-pass marker receive Sol at their next review. A Sol
marker or a historical Terra first-pass marker from the October rollout still
records completion. Its report remains folded on later reviews.

Since 2026-11-07, NebulaLab uses Sol high for the first pass and Terra high for
subsequent reviews. When Sol cannot produce a usable first pass, the same round tries
Terra on OpenAI before it can cross to Luna. NebulaLab B and C try Go first and
only reach Command Code if Go cannot produce a usable review. The other repositories'
quota-only OpenAI last resort still uses Sol high followed by Luna xhigh. Their
planned OpenAI allowance is shared with NebulaLab. Historical
Terra/medium acceptance records under `docs/validation/nebulalab-openai-c/` remain
unchanged and do not validate the upgraded model settings.

The 2-of-3 quorum, deadlines, diff budgets, and Anthropic 2:1 account selection stay
unchanged. Self-hosted OpenAI calls use the approved review proxy. Anthropic retains
the dedicated Taiwan path. Neither fallback enters the target lane's model chain.

## Fixed secret interface

The six GitHub secret names stay fixed. For NebulaLab only, both C secrets become
versioned JSON. These examples contain placeholders, never real keys.

`PR_AGENT_LANE_C_KEY`:
```json
{"schema_version":1,"providers":{"openai":"<OpenAI key>","command-code":"<existing CC key>"}}
```

`PR_AGENT_LANE_C_API_BASE`:
```json
{"schema_version":1,"providers":{"openai":"https://api.openai.com/v1","command-code":"<existing CC HTTPS base>"}}
```

Both provider maps must exactly match `credential_providers`. Malformed or mismatched
bundles disable C and its cross routes without echoing input; A/B can still review. Every parsed nested key is masked before
requests or diagnostics. A provider selects both its key and endpoint. Legacy multiline
keys still mean separate accounts of one provider; bundles cannot use `key_weights`.
NebulaLab B stays plain and weighted 2:1.

## Production cutover

Never replace live C secrets while a caller can still run the old parser. This PR does
not write production secrets or pin callers to an unmerged central commit.

1. Merge the central change after remote Test and AI review cover its exact final head.
2. Prepare the NebulaLab caller PR with `uses`, `central_workflow_sha`, and the applicable
   `PR_REVIEW_CENTRAL_SHA` constant on that same merged 40-character SHA. Preserve the
   independent Claude workflow, permissions, and six secret mappings.
3. For a secret-format migration, drain or migrate active/queued runs and coordinate
   the caller/secret cutover so no review starts between the two secret writes. A model
   update that uses the existing bundle only requires re-pinning the caller.
4. Trigger a fresh event. Rerunning an old run keeps its old pin. Verify actual Sol high
   first-pass evidence, Terra high on the next round, and the Go-first fallback order.

For a bundle migration, retain the original CC credentials in 1Password and roll back
to a compatible caller and secret format together. A model-only rollback can keep
the current bundle. Never put values in files or logs.

## Key rotation

`scripts/set-lane-secret.ps1` writes one plain key. Before it asks for the key, it refuses
every target whose lane has `credential_providers` (a bundle) or `key_weights` (one key per
account), so since the 2026-11-03 last resort only Lane A is left to it. A key usually sits in
more than one slot, and each of them has to change:

| Key | Plain slots | Bundle entries |
| --- | --- | --- |
| OpenCode Go | Lane A, every repository (the script) | `opencode-go` in Lane B, every repository but NebulaLab |
| Anthropic, two accounts | NebulaLab's Lane B, one key per line | `anthropic` in Lane B, every repository but NebulaLab |
| Command Code | none | `command-code` in Lane C, every repository |
| OpenAI | none | `openai` in Lane C, every repository |

Rewrite a bundle whole, from the current 1Password values of both its providers, with a JSON
serializer as in the examples in this document. A slot left on an old key gets 401 from that
provider: the lane crosses to its other provider with no sign in the comment status, routes
that cross into the slot lose their fallback, and a 401 is not a spent quota, so the last
resort does not step in.

## Validation boundary

Contract tests cover legacy slots, provider pairing, fail-closed parsing, masking,
first-pass persistence, one Luna fallback, and unchanged A/B routes. Actual-runner
acceptance must use the production SDK and proxy and obtain real final output from
both OpenAI models and CC. Injected failures prove routing, not a real provider outage.

## Other repositories' last resort (2026-11-03)

License-Service, resume, Thesis, Docs, Plugins and ci-central keep Go and Command Code
first. Only when a lane's own route and its `cross_provider` route both report a spent
quota does `last_resort` send the review to a paid API in the lane's own slot:

| Lane | Last resort |
| --- | --- |
| A | None |
| B | Claude Haiku 5.5 on Anthropic, the two NebulaLab accounts split 2:1 |
| C | Sol high as a PR's first pass on a full round, otherwise Luna xhigh, on OpenAI |

Both slots become bundles; A stays plain. Generate them with a JSON serializer, never by
hand: the two Anthropic keys are one string joined by an escaped `\n`.

`PR_AGENT_LANE_B_KEY` / `PR_AGENT_LANE_B_API_BASE`:
```json
{"schema_version":1,"providers":{"opencode-go":"<Go key>","anthropic":"<key 1>\n<key 2>"}}
{"schema_version":1,"providers":{"opencode-go":"https://opencode.ai/zen/go/v1","anthropic":"https://api.anthropic.com/v1"}}
```

`PR_AGENT_LANE_C_KEY` / `PR_AGENT_LANE_C_API_BASE`:
```json
{"schema_version":1,"providers":{"command-code":"<CC key>","openai":"<OpenAI key>"}}
{"schema_version":1,"providers":{"command-code":"<CC HTTPS base>","openai":"https://api.openai.com/v1"}}
```

The cutover order is the one above, per repository: write both bundle pairs, then merge
the caller re-pin whose own review verifies them. A runner pinned before this change
rejects a bundle in these slots, and the new one rejects a plain value, so each
repository changes slots and pin together. GitHub-hosted callers reach both APIs
directly; License-Service runs self-hosted, so Anthropic keeps the Taiwan path and
OpenAI the approved review proxy.
