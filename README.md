# LogisticsNerd

LogisticsNerd is a focused supplier-selection demo for small businesses buying ordinary goods, such as office supplies, packaging, and inventory.

It answers a simple buying question: **Which selected supplier can provide the required quantity by the deadline at the cheapest price?** An optional maximum budget can also constrain the choice. Buyers can now choose **Earliest delivery** instead; the same quantity, deadline, and budget requirements still apply.

## Current status

The one-item demo is implemented using Vite, vanilla TypeScript, plain CSS, and locally bundled fonts. It includes a request form, supplier selection, **Baseten AI estimates** or **sample data**, deterministic comparisons, and explanations for every result. The interface supports desktop and mobile screens, keyboard input, and reduced motion.

Choose a starting point: **50 office chairs**, **100 reams of printer paper**, or **200 packaging boxes**, each with 4–5 fictional suppliers. AI mode supports custom ordinary goods and quantities, returning hypothetical prices, stock, and delivery dates. **Use sample data** retains the original prepared offers and works without an API key. In sample mode, a changed item or quantity has no matching quotes; sample prices are never rescaled. Session state resets on reload.

Generated offers are labeled **AI-generated estimates · No suppliers contacted**. They are not verified supplier quotes, live inventory, or delivery promises. The application computes the cheapest and earliest feasible options from the same validated offers.

The [procurement brief](LogisticsNerd_Procurement_Brief.md) defines the requirements, sample data, proposed architecture, and questions for discussion with Prof. Dennis Shasha at NYU Courant.

## Run locally

Use Node.js 24.x, or another supported version listed in `package.json`.

```sh
npm ci
npm run dev
```

Open the local address printed by Vite, normally `http://127.0.0.1:5173/`.

```sh
npm test          # Business rules, API contract checks, and sample regression checks
npm run build    # Type checking and a static production build
npm run preview  # Serve the production build locally
```

The preview normally runs at `http://127.0.0.1:4173/`. Both servers bind to the local machine. Fonts and sample data are bundled with the application.

## Intended workflow

1. Choose **AI estimates** or **Use sample data**, then review or edit the item, quantity, required delivery date, and optional budget. Select **Lowest cost** (the default) or **Earliest delivery**.
2. The buyer selects 3–5 suppliers.
3. Generate hypothetical supplier estimates, or load the prepared sample responses. Review quantity, total price, delivery date, and any stated assumptions.
4. The system checks each quote against the request.
5. It recommends the best feasible supplier for the selected preference and explains the recommendation and any rejections.
6. The buyer reviews the result, switches the preference to compare alternatives, and sees the extra cost of earlier delivery.

## Decision rules

The comparison is deterministic:

- Reject a quote if its available quantity is below the requested quantity.
- Reject a quote if its expected delivery date is after the required date.
- Reject a quote if its total cost exceeds a stated maximum budget.
- **Lowest cost:** recommend the lowest total cost among qualifying quotes; earlier delivery breaks a price tie.
- **Earliest delivery:** recommend the earliest delivery among qualifying quotes; lower total cost breaks a delivery tie.
- If both price and delivery date are identical, show all tied best quotes.
- If none qualify, explain why and prompt the buyer to review quantity, deadline, suppliers, or budget.

The recommendation applies these rules to the selected data source: AI-generated hypothetical offers or prepared fictional quotes. It does not verify stock or guarantee actual delivery.

## Demo scenarios

The following prices and winners describe **sample data**. AI-generated offers will differ. Choose a scenario card to load its request and supplier pool. Switching scenarios replaces the request fields and supplier selection, preserving the chosen preference; **Restore example** reloads the current scenario. **Start again** clears the form and resets the preference to Lowest cost while keeping the current supplier pool.

All scenario suppliers are selected initially. In sample mode, choose any 3–5, then **Review supplier quotes** and **Find the best supplier**. Use **Adjust your request** to explore a different deadline or budget, or switch scenarios. AI mode uses **Generate supplier estimates** for the same comparison flow.

