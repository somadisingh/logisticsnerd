# Shipping comparison configuration isolation

`createComparisonRunner` keeps provider responses for ten minutes and suppresses
further requests after an access-denied or rate-limited result. Both caches are
now scoped to a configuration epoch: the exact set of activation flags and
credentials observed at the beginning of a comparison.

If configuration changes while an old comparison is in flight, a late response
can still finish for its original caller. It cannot block providers in the new
epoch or remove the new epoch's cached response. Changing A to B and back to A
creates a third epoch, not a return to the original in-flight state.

Each comparison snapshots the four supported environment fields before its first await. Explicit property reads preserve the middleware's get-only Proxy, which has no enumerable keys. Sequential
provider calls in that comparison therefore use one consistent configuration.
This does not revoke or cancel an already-started comparison or send a new
request automatically. The next user-requested comparison reads the new config.
No credentials are added to responses or logs.

Within one unchanged epoch, same-parcel calls still share the pending request.
Access-denied and rate-limited responses still suppress further provider calls.
An old trace-free transport failure cannot evict a newer pending/cached entry
for the same parcel after TTL replacement.

## Offline qualification

Run `npx vitest run tests/shipping-config-epochs.test.mjs`. The tests use fake
HTTP responses and controlled promise ordering, not carrier accounts, wall-clock
sleeps, or provider charges. They cover old 403/429 responses, transport failures,
key and activation changes, delayed sequential providers, A-B-A rotation,
unchanged-config coalescing/denial behavior, and same-epoch TTL replacement.

This is a local dev/preview runner correction, not hosted key rotation or a new
production access-control boundary. It does not include the separate pending
prediction-date fixes or establish carrier accuracy or availability.

The additional `tests/shipping-middleware-config.test.mjs` suite sends actual
local HTTP requests through the production middleware, including its get-only
Proxy. Provider fetches remain fake. This tests credential/activation updates,
missing credentials, cache reuse and denial suppression at the actual adapter
boundary.
