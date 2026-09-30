# LogisticsNerd

LogisticsNerd is a focused supplier-selection demo for small businesses buying ordinary goods, such as office supplies, packaging, and inventory.

It answers a simple buying question: **Which selected supplier can provide the required quantity by the deadline at the cheapest price?** An optional maximum budget can also constrain the choice.

## Current status

The one-item demo is implemented using Vite, vanilla TypeScript, plain CSS, and locally bundled fonts. It includes a request form, supplier selection, explicitly mocked quotes, deterministic comparisons, and explanations for every result. The interface supports desktop and mobile screens, keyboard input, and reduced motion.

Choose a curated scenario: **50 office chairs**, **100 reams of printer paper**, or **200 packaging boxes**, each with 4–5 fictional suppliers. Changing the deadline or budget reevaluates those facts; changing the item or quantity shows that no matching demo quotes are available. No prices are inferred or rescaled. Session state resets on reload. No external API or AI service is required.

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

1. Choose a sample scenario, then review or edit the item, quantity, required delivery date, and optional budget.
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

## Demo scenarios

Choose a scenario card to load its request and supplier pool. Switching scenarios replaces the request fields and supplier selection; **Restore example** reloads the current scenario. **Start again** clears the form while keeping the current supplier pool.

All scenario suppliers are selected initially. Choose any 3–5, then **Review supplier quotes** and **Find the best supplier**. Use **Adjust your request** to explore a different deadline or budget, or switch scenarios.

| Scenario | Request and budget | Suppliers | Default recommendation | What it demonstrates |
| --- | --- | ---: | --- | --- |
| Office chairs | 50 chairs by October 15, 2026; $6,000 | 5 | Metro Office Supply, $4,500 | Insufficient stock and a late offer cannot win |
| Printer paper | 100 A4 reams (500 sheets each) by October 8, 2026; $650 | 4 | Everyday Office Supply, $480 | A $420 offer loses because it arrives late |
| Packaging boxes | 200 medium cartons (12 × 9 × 6 inches) by October 12, 2026; $400 | 5 | Carton Collective, $280 | QuickPack delivers five days earlier for $70 more; the cheapest feasible quote still wins |

Each scenario compares equivalent goods within its supplier pool, with quoted totals assumed to include all charges. These are illustrative sample facts, not market prices. The recommendation always minimizes cost among feasible quotes; there is no separate fastest-delivery preference yet.

Useful walkthroughs:

- **Paper:** change the deadline to October 10 and Value Paper Depot wins at $420; tighten it to October 5 and Paper Express wins at $590.
- **Boxes:** change the deadline to October 6 and QuickPack wins at $350. With that deadline and a $300 budget, none qualify.
- **Any scenario:** change the quantity to an unsupported value to see the no-quotes state. Restore the current example to continue.

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
- [src/data/demo.json](src/data/demo.json): the fictional buyer, suppliers, and preserved original quote values.
- [src/data/scenarios.json](src/data/scenarios.json): additional chair suppliers and the paper and box scenarios.
- [src/data.ts](src/data.ts): scenario loading and matching sample quotes to the selected item, quantity, and suppliers.
- [tests/compare.test.ts](tests/compare.test.ts): business-rule and input-validation checks.
- [tests/scenarios.test.ts](tests/scenarios.test.ts): scenario winners, changes to constraints, quote isolation, and preservation of the original data.

Verification includes 40 automated checks, TypeScript checking, a production build, and browser walkthroughs of all three scenarios, scenario switching, changed deadlines, unsupported quantities, supplier selection, and mobile layouts.

Local research and build-planning documents are intentionally excluded from version control by `.gitignore`.