| Scenario | Request and budget | Suppliers | Default recommendation | What it demonstrates |
| --- | --- | ---: | --- | --- |
| Office chairs | 50 chairs by October 15, 2026; $6,000 | 5 | Metro Office Supply, $4,500 | Insufficient stock and a late offer cannot win |
| Printer paper | 100 A4 reams (500 sheets each) by October 8, 2026; $650 | 4 | Everyday Office Supply, $480 | A $420 offer loses because it arrives late |
| Packaging boxes | 200 medium cartons (12 × 9 × 6 inches) by October 12, 2026; $400 | 5 | Carton Collective, $280 | QuickPack delivers five days earlier for $70 more; the cheapest feasible quote still wins |

Each scenario compares equivalent goods within its supplier pool, with quoted totals assumed to include all charges. These are illustrative sample facts, not market prices. Both preferences filter out insufficient, late, or over-budget quotes before ranking.

With the default request constraints and all suppliers selected:

| Scenario | Lowest cost | Earliest delivery | Delivery trade-off |
| --- | --- | --- | --- |
| Office chairs | Metro Office Supply, $4,500, October 12 | Comfort Seating Co., $5,200, October 10 | 2 days earlier for $700 more |
| Printer paper | Everyday Office Supply, $480, October 7 | Paper Express Co., $590, October 5 | 2 days earlier for $110 more |
| Packaging boxes | Carton Collective, $280, October 11 | QuickPack Supply, $350, October 6 | 5 days earlier for $70 more |

The result includes a preference switch and an explicit price-versus-delivery comparison, computed from the currently feasible quotes. Switching preferences does not fetch new quotes or relax requirements.

Useful walkthroughs:

- **Paper:** change the deadline to October 10 and Value Paper Depot wins at $420; tighten it to October 5 and Paper Express wins at $590.
- **Boxes:** change the deadline to October 6 and QuickPack wins at $350. With that deadline and a $300 budget, none qualify.
- **Any sample scenario:** change the quantity to an unsupported value to see the no-quotes state. Restore the current example to continue, or select AI estimates for a custom quantity.

### Original chair example

The original three suppliers and quote values from the brief are preserved. Two additional fictional suppliers expand the chair pool to five without changing its original winner.

**Request:** 50 office chairs, required by October 15, 2026, with a $6,000 maximum budget.

| Supplier | Available quantity | Quoted total | Expected delivery | Expected result |
| --- | ---: | ---: | --- | --- |
| A — Metro Office Supply | 50 | $4,500 | October 12, 2026 | Recommended: cheapest feasible quote |
| B — Comfort Seating Co. | 50 | $5,200 | October 10, 2026 | Feasible, but $700 more than A |
| C — Budget Furnish LLC | 35 | $3,800 | October 14, 2026 | Rejected: insufficient quantity |
| Workspace Essentials | 50 | $5,800 | October 13, 2026 | Feasible, but $1,300 more than A |
| Atelier Office Co. | 50 | $4,800 | October 18, 2026 | Rejected: misses deadline |

Success means the request → quotes → feasibility checks → comparison → recommendation flow runs end to end, with a correct, specific reason for every accepted or rejected quote.

## Scope

The demo covers the buying decision using quantity, delivery deadline, price, and optional budget. Its architecture is a buyer form, a local server adapter or JSON sample data, in-memory state, a comparison function, and a results view. It does not submit purchase orders or contact suppliers. Offers describe comparable goods with all charges assumed included, in USD.

Prices and budgets are compared in integer cents; delivery deadlines are inclusive. Ranking follows the selected preference and its tie rule. If both price and date are identical, the result shows the tied feasible alternatives for the buyer to choose from.

The brief excludes transportation routes, truck scheduling, warehouse operations, shipment tracking, inventory optimization, enterprise approval workflows, split orders, and weighted supplier scoring.

## Baseten AI estimates

