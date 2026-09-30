# LogisticsNerd — Revised Brief: Small-Business Supplier Selection

**For discussion with Prof. Dennis Shasha (NYU Courant).** This replaces the earlier freight-routing scope. Everything below is research and proposed design — nothing has been built or tested unless a line says so explicitly.

---

## 1. Revised problem statement

A small business regularly needs to buy ordinary goods — office supplies, packaging, inventory — by a specific date. Today it does this by emailing a few suppliers, waiting for replies, and manually comparing price, quantity, and delivery promises in a spreadsheet or by memory. This is slow and error-prone, and it's easy to miss that a cheap quote can't actually meet the deadline or quantity.

**This is a supplier-selection problem, not a logistics problem.** The business decision is *which supplier to buy from*, based on price, quantity, and promised delivery date. It is not concerned with **how** that supplier gets the goods there — trucks, routes, carriers, and warehouses are the supplier's problem, not the buyer's. LogisticsNerd, in this revised scope, operates entirely at the business-decision layer: request → quotes → feasibility check → recommendation. It does not model or optimize anyone's transportation operations.

---

## 2. Target user and example scenario

**Target user:** a small business owner or office manager with no dedicated procurement staff, sourcing standard goods from a handful of known or easily-found suppliers.

**Example (illustrative, not real data):** A 12-person co-working space is opening a second location and needs:

| Item | Quantity | Required by |
|---|---|---|
| Office chairs | 50 | Oct 15, 2026 |
| Reams of printer paper | 200 | Oct 10, 2026 |
| Monitor stands | 30 | Oct 20, 2026 |

The manager sends an RFQ for each item to 3–5 suppliers she already knows, gets back price and delivery promises, and wants the system to tell her, per item, who to buy from and why.

---

## 3. Smallest end-to-end workflow

1. Buyer creates a request (item, quantity, deadline, optional budget).
2. Buyer selects 3–5 suppliers to send it to.
3. Suppliers submit quotes (availability, price, expected delivery date).
4. System validates each quote against quantity and deadline.
5. System compares the quotes that pass validation.
6. System recommends the cheapest feasible supplier, with a stated reason.
7. Buyer reviews the recommendation and the reasoning behind it (and behind any rejections).

---

## 4. Minimum information required

**Request:** item name, quantity, required delivery date, optional maximum budget.

**Supplier quote:** supplier name, available quantity, unit or total price, expected delivery date, optional notes.

**Derived result (computed, not entered):** feasible / infeasible, total cost, reason for rejection (if any), recommendation reason.

That's it for v1 — no specs, certifications, payment terms, or negotiation history.

---

## 5. Decision logic

All rules are deterministic — no optimization solver, no learned scoring:

1. Reject a quote if available quantity < requested quantity.
2. Reject a quote if expected delivery date is after the required date.
3. Reject a quote if total cost exceeds a stated maximum budget (when one is given).
4. Among quotes that survive 1–3, recommend the lowest total cost.
5. Tie-break: if two feasible quotes have equal cost, prefer the earlier delivery date.
6. If no quote survives, say why (e.g., "no supplier can deliver 200 reams by Oct 10 — cheapest late option was Supplier B at Oct 12") and prompt the buyer to relax quantity, deadline, supplier set, or budget.

No multi-criteria weighting, no split-order logic, no substitute-item reasoning in v1 — see Section 12 for whether that should change.

---

## 6. Minimal data model

| Entity | Key fields |
|---|---|
| **Buyer** | id, name, business_name |
| **ProcurementRequest** | id, buyer_id, created_at, max_budget (optional) |
| **RequestedItem** | request_id, item_name, quantity, required_delivery_date |
| **Supplier** | id, name, contact_info |
| **SupplierQuote** | id, request_id, supplier_id, submitted_at, notes (optional) |
| **QuoteItem** | quote_id, item_name, available_quantity, unit_price or total_price, expected_delivery_date |

