# opencode-rs-guard

OpenCode V2 plugin: self-heal for Responses-style **reasoning continuation** failures.

## Errors handled

- `reasoning encrypted_content was not issued to this caller`
- `invalid_encrypted_content` / `could not be verified`
- `Referenced reasoning item 'rs_..:rs_..' was not found or has expired`

Seen on Gateway Console free models (e.g. `muse-spark-1.3-contributor-free`
failing on message 2–3 of a fresh session) and on Responses API with
`store: false` after a few tool turns. Same family as upstream
`anomalyco/opencode` PR #28678 (don't replay `rs_*` ids when stateless) and
PR #29000 (summary splitting, encrypted replay, `item_reference` when stored).

## How it works

- `context` / `compaction` / `generate` hooks: force stateless full replay
  (drop `previous_response_id`, force `store: false`), drop
  `include: reasoning.encrypted_content`, strip server-issued ids from
  metadata, keep at most 1 newest encrypted blob.
- `retry` hook: on a matching error, flag the session so the next request
  goes out with **no reasoning at all** (fresh reasoning), one retry with
  `delay: 0`. No artificial delays — any visible pause is just the failed
  request plus the fresh retry round-trip.

Local part ids are never touched, so tool-call / tool-result pairing is safe.

## Install

```sh
# from GitHub
opencode plugin add github:<you>/rs-guard

# or local path
# opencode.jsonc: { "plugins": ["./path/to/rs-guard"] }
```

Requires OpenCode V2 (`@opencode/plugin` v2). The plugin id is `rs-guard`.

## Verify

1. Open a fresh session on the failing model.
2. Send 2–3 messages — previously this failed with the errors above.
3. If a continuation error still slips through once, the plugin retries a
   single time without reasoning; the next turn is clean.
4. `opencode plugin list` shows the plugin as `local` (or the Git source).

## Notes

- This is a client-side mitigation, not a server fix. If the provider keeps
  expiring ids aggressively, starting a new session clears the stale
  checkpoint.
- `⚠ Retry attempt 2 scheduled: The provider response ended unexpectedly`
  is unrelated (an `incomplete-stream` retry from OpenCode core when the SSE
  stream drops before the terminal event) and benign as long as the answer
  completes.

## License

MIT — see [LICENSE](./LICENSE).
