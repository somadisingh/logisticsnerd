# LogisticsNerd

LogisticsNerd is a proposed supplier-selection demo for small businesses buying ordinary goods, such as office supplies, packaging, and inventory.

It answers a simple buying question: **Which selected supplier can provide the required quantity by the deadline at the cheapest price?** An optional maximum budget can also constrain the choice.

## Current status

The project is in the research and planning stage. The application has not been built or tested, and the implementation stack has not been selected. There are no application setup or run commands yet.

The [procurement brief](LogisticsNerd_Procurement_Brief.md) defines the requirements, sample data, proposed architecture, and questions for discussion with Prof. Dennis Shasha at NYU Courant.

## Intended workflow

1. A buyer enters an item, quantity, required delivery date, and optional budget.
2. The buyer selects 3–5 suppliers.
3. Suppliers provide quotes with availability, unit or total price, and expected delivery date. The first demo may use explicitly mocked responses.
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

The 3–5 minute demonstration uses one item and three fabricated supplier quotes from the brief.

**Request:** 50 office chairs, required by October 15, 2026, with a $6,000 maximum budget.

| Supplier | Available quantity | Quoted total | Expected delivery | Expected result |
| --- | ---: | ---: | --- | --- |
| A — Metro Office Supply | 50 | $4,500 | October 12, 2026 | Recommended: cheapest feasible quote |
| B — Comfort Seating Co. | 50 | $5,200 | October 10, 2026 | Feasible, but $700 more than A |
| C — Budget Furnish LLC | 35 | $3,800 | October 14, 2026 | Rejected: insufficient quantity |

Success means the request → quotes → feasibility checks → comparison → recommendation flow runs end to end, with a correct, specific reason for every accepted or rejected quote.

## Scope

The first demo covers the buying decision using quantity, delivery deadline, price, and optional budget. Its minimal architecture is a buyer form, mocked responses or a simple supplier form, JSON or a small relational store, a comparison function, and a results view.

The brief excludes transportation routes, truck scheduling, warehouse operations, shipment tracking, inventory optimization, enterprise approval workflows, split orders, and weighted supplier scoring.

## Optional AI

If an LLM is used, the brief limits it to extracting structured request fields from free text or phrasing explanations from the computed results. Prices, availability, delivery dates, and rankings must come from the supplied quotes and deterministic comparison logic.

## Repository contents

- [README.md](README.md): project overview and current status.
- [LogisticsNerd_Procurement_Brief.md](LogisticsNerd_Procurement_Brief.md): the detailed requirements and original illustrative scenario.

Local research and build-planning documents are intentionally excluded from version control by `.gitignore`.