`ProcurementRequest` can hold multiple `RequestedItem`s (matching Section 2's 3-item scenario); each `SupplierQuote` can hold multiple `QuoteItem`s. Feasibility and recommendation are computed, not stored as separate entities, in v1.

---

## 7. Sample input and output

To keep the example compact, this demo covers one item from the Section 2 scenario — **office chairs, qty 50, required by 2026-10-15** — with three supplier quotes. All values are fabricated for illustration.

```json
{
  "request": {
    "item_name": "Office chairs",
    "quantity": 50,
    "required_delivery_date": "2026-10-15",
    "max_budget": 6000
  },
  "quotes": [
    {
      "supplier_name": "Supplier A — Metro Office Supply",
      "available_quantity": 50,
      "total_price": 4500,
      "expected_delivery_date": "2026-10-12"
    },
    {
      "supplier_name": "Supplier B — Comfort Seating Co.",
      "available_quantity": 50,
      "total_price": 5200,
      "expected_delivery_date": "2026-10-10"
    },
    {
      "supplier_name": "Supplier C — Budget Furnish LLC",
      "available_quantity": 35,
      "total_price": 3800,
      "expected_delivery_date": "2026-10-14"
    }
  ]
}
```

**Expected comparison output:**

| Supplier | Feasible? | Total cost | Reason |
|---|---|---|---|
| A — Metro Office Supply | ✅ Feasible, **recommended** | $4,500 | Meets quantity and deadline; cheapest among feasible quotes |
| B — Comfort Seating Co. | ✅ Feasible | $5,200 | Meets quantity and deadline, but $700 more than Supplier A |
| C — Budget Furnish LLC | ❌ Rejected | $3,800 | Available quantity (35) is below the requested quantity (50) — cheapest overall, but infeasible |

This is the exact behavior Section 5's rules produce: C is the cheapest raw quote but is correctly excluded, and A wins over B on price with both feasible.

---

## 8. Minimal prototype architecture

**Proposed, not built:**
- A basic web form for the buyer to create a request.
- A simple form (or, for the first demo, a **mocked** response flow) for suppliers to submit quotes.
- A small relational database or even a static JSON file as the store for the first demo.
- A deterministic comparison function implementing Section 5's rules.
- A results page showing feasible quotes, rejected quotes (with reasons), and the recommendation.

**If an LLM is used**, its role is limited to: (a) turning a free-text request ("I need 50 chairs by mid-October") into the structured fields in Section 4, and (b) turning the deterministic function's output into a plain-language explanation. It must not invent a price, availability figure, delivery date, or supplier ranking — those come only from the deterministic layer.

---

## 9. Existing-product and literature check

*Focused, limited review — not a broad procurement-software survey.*

**Products (what I read: documentation/listing pages, not hands-on testing):**

| Product | What it does | How LogisticsNerd differs |
|---|---|---|
| [AuraVMS](https://www.getapp.com/all-software/rfp/page-4/) | RFQ tool aimed specifically at small businesses: automates quote requests, collects and compares supplier responses | Closest match in target user; among the products reviewed, its public listing doesn't describe automatic quantity/deadline feasibility rejection with a stated reason — comparison appears to be manual/side-by-side |
| [Cotiss](https://www.capterra.ca/software/1041861/cotiss) | End-to-end procurement software for small-to-medium procurement *teams*, supports RFQs and multi-stage RFPs | Broader team/workflow tool; LogisticsNerd targets a single buyer with no procurement staff and a much smaller feature surface |
| [OpenRFQ](https://apps.apple.com/app/id1641606984) | Mobile-first RFQ app for small businesses without enterprise procurement systems; create RFQ, compare quotes, negotiate | Similar target user and simplicity goal; adds negotiation and supplier-discovery features LogisticsNerd deliberately omits in v1 |
| [RFQmatch.com](https://www.getapp.com/operations-management-software/rfp/p/open-source/?page=4) | AI platform combining supplier discovery, RFQ management, and quote comparison | Broader scope (discovery + sourcing automation); among the products reviewed, none described a simple deterministic "reject infeasible, recommend cheapest feasible" rule set as the core mechanism — comparison is framed as AI-assisted sourcing, not a transparent rule-based decision |

**Academic/industry sources (all read at abstract or documentation level, not full text):**

- Waikar, Huynh, Cope & Tate (2011), *"Evaluating key factors in supplier selection for micro-businesses,"* *IJISM* — explicitly notes supplier selection has been studied for large firms but not very small ones, and warns against choosing on lowest price alone. [Abstract](https://inderscience.com/filter.php?aid=44890)
- Imeri (2015), *"Evaluation and selection process of suppliers through analytical framework,"* *Management and Production Engineering Review* — SME survey (Greece) finding delivery time, price, and quality as top supplier-evaluation criteria, via PCA. [PDF](https://czasopisma.pan.pl//Content/89631/PDF/2-imeri.pdf)
- *International Journal of Technology* (2022), Delphi + AHP hybrid for SME supplier selection — price weighted highest (43.8%) among criteria including delivery time, in a small-business context. [Abstract](https://ijtech.eng.ui.ac.id/download/article/4700)
- Racklify, *"RFQ Tool (Request for Quotation Software)"* encyclopedia entry — industry description of the standard RFQ workflow (create → invite → submit → compare → award) LogisticsNerd's Section 3 workflow mirrors at small scale. [Page](https://racklify.com/encyclopedia/rfq-tool-request-for-quotation-software/)

**Where this project differs, stated carefully:** among the products and sources reviewed, I did not find one that pairs (a) a target user with *no* procurement staff, (b) a fully deterministic, explained accept/reject rule set, and (c) a scope deliberately limited to price-and-deadline feasibility rather than broader sourcing, negotiation, or discovery. That combination — small, transparent, and narrow — looks like the actual contribution, not any single feature.

---

## 10. Explicitly out of scope

Transportation route planning · truck and vehicle scheduling · warehouse optimization · shipment execution and tracking · multimodal route generation · live logistics integrations (traffic, carrier APIs, weather) · inventory optimization · large-enterprise procurement complexity (approval chains, contracts, multi-stage RFPs) · multi-tenant production infrastructure.

---

## 11. Demo plan and success criteria

**3–5 minute demo:** enter one request (item, quantity, deadline) → show three pre-loaded/mocked supplier quotes → system flags one as infeasible with a stated reason → system compares the remaining two → system recommends the cheaper feasible one with a one-line explanation.

**Success criteria:** the full request→quotes→filter→compare→recommend flow runs end to end, and every accepted or rejected quote has a correct, specific, stated reason (not a generic "infeasible").

---

## 12. Questions for Prof. Shasha

1. Is supplier selection based on price and delivery deadline the correct interpretation of the revised scope, or is he expecting other criteria (quality, reliability) even at this small scale?
2. Should suppliers submit quotes manually in the first prototype, or is a mocked quote set sufficient for the first demo?
3. Is a deterministic comparison function sufficient, or does he expect a more substantial optimization or research contribution somewhere in this pipeline?
4. Should one supplier be required to satisfy the entire request, or should the system be allowed to split an order across multiple suppliers to hit quantity or cost goals?
5. What would make this academically interesting — e.g., the MCDM angle from Section 9, or something else — without pulling the scope back toward detailed logistics?
