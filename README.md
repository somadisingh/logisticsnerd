# LogisticsNerd

LogisticsNerd is a focused supplier-selection demo for small businesses buying ordinary goods, such as office supplies, packaging, and inventory.

It answers a simple buying question: **Which selected supplier can provide the required quantity by the deadline at the cheapest price?** An optional maximum budget can also constrain the choice.

## Current status

The one-item demo is implemented using Vite, vanilla TypeScript, plain CSS, and locally bundled fonts. It includes a request form, supplier selection, explicitly mocked quotes, deterministic comparisons, and explanations for every result. The interface supports desktop and mobile screens, keyboard input, and reduced motion.

The sample responses apply to **50 office chairs**. Changing the deadline or budget reevaluates those facts; changing the item or quantity shows that no matching demo quotes are available. No prices are inferred or rescaled. Session state resets on reload. No external API or AI service is required.

The [procurement brief](LogisticsNerd_Procurement_Brief.md) defines the requirements, sample data, proposed architecture, and questions for discussion with Prof. Dennis Shasha at NYU Courant.

## Run locally

Use Node.js 24.x, or another supported version listed in `package.json`.

```sh
npm ci
npm run dev
```

Open the local address printed by Vite, normally `http://127.0.0.1:5173/`.

```sh
npm test          # Business rules, validation, and sample regression checks
npm run build    # Type checking and a static production build
npm run preview  # Serve the production build locally
```

The preview normally runs at `http://127.0.0.1:4173/`. Both servers bind to the local machine. Fonts and sample data are bundled with the application.

## Intended workflow

1. A buyer enters an item, quantity, required delivery date, and optional budget.
2. The buyer selects 3–5 suppliers.
3. Review the explicitly mocked responses with available quantity, quoted total, and expected delivery date.
4. The system checks each quote against the request.
5. It recommends the cheapest feasible supplier and explains the recommendation and any rejections.
6. The buyer reviews the result.

## Decision rules

The comparison is deterministic:

- Reject a quote if its available quantity is below the requested quantity.
- Reject a quote if its expected delivery date is after the required date.
- Reject a quote if its total cost exceeds a stated maximum budget.
- Recommend the lowest total cost among the quotes that meet those requirements.
- When feasible quotes have equal cost, prefer the earlier delivery date.
- If none qualify, explain why and prompt the buyer to review quantity, deadline, suppliers, or budget.

The recommendation uses supplier-provided facts. It does not verify stock or guarantee actual delivery.

## Planned demo

The 3–5 minute demonstration uses one item and three fabricated supplier quotes from the brief. The form starts with the example populated; choose **Review supplier quotes**, then **Find the best supplier**. Use **Adjust your request** to explore a different deadline or budget.

**Request:** 50 office chairs, required by October 15, 2026, with a $6,000 maximum budget.

| Supplier | Available quantity | Quoted total | Expected delivery | Expected result |
| --- | ---: | ---: | --- | --- |
| A — Metro Office Supply | 50 | $4,500 | October 12, 2026 | Recommended: cheapest feasible quote |
| B — Comfort Seating Co. | 50 | $5,200 | October 10, 2026 | Feasible, but $700 more than A |
| C — Budget Furnish LLC | 35 | $3,800 | October 14, 2026 | Rejected: insufficient quantity |

Success means the request → quotes → feasibility checks → comparison → recommendation flow runs end to end, with a correct, specific reason for every accepted or rejected quote.

## Scope

The demo covers the buying decision using quantity, delivery deadline, price, and optional budget. Its architecture is a buyer form, JSON sample data, in-memory state, a comparison function, and a results view. It does not submit purchase orders or contact suppliers. Quotes are assumed to describe comparable goods with all charges included, in USD.

Prices and budgets are compared in integer cents; delivery deadlines are inclusive. Equal-price quotes are resolved by earlier delivery. If both price and date are identical, the result shows the tied feasible alternatives for the buyer to choose from.

The brief excludes transportation routes, truck scheduling, warehouse operations, shipment tracking, inventory optimization, enterprise approval workflows, split orders, and weighted supplier scoring.

## Optional AI

If an LLM is used, the brief limits it to extracting structured request fields from free text or phrasing explanations from the computed results. Prices, availability, delivery dates, and rankings must come from the supplied quotes and deterministic comparison logic.

## Repository contents

- [README.md](README.md): project overview and current status.
- [LogisticsNerd_Procurement_Brief.md](LogisticsNerd_Procurement_Brief.md): the detailed requirements and original illustrative scenario.
- [src/main.ts](src/main.ts): the three-step interface and session flow.
- [src/domain/compare.ts](src/domain/compare.ts): deterministic feasibility checks and ranking.
- [src/data/demo.json](src/data/demo.json): the fictional buyer, suppliers, and original quote values.
- [tests/compare.test.ts](tests/compare.test.ts): business-rule and input-validation checks.

Verification includes 24 automated checks, TypeScript checking, a production build, and browser walkthroughs of the original example, changed deadlines, unsupported quantities, keyboard selection, and mobile layouts.

Local research and build-planning documents are intentionally excluded from version control by `.gitignore`.
