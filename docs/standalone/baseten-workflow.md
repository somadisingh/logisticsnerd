# Baseten estimates in the order workflow

Implemented and verified on 21 October 2026 (America/New_York). This change connects the existing Baseten estimate generator to the local order demo. It does not implement persistent OperationsNerd integration or contact suppliers.

## Use it

1. Run `npm run dev` and open the workflow homepage.
2. Choose **AI estimates · Baseten**. Choosing a source resets the synthetic session; it makes no model call.
3. Set the USD purchase budget before creating the order. The budget covers the entire purchased shortage.
4. Create the 15-unit order and reserve the available 4.
5. Click **Generate AI estimates** for the remaining 11. This makes a server-side Baseten generation request or reuses matching valid estimates from Redis.
6. Review the offers, factual rule explanations, model, generation/expiry and cache status. If feasible, explicitly approve the displayed purchases, receive each PO and fulfill the order.

The saved live offers verified here permit completion with a $300 budget: Supplier Z offers 11 units for $218.90 by October 29. This is a dated, hypothetical estimate, not a current supplier promise. Future generations can differ or yield no feasible purchase plan. Prepared sample mode still reproduces the original $11.80, 7 + 4 split without credentials.

## Rules and boundaries

- Model input is derived on the server from the in-memory order, item and unallocated shortage. Clients cannot submit company/owner IDs or quote data to the demo endpoint.
- Baseten supplies hypothetical capacity, explicit all-in linear USD unit prices and dates for three fictional supplier identities. It chooses no purchases. Python calculates feasibility and single/split sourcing independently.
- The original comparison's total-price schema and cache identity remain the defaults. Workflow unit pricing uses `procurement-estimates-v4-unit-v1` and a separate digest, preventing accidental reuse or prorating of an old total-price lot. Both use the existing validated seven-day Redis cache and model fallback/error handling.
- `quantity_priced` is the requested shortage quantity; capacity is independent. Purchased quantity is the explicit Python allocation, bounded by both. A new generic `add_quotes` rule stores the complete immutable batch and operation result atomically in the fake adapter; invalid batches leave no partial quotes.
- AI mode uses current UTC time for provenance, expiry and approval revalidation. Prepared sample mode keeps its deterministic fixture clock. Quote/PO terms stay frozen; source changes/reset discard demo fixtures only.
- Recommendations create no POs. Explicit fixture-owner approval changes no on-hand stock. Receipt and fulfillment use the existing idempotent Python commands. Receiving handles one, two or three selected suppliers; the selected supplier is resolved within Company A's existing purchases.
- The model receives no API key through the browser. Credentials remain server-side. Page load, source selection, stock actions and approval do not trigger generation. Errors remain visible; no silent substitution of prepared offers occurs.
- Inventory, company identities and approvals remain simulated. Redis is an estimate cache, not authoritative inventory or purchase storage. No shared migrations, core authentication, accounting or OperationsNerd UI/backend integration was added.

## Actual verification

Automated checks (no live model calls):

```text
python3 -m unittest discover -s tests_python -v   79 passed
npm test                                        286 passed
npm run build                                   passed
```

Coverage includes explicit unit pricing, legacy total compatibility, isolated Redis records, cache reuse, server-derived input, provider failure without fallback data, rejection of forged estimate fields, atomic batch rollback, live-clock expiry, immutable budgets, single Z purchase, two/three-supplier receipts, replay and company isolation. Full results are in [baseten-workflow-tests.txt](results/baseten-workflow-tests.txt).

Live browser check with the configured server key and Redis:

| Check | Actual result |
| --- | --- |
| Fresh generation | DeepSeek-V4.1-Flash; `cached=false`; generated `2026-10-22T00:21:55.307Z` (Oct 21 locally), expiry `2026-10-29T00:21:55.307Z`. |
| $150 purchase budget | X and Y were rejected for November 5/12 delivery after the November 1 deadline. Z was on time, but $218.90 exceeded $150. No PO created; on-hand remained 6. |
| Same offers, $300 budget | `cached=true`; no fresh generation. Python chose Z for 11 units at $218.90; no PO until explicit approval. |
| Approve → receive → fulfill | Approval kept stock 6; full receipt added 11; fulfillment consumed 15; final stock/reservations 2/2. Replay and Company B rejection preserved balances. |
| Browser review | Prepared flow still completed; AI feasible/infeasible views and model/cache disclosure reviewed at desktop and 390px mobile. No page errors or horizontal overflow. |

The first live walkthrough reached and verified the rejection result, then its temporary harness attempted an already-selected disabled source button during cleanup and timed out. The corrected cached walkthrough completed successfully and reset the demo. These were browser-harness issues; the live result, Python validation and later cached lifecycle were verified separately.

Evidence: [live result](results/baseten-live-result.json), [cached workflow checks](results/baseten-cached-checks.json). Local screenshots are kept in the ignored `.local-planning/workflow-ai/` folder. No credentials are recorded in these artifacts.
