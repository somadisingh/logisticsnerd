# Inventory risk workspace

`/inventory.html` adds the browser workflow for the existing owner-only
`/api/purchasing/lot-risks` API. Choose a review date, 0..366-day inclusive horizon,
item and location. Held lots override expired and soon-expiring categories;
a lot-level hold applies across locations. Expiration today is not past expiry.
Only positive current lot balances appear. Quantities are current, never an
historical inventory reconstruction. Allocated units remain part of on-hand
stock, not additional units. Held/expired lots have zero usable available stock.

All requests are reads. No stock commands, hold release, purchase approval,
migration, carrier call or model call is performed. Failed refreshes hide old
quantities rather than leaving them looking current. The production build
includes the page and all workspaces link to it.

This retains the current loopback proxy/owner-development authentication. It does
not solve production actor/business routing or grant access to a hosted account.
Production deployment requires the existing owners' agreed host/auth adapter.

Run `python scripts/verify_inventory_browser.py` with development requirements,
Playwright Chromium and `npm ci` installed. It creates only a disposable local
PostgreSQL database, starts the API on8001/Viteon5173 and uses synthetic stock.
Screenshots go to ignored `.browser-evidence/`. Do not run alongside other servers
on those ports. `BROWSER_EVIDENCE_DIR` overrides the screenshot directory.