AI mode is a later user-requested extension to the original brief. Section 8 of that brief limits LLMs to extraction and explanations; this demo now also permits explicitly hypothetical offer generation. The original sample quotes remain available. Supplier ranking and feasibility reasons always come from deterministic code.

### Configure locally

Copy `.env.example` to `.env.local` if the local file does not exist. Preserve any existing settings. Add the following server-only credentials:

```env
BASETEN_DEEPSEEK_API_KEY=
BASETEN_GLM_FLASH_API_KEY=
BASETEN_GLM_FAST_API_KEY=
BASETEN_MODEL_ORDER=deepseek,glm_flash,glm_fast
REDIS_URL=
```

The same Baseten account API key can be used in all three key fields. Configured models must be available to that account with sufficient credit. `.env.local` is gitignored; never use `VITE_` prefixes for secrets. The server rereads configuration for requests, so adding a key does not require rebuilding.

AI mode requires the Baseten keys and a Redis connection URL. Open the main application at `/`, select **AI estimates**, and click **Generate supplier estimates**. The UI's connection check confirms local model/cache configuration, not successful provider authentication or Redis connectivity. Use **Check connection** after completing configuration. Sample mode makes no model requests.

### Persistent Redis setup

**Managed Redis:** create an account-owned Redis database, then copy its TCP connection URL into the `REDIS_URL` placeholder in `.env.local`. For Upstash, use the TLS **Redis/TCP** connection option, which starts with `rediss://`; the HTTPS REST URL/token is a different interface. Keep the URL server-only because it includes a password. Upstash documents [persistent storage](https://upstash.com/docs/redis/features/durability/) across service restarts. Choose a database region near the app server, use its primary endpoint, and keep key eviction disabled when retaining entries matters.

```env
REDIS_URL=rediss://default:YOUR_PASSWORD@YOUR_REDIS_HOST:YOUR_PORT
```

**Local Docker alternative:** with Docker running, start the included Redis service and set its local URL:

```sh
docker compose up -d redis
```

```env
REDIS_URL=redis://127.0.0.1:6379/0
```

[compose.yaml](compose.yaml) stores data in a named volume, enables append-only persistence with a write flush every second, and binds the port to loopback. Closing the browser or stopping the Vite server leaves Redis and its data independent. Stopping/recreating the container retains the volume; deleting that volume removes its data. Local Redis must be running to serve cache misses. A sudden machine failure can lose approximately the most recent second of writes under this policy; see [Redis persistence](https://redis.io/docs/latest/management/persistence/).

### Request and comparison behavior

- The browser sends item, quantity, deadline, optional budget, and 3–5 selected supplier identities to `/api/procurement/estimates`.
- On a cache miss, the server combines a fixed base prompt with the item, unit, quantity, selected suppliers, and current UTC date, and requests schema-constrained output from Baseten. Budget and deadline stay in the application for feasibility checks; they do not influence generated offers. The server validates supplier coverage, integer prices and quantities, real dates, and clarification responses before passing data to the application.
- Default order is **DeepSeek V4.1 Flash → GLM 5.3 Flash → GLM 5.3 Fast**, based on the small live evaluation below. `BASETEN_MODEL_ORDER` can change it. DeepSeek uses `reasoning_effort: none`; both GLM models use `low`. Missing keys are skipped. Transient failures and invalid outputs may use a fallback; authentication, billing, and configuration errors stop the request.
- Each attempt has an 18-second limit and the whole fallback sequence has a 45-second budget. Rate-limit pauses are respected.
- Cancelling or editing a pending request detaches that caller. If it was the last caller waiting for those estimates, the network/model call is aborted and further fallback attempts stop. Other callers sharing the same generation can still receive their result. Stale responses do not replace the edited request.
- Changing the preference, budget, or deadline reuses the same cached facts and recomputes the decision. A valid result with no feasible supplier is retained. The model can request clarification for ambiguous goods.
- The model supplies estimated facts and assumptions. Both the server and frontend compute the cheapest and earliest feasible options with the same comparison rules. No model-selected winner is trusted.

The inputs do not include a delivery address or detailed product specification. Standard-quality comparable goods, domestic US delivery, USD, and totals including assumed charges are stated demo assumptions. Model estimates cannot establish real supplier price accuracy or availability.

### Cache behavior

The application checks **browser memory → server memory → Redis → Baseten**, in that order. A fresh browser hit needs no HTTP request; a fresh server or Redis hit needs no model call. Successful, validated offers are saved in Redis before the server returns them, with a **seven-day expiry from generation completion**. Reading an entry never extends its expiry, and memory entries cannot outlive the original expiry. Redis entries retain the original generation and as-of dates.

- **Cheapest/fastest switches:** comparisons run locally, with no HTTP or model call.
- **Budget/deadline changes:** reuse the same offers and recompute both comparisons. Request and item IDs are remapped to the current submission.
- **Changed goods, unit, quantity, or suppliers:** use a different cache key. Whitespace, casing, and supplier order are normalized. Keys include the prompt/model configuration version and a private credential fingerprint, with no daily date component. Redis key names are hashed rather than exposing buyer inputs or credentials.
- **Delivery freshness:** if any saved delivery date has passed, refresh the whole offer set even within seven days. Dates and feasibility are rechecked before reuse; offers with a past date are never presented as a current delivery estimate. The seven-day period is a maximum cache age.
- **Repeated concurrent submissions:** share one pending request in the browser and one generation on the server. Different server instances coordinate through a Redis lock with a 90-second lease. Waiting callers read the saved result within a bounded wait; publishing the result and releasing the lock happen atomically only for its owner. Pending work is separate from saved entries.
- **Bounds:** up to 20 browser entries and 100 server entries, evicting the least recently used. The server allows at most two new generations at once; cache hits and callers joining pending work remain available.
- **Failures:** failed or invalid model generations are not saved. A valid offer set with no feasible winner is reusable. Valid clarification responses are saved in Redis too. Cancelled callers cannot initiate fallback work; an already committed Redis write remains valid. Redis errors stop a cache miss instead of silently making an uncoordinated paid model call. Connections and commands have bounded timeouts, with no offline command replay.
- **Lifetime:** refreshing the page clears browser memory; restarting the app server clears server memory. Redis still serves the next submission. Server key/model-order changes select a new cache namespace and cancel old pending work; old Redis entries expire naturally. Nothing is persisted to browser storage.

Redis is required by the application's AI middleware. The optional live model evaluation CLI bypasses Redis intentionally to measure inference. The cache flow follows Redis's [cache-aside pattern](https://redis.io/docs/latest/develop/use-cases/cache-aside/); the lock follows its documented [token-checked locking approach](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/).

### Verify Redis without model charges

```sh
npm run test:redis -- --configured  # Test REDIS_URL from .env.local
npm run test:redis                 # Test local Redis on port 6379
```

This probe uses simulated model responses and uniquely scoped verification keys, then removes only its own keys. It checks real Redis connections, shared generation across app instances, reuse after recreating the app/connection, one-week TTL, retained original expiry, and safe lock ownership. It does not contact Baseten. Reports are saved to the gitignored `.local-planning/api-research/redis-tests/` folder.

For a disposable Redis with a restart persistence check, provide an existing binary: `npm run test:redis -- --server-bin /absolute/path/to/redis-server`. A verification run against Redis 8.10.2 passed with AOF persistence, one fixture generation, and zero real model calls; actual Redis and app-instance restarts retained the record.

### Optional live evaluation

```sh
npm run test:estimates -- --quick  # Three scenarios on each configured model
npm run test:estimates            # Also custom quantity, ambiguity, impossible constraints, and a repeat
```

This command makes live Baseten inference requests and may incur usage charges. `npm test` uses simulated responses and does not contact model providers. The evaluation CLI stores normalized reports in the gitignored `.local-planning/api-research/baseten-tests/` folder and prints outcome, latency, and token summaries. It measures usable structured estimates and comparison behavior; it does not benchmark real market-price accuracy.

**Live evaluation, October 3, 2026:** all three keys authenticated. The final comparison used seven cases per model: chairs, paper, boxes, custom quantity, ambiguous goods, impossible constraints, and a repeated chair request.

| Model | Expected behavior passed | Median time for passing cases | Longest passing case |
| --- | ---: | ---: | ---: |
| DeepSeek V4.1 Flash | 7/7 | 0.99 seconds | 1.51 seconds |
| GLM 5.3 Flash | 7/7 | 1.12 seconds | 2.30 seconds |
| GLM 5.3 Fast | 6/7 | 1.03 seconds | 1.82 seconds |

GLM Fast generated offers for ambiguous “supplies” instead of asking a question; that failed case took 7.60 seconds and is excluded from its passing-case latency figures. An earlier DeepSeek run with low reasoning truncated two outputs. Disabling its reasoning and refining the prompt produced the final result above, so DeepSeek is the primary and GLM Flash is the first fallback.

This is a small functional evaluation of valid outputs, clarification behavior, and comparison constraints. It is not a broad reliability benchmark, a response-time guarantee, or evidence that hypothetical prices match actual supplier quotes.

These API endpoints run with `npm run dev` and `npm run preview`. Deploying `dist/` to static hosting alone does not provide the backend; a hosted server with server-only credentials is needed for AI mode.

## Repository contents

- [README.md](README.md): project overview and current status.
- [LogisticsNerd_Procurement_Brief.md](LogisticsNerd_Procurement_Brief.md): the detailed requirements and original illustrative scenario.
- [src/main.ts](src/main.ts): the three-step interface and session flow.
- [src/estimates-client.ts](src/estimates-client.ts): browser memory caching, shared pending requests, cancellation, response validation, and recomputed comparisons.
- [server/procurement.mjs](server/procurement.mjs): the base prompt, output schema, semantic validation, Baseten calls, fallback limits, and caching.
- [server/procurement-middleware.mjs](server/procurement-middleware.mjs): local status and estimate endpoints.
- [server/redis-cache.mjs](server/redis-cache.mjs): server-only Redis connection, bounded commands, cache TTL, and ownership-checked locks.
- [compose.yaml](compose.yaml): optional local Redis with a persistent named volume.
- [scripts/verify-redis.mjs](scripts/verify-redis.mjs): optional real Redis verification with simulated model output and isolated test keys.
- [scripts/probe-estimates.mjs](scripts/probe-estimates.mjs): optional live model evaluation and ignored reports.
- [tests/procurement.test.mjs](tests/procurement.test.mjs): simulated estimate contracts, failures, fallback behavior, and cache checks.
- [tests/redis-cache.test.mjs](tests/redis-cache.test.mjs): Redis adapter contracts, expiry, safe errors, and lock ownership.
- [tests/estimates-client.test.ts](tests/estimates-client.test.ts): response validation, recomputed recommendations, cancellation, and error handling.
- [.env.example](.env.example): credential placeholders without secret values.
- [src/domain/compare.ts](src/domain/compare.ts): deterministic feasibility checks and ranking.
- [src/data/demo.json](src/data/demo.json): the fictional buyer, suppliers, and preserved original quote values.
- [src/data/scenarios.json](src/data/scenarios.json): additional chair suppliers and the paper and box scenarios.
- [src/data.ts](src/data.ts): scenario loading and matching sample quotes to the selected item, quantity, and suppliers.
- [tests/compare.test.ts](tests/compare.test.ts): business-rule and input-validation checks.
- [tests/scenarios.test.ts](tests/scenarios.test.ts): scenario winners, changes to constraints, quote isolation, and preservation of the original data.
- [tests/preferences.test.ts](tests/preferences.test.ts): both ranking preferences, tie rules, shared feasibility constraints, and price/delivery explanations.
- [shipping-lab.html](shipping-lab.html): an experimental comparison page for SMKlog, EasyPost, and AfterShip.
- [server/shipping.mjs](server/shipping.mjs): server-only shipping adapters, input checks, normalization, and request caching.
- [tests/shipping.test.mjs](tests/shipping.test.mjs): simulated provider contracts and failure handling; no live requests in the automated suite.

Verification includes **242 automated checks**, TypeScript checking, a production build, and browser walkthroughs of the original sample scenarios, preference switching, retained form edits, changed deadlines and budgets, unsupported quantities, supplier selection, keyboard controls, and mobile layouts. AI browser checks also cover generated chair estimates, a custom request for boxes of pens, different cheapest/fastest winners, cached budget changes with no feasible result, clarification for ambiguous goods, and the preserved original sample winner. Cache regressions cover zero extra calls for unchanged configurations, seven-day expiry, reuse after app-server restarts, date freshness, cross-instance generation sharing, independent caller cancellation, configuration changes, Redis outages, and lock ownership. AI mode's live model comparison is tracked separately above. Simulated API tests validate integration behavior; they do not establish provider reliability or prediction accuracy.

## Shipping API comparison experiment

Open `/shipping-lab.html` on the running local dev or preview server. The page compares **one packed US domestic parcel** independently of seller prices. It uses hypothetical sample measurements that can be replaced with actual measurements. It does not modify the supplier ranking or buy shipping labels.

1. Copy `.env.example` to `.env.local` (if a local file already exists, preserve it).
2. Add an **EasyPost test API key** as `EASYPOST_TEST_API_KEY`. The adapter retrieves rates and attempts SmartRate delivery prediction for the planned pickup date. A denied prediction call leaves rates usable and deadline suitability unknown.
3. Add `AFTERSHIP_API_KEY`; set `AFTERSHIP_EDD_ENABLED=true` only after AfterShip activates delivery prediction for that account.
4. The initial live SMKlog probe returned **HTTP 403 / Cloudflare error 1010** with an instruction not to retry. `SMKLOG_ENABLED` therefore defaults to `false`. Set it to `true` only after provider access is restored.
5. Click **Check setup**, select ready providers, edit parcel inputs, then **Run API comparison**.

Keys remain on the local server. Never use `VITE_` prefixes for credentials. The server reads `.env.local` again for setup checks and requests, so adding credentials does not require rebuilding. This experimental middleware works with `npm run dev` and `npm run preview`; uploading `dist/` to static hosting alone will not provide these API endpoints.

For a terminal comparison:

```sh
npm run test:shipping
npm run test:shipping -- --providers=easypost,aftership
# Optional: a local JSON file with the parcel fields used in src/shipping-lab.ts
npm run test:shipping -- path/to/parcel.json --providers=easypost
```

The CLI saves normalized results in the gitignored `.local-planning/api-research/shipping-tests/` folder. Browser results stay in memory. Identical requests are cached for ten minutes in the local server session; access denials and rate limits stop further calls to that provider until configuration changes or the server restarts. There is no polling or automatic retry.

SMKlog does not accept our planned pickup date, so its reported dates are displayed separately without deciding deadline suitability. EasyPost deadlines use only predictions explicitly anchored to the requested pickup date. AfterShip deadline checks use the latest supplied date in its estimate window. Missing dates remain unknown; predicted dates are not supplier promises. EasyPost test mode cannot be used to compare live prices or delivery accuracy against the other two providers.

**Live comparison status:** SMKlog was probed and denied access. EasyPost and AfterShip authenticated tests await credentials. No winning provider has been established. See the official [SMKlog guide](https://smklog.com/api), [EasyPost shipment API](https://docs.easypost.com/docs/shipments), [SmartRate delivery dates](https://docs.easypost.com/docs/shipments/shipping-smartrate), and [AfterShip prediction API](https://www.aftership.com/docs/tracking/1o2zu0jrca785-prediction-for-the-estimated-delivery-date).

Local research and build-planning documents are intentionally excluded from version control by `.gitignore`.
