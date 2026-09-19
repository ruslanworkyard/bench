Add an in-process cache with time-to-live and a size limit, and apply it to one existing read
path that would benefit from it.

The cache:

- Stores values by key with a per-entry TTL (default supplied at construction, overridable per
  entry). Expired entries are treated as absent.
- Has a maximum number of entries; when full, evicts the least recently used entry.
- Offers get, set, delete, and a get-or-compute operation that runs a supplied function on a
  miss and stores the result. Concurrent callers for the same key should not all recompute if
  the project has a concurrency model where that matters.
- Exposes hit and miss counts so it can be observed.

Then find one read in this codebase that is called repeatedly with the same inputs and is
comparatively expensive (a lookup against storage, an external call, a heavy computation) and
route it through the cache with a sensible TTL. Explain the choice in the code where the cache
is applied, briefly.

Write tests in the project's existing style covering expiry, eviction order, get-or-compute on
hit and miss, and the observability counters. Tests must not rely on real time passing; make
time injectable.

Do not add dependencies. Do not change the behaviour of the read you cache, other than caching.
