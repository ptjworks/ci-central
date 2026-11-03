# NebulaLab Lane C migration

NebulaLab's C runs on OpenAI first. Since 2026-11-03 the other six repositories also use
provider bundles, for a last resort only (see the end of this page).

| Lane | First pass | Regular review | Same-model cross-provider route |
| --- | --- | --- | --- |
| A | Muse Spark 1.3 Contributor on Go | Same | CC through C / command-code |
| B | Sonnet 5.5 on Anthropic | Haiku 5.5 on Anthropic | Haiku through C / command-code |
| C | GPT-6.1 Sol on OpenAI, high reasoning | GPT-6 Luna on OpenAI, xhigh reasoning | Luna through C / command-code |

First-pass models never cross providers. Failure enters the regular model chain in
the same round. Only a valid first pass records completion; otherwise the next push
tries again. Success ends the lane's round, and its report stays folded in later comments.
Existing PRs without a C first-pass marker receive Sol at their next review. Existing
Terra first-pass markers remain valid and stay folded; the model upgrade does not
repeat an already completed first pass.

As of 2026-11-03, Peter has chosen Sol high for the first pass and Luna xhigh for
subsequent reviews. The planned OpenAI allowance is $200 per month, with unused
credits expiring. On 2026-11-03 Peter extended the same Sol/Luna rule to the other
repositories as their Lane C last resort, sharing this allowance. The allowance is
planning context, not a new runtime spending limit. Historical
Terra/medium acceptance records under `docs/validation/nebulalab-openai-c/` remain
unchanged and do not validate the upgraded model settings.

The 2-of-3 quorum, deadlines, diff budgets, and Anthropic 2:1 account selection stay
unchanged. Self-hosted OpenAI calls use the approved review proxy. Anthropic retains
the dedicated Taiwan path. There is no third Go hop after Luna on CC.

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
3. Drain or migrate active/queued runs and open PR caller/merge refs before they can
   receive the new format. Coordinate the caller/secret cutover so no review starts
   between the two secret writes.
4. Trigger a fresh event; rerunning an old run keeps its old pin. Verify actual Sol high
   first-pass evidence, Luna xhigh on the next head, correct provider labels and A/B CC routes.

Retain original CC credentials in 1Password. Rollback must restore a compatible caller
and the original plain C secret pair together. Never put values in files or logs.

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
