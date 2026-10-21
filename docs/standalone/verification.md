# Executed verification and baseline

This records the first standalone review, before the later authorized local browser demo. For current frontend files, tests and scope, see [frontend-demo.md](frontend-demo.md). The earlier test outputs below remain preserved.

Executed 21 October 2026. These results establish the standalone in-memory implementation and existing demo regressions only. They do not establish persistent end-to-end integration, deployed authentication, database isolation or database concurrency safety.

## Repository baseline and preservation

The supplied working path `/Users/somaditya/logisticsnerd` did not exist. The actual repositories were verified under `/Users/somaditya/Logistics Nerd/`.

| Repository | Baseline / branch / remote | Action and final state |
| --- | --- | --- |
| LogisticsNerd | HEAD `b0619280fe423132accf460da914b720713787c0`, originally clean `main`; origin `https://github.com/somadisingh/logisticsnerd.git` | Created local branch `feature/standalone-workflow-rules` before implementation. HEAD remains the baseline commit; changes are uncommitted. No push, merge, reset or pull. |
| OperationsNerd | HEAD `622d8d7b47378c3e427212859d90a52eccfeb040`, `main`; origin `https://github.com/AmaanIlahi/OperationsNerd.git`; pre-existing untracked `documentation/logisticsnerd/` | Fetched latest origin refs successfully; inspected upstream with `git show`/`git ls-tree`. No checkout file changed. No dirty-tree pull/merge. `origin/main` is `dbff470c96f6d82e9752d18638c42b20a4ca7d21`, 29 commits ahead. |

PR #14 merge `dbff470` and PR #15 merge `5346d28` are both ancestors of fetched OperationsNerd `origin/main`. Neither is an ancestor of local OperationsNerd HEAD. The fetched `/app`/`/api` conventions are future integration targets, not functionality installed into the local checkout by this task. Raw git commands and ancestor outcomes are in [operations-baseline.txt](results/operations-baseline.txt).

Original OperationsNerd diagram SHA-256 before and after:

```text
5fde52920cad1cfe0783bc4f3df84727cf9375a7e6644223ae8970f57c960abd
```

The preserved `reference-original.drawio` is byte-identical. Original `starter-schema.sql` before/after SHA-256 is `5f35d4562ef08231bf273ec0c48cf19946565264cfb098b35935d1fd105617ea`. OperationsNerd still reports only its original untracked logistics documentation. No `.env` or credential file was read, printed or changed. No repository-local `AGENTS.md` was found in reviewed roots/ancestors.

## Commands and actual results

Runtime: Python 3.14.7, Node v26.10.0, npm 11.19.1. No dependencies were installed or upgraded.

| Command/check | Actual result |
| --- | --- |
| `python3 -m unittest discover -s tests_python -v` | **61 tests passed**, 0.046s, exit 0. [Full output](results/python-tests.txt). |
| `python3 -m logistics_rules.demo` | All scenario assertions passed, exit 0. [Actual stdout](results/demo-output.txt). |
| `npm test` | Existing **242 tests passed across 7 files**, exit 0. [Output](results/demo-regression.txt). |
| `npm run build` | TypeScript checking and Vite production build passed, exit 0; 17 modules transformed. [Output](results/demo-regression.txt). |
| Revised Draw.io XML parse / reference checks | Valid XML: 10 table cards, 14 relationships; all source/target/parent cell references resolve. Original copy matches byte-for-byte. Diagram visual rendering was not exercised in Draw.io. |
| `git diff --check` | Exit 0 for tracked changes. |

Vite emits existing forward-compatibility notices about JSON import attributes and extensionless TypeScript imports when the future native config loader becomes default. Tests/build succeed; no unrelated source refactor was performed.

The Python suite exercises multi-item and duplicate normalization, insufficient/competing reservations, repeated shortage views, assigned inbound coverage, explicit owner approval, split suppliers, cumulative purchase budget, quote validity/deadline/currency/pricing, frozen terms, full receipt, whole-order completion, same/different-key retries, different-company links/actions, invalid lifecycle actions, and late-failure rollback. Threaded tests establish only the in-memory adapter's process-local serialization. Selection also checks the existing sample JSON and independently exhaustively enumerates small purchase baskets to check exact minimum cost.

OperationsNerd application tests, a real Redis instance, live supplier/model services and browser walkthroughs were not executed for this task. Some upstream core test scripts reset default databases; no such scripts were run against the user's checkout. Existing JavaScript tests use simulated contracts and cache adapters.

## Actual demo result

| Action | On-hand | Active reservations | Customer status |
| --- | ---: | ---: | --- |
| Other order reserves 2 | 6 | 2 | Customer order not yet created |
| Demand 15 reserves available 4 | 6 | 6 | Open; original shortage 11 |
| Explicit approval of X=7 and Y=4, combined 1180 cents USD <= 2000 budget | 6 | 6 | Open; assigned inbound 11; remaining unallocated purchase shortage 0 |
| Receive X=7 | 13 | 13 | Open; fulfillment rejected; Y remains unreceived |
| Receive Y=4 | 17 | 17 | Ready |
| Fulfill all 15 | 2 | 2 | Fulfilled; the other order still owns its 2 reserved units |
| Replay receipt/fulfillment and reject duplicate events under other keys | 2 | 2 | Unchanged |
| Reject Company B reads, receipt and fulfillment on A's records | 2 | 2 | Unchanged |

## Changed files

Only LogisticsNerd has implementation/documentation changes:

- `README.md`: current direction and standalone commands.
- `logistics_rules/__init__.py`, `repository.py`, `workflow.py`, `selection.py`, `demo.py`, `.gitignore`.
- `tests_python/test_workflow.py`, `test_selection.py`, `.gitignore`.
- `docs/standalone/README.md`, `core-mapping.md`, `core-migration-dependencies.md`, `integration-plan.md`, `schema-proposal.md`, `verification.md`.
- `docs/standalone/shared-proposal.drawio`, `reference-original.drawio`.
- `docs/standalone/results/python-tests.txt`, `demo-output.txt`, `demo-regression.txt`, `operations-baseline.txt`.

No existing `src/`, `server/`, `tests/`, package manifests or lockfiles changed. Build output is ignored. No OperationsNerd application/schema/UI files changed.

## Completed, simulated and unverified

Implemented and executed: generic Python rules, immutable purchase terms, small repository port, fake transactional/replay adapter, deterministic split selection, synthetic demo and automated checks.

Simulated: company/item/party/owner identities, inventory state, supplier availability/price/delivery, authentication authority. In-memory company scoping is rule behavior, not real user authentication. Source labels remain estimates in approved demo terms.

Unimplemented/unverified: authoritative item/stock and party mapping, persistent repository, durable transaction/replay behavior, database company constraints, real core auth, `/api` actions and `/app` controls, live purchases and accounting. Shared items/parties/accounting and the module interface are planned upstream, not invented here. Redis remains an estimate cache.

The [integration plan](integration-plan.md) contains questions for Amaan/Shasha. The smallest next step is explicit review and approval of item/stock mapping, company isolation, module interface and split-sourcing scope. Accounting ownership/interface remains unresolved. Stop before shared-schema changes and application integration until that approval is supplied.
