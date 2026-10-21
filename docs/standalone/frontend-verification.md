# Browser demo verification

Executed 21 October 2026 on branch `feature/standalone-workflow-rules`. The browser uses the existing main-branch frontend styling and the real standalone Python rules through a local fixture process. This verifies the disposable demo, not persistent OperationsNerd integration.

| Check | Actual result |
| --- | --- |
| `python3 -m unittest discover -s tests_python -v` | **70 tests passed**, exit 0. Includes standalone invariants plus demo session, replay, quote-preview consistency and stale-comparison protection. |
| `npm test` | **273 tests passed in 9 files**, exit 0. Includes the 242 existing tests, 22 transport/actual Python worker checks and 9 browser-client checks. |
| `npm run build` | TypeScript and Vite build passed, exit 0. Builds the workflow homepage, preserved supplier comparison and shipping lab. |
| Browser smoke | **29 checks passed** in headless Edge 155 at desktop and 390px mobile widths. Full workflow, exact displayed state, replay/isolation, reset and preserved comparison sample all exercised through visible controls. |
| Focused browser review | Stale-tab comparison rejection preserves approved POs and the $11.80 plan. Mobile disclosure/spacing and visible early-fulfillment feedback checked after fixes. |

Raw automated outputs: [Python](results/browser-demo-python-tests.txt), [JavaScript/build](results/browser-demo-tests-build.txt). Browser check summaries are in [browser-demo-browser-checks.json](results/browser-demo-browser-checks.json). Browser scripts and screenshots are local QA artifacts in the ignored `.local-planning/workflow/` folder; they are not runtime dependencies.

The browser checks verified 4 reserved customer units and shortage 11; no PO before explicit approval; approval leaves stock 6; receipts raise stock to 13 then 17; first-receipt fulfillment is rejected; final fulfillment leaves stock/reservations at 2/2; replay and cross-company attempts leave balances unchanged. Desktop and mobile had no page errors, console errors, external/model requests or horizontal overflow. The preserved supplier-comparison page still loads its prepared sample and recommends a supplier.

The local browser bridge fixes its clock and supplier terms for reproducibility. It uses fake company/owner identities and one shared in-memory session. No live supplier, accounting, database, persistent adapter or core authentication was tested. The OperationsNerd checkout and its pre-existing uncommitted documentation remain untouched.

Vite still prints the existing forward-compatibility notices for JSON import attributes and extensionless imports. Tests and builds succeed; unrelated comparison/cache code was not refactored.

Commits are authored and committed as `somadisingh <somadisingh13@gmail.com>`, without co-author trailers. Changes are pushed in separate rules, review-documentation, local-demo-transport and frontend commits on the feature branch; `main` is unchanged.
