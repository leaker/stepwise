# Development, deployment and CI

[Back to the README](../README.md)

## Local development

Requirements: a current Node release and pnpm. Browser Run, D1, R2 and Queues are all simulated locally.

```sh
pnpm install
pnpm db:migrate:local     # create the local D1 database and the demo project
pnpm dev                  # http://localhost:5173
```

Other scripts: `pnpm typecheck` (app, worker and shared), `pnpm test` (Vitest), `pnpm build`.

Optional settings go in `.dev.vars` (see `.dev.vars.example`):

- `ACCESS_CODE` - when set, every `/api` route except `/api/session` needs the code: the UI asks for
  it once and keeps an HttpOnly cookie (`__Host-sw_access` over https) for 30 days; scripts send `Authorization: Bearer <code>`
  (the *Run from CI* snippet in the project settings includes that header when a code is set). When the
  cookie runs out, or the code is changed, while a page is open, the form is shown over that page and
  nothing on it is lost: the editor saves what it could not as soon as the code is entered again.
  Use a long random code (for example `openssl rand -base64 24`). Wrong codes are counted per client
  address by the `ACCESS_LIMITER` rate limiting binding in `wrangler.jsonc`: after 10 in a minute the
  address gets 429 for a minute and its codes are not compared. That slows guessing down; it is the
  length of the code that makes guessing pointless.
- `ANTHROPIC_API_KEY` - enables the [AI assistant](ai-assistant.md). Without it the rest of the app is
  unaffected.
- `ASSISTANT_MODEL` - the model the assistant asks: `claude-haiku-5-5` (default), `claude-sonnet-5-5` or
  `claude-opus-5-5`. See [Model and cost](ai-assistant.md#model-and-cost).
- `ASSISTANT_DAILY_SESSIONS`, `ASSISTANT_DAILY_BUDGET_USD` - how many assistant sessions the deployment
  starts in 24 hours, and the estimated spend after which it starts no more (defaults: 100 and 40).
- `ASSISTANT_DEV_OVERRIDE=1` - local development only: lets `scripts/bench-assistant.mjs` choose the model
  of each session it starts.
- `ALLOWED_HOSTS` - comma-separated hostnames. When set, captures and navigate steps may only open
  these hosts and the app's own origin. This is checked before a browser is launched and again inside
  the browser, where every request is checked before it is sent (`worker/guard.ts`): a page or iframe on
  another host is not loaded, and a step that tries to leave the allowed hosts fails with that URL.
  Private and loopback addresses are refused the same way, with or without a list. Redirects are checked
  as they happen: the navigation is cancelled and its page is never shown, but the redirected request
  itself has already left the browser by then.

## Deploy

You need a Cloudflare account with access to Browser Run (Browser Rendering).

```sh
pnpm exec wrangler d1 create stepwise                    # copy database_id into wrangler.jsonc
pnpm exec wrangler r2 bucket create stepwise-screenshots
pnpm exec wrangler queues create stepwise-runs
pnpm db:migrate:remote                                   # again after every update that adds a file to migrations/
pnpm exec wrangler secret put ACCESS_CODE                # optional but recommended on a public URL
pnpm exec wrangler secret put ANTHROPIC_API_KEY          # optional: enables the AI assistant
pnpm run deploy
```

Anyone who can reach an ungated deployment can make it open arbitrary URLs in a browser on your
account, so set `ACCESS_CODE`, `ALLOWED_HOSTS` (under `vars` in `wrangler.jsonc`), or both.

## Triggering a batch run from CI

```sh
BASE=https://stepwise.example.workers.dev
PROJECT=<project id>
AUTH="Authorization: Bearer $STEPWISE_ACCESS_CODE"   # omit when no access code is set

id=$(curl -fsS -X POST "$BASE/api/projects/$PROJECT/batch-runs" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"trigger":"api"}' | jq -r .id)

while :; do
  status=$(curl -fsS -H "$AUTH" "$BASE/api/batch-runs/$id" | jq -r .status)
  case "$status" in queued|running) sleep 5 ;; *) break ;; esac
done

echo "Batch run finished: $status  ($BASE/api/batch-runs/$id)"
[ "$status" = succeeded ]   # failed, unresolved and aborted fail the job
```

Pass `"testCaseIds": ["...", "..."]` to run a subset. The full HTTP API is documented at the bottom of
`shared/types.ts`.
