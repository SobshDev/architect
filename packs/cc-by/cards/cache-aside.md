---
id: cache-aside
kind: pattern
title: Cache-aside
summary: The application checks a cache first, loads from the data store on a miss, and fills the cache itself.
problem: >-
  Reading the same data from a database again and again adds latency and load. A cache helps,
  but the application must decide what to cache and how to keep it fresh.
forces:
  - Most reads target a small, popular subset of the data.
  - Cached data goes stale when the store changes.
  - A cache node can fail or restart empty at any time.
  - The cache should hold only data that is actually read.
use_when:
  - Reads far outnumber writes and the data tolerates short staleness.
  - The cache product has no built-in read-through or write-through support.
  - Load on the data store must drop.
avoid_when:
  - Data must always be current, and a stale read is a bug.
  - Access is so evenly spread that few reads hit the cache.
  - The whole dataset fits in memory and can be loaded up front.
tradeoffs:
  - Only requested data is cached, so memory is not spent on data nobody reads.
  - Each miss costs three trips, to the cache, the store, and the cache again.
  - Entries can be stale until they expire or are invalidated on write.
  - A new or restarted cache node starts empty and raises latency until it warms.
code_signals:
  - rule-kind:state-owner
  - Read functions that call cache get, fall back to a query, then call cache set.
  - Time-to-live values on cache writes.
  - Cache deletes in the same code paths that update the store.
contract_templates:
  - |
    id: cache-single-owner
    kind: state-owner
    level: warn
    description: Only the repository that reads the table writes or invalidates its cache keys.
    resources: [user-cache]
related:
  - cqrs
  - single-state-owner
  - shared-mutable-state
  - ports-and-adapters
sources:
  - title: "System Design Primer: Cache-aside (Donne Martin)"
    url: https://github.com/donnemartin/system-design-primer#cache-aside
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: adapted
    changes: >-
      Reworded the steps, benefits, and disadvantages into card fields and sections; rewrote the
      Python example to set a time-to-live and to invalidate on write; added forces, use and avoid
      lists, the consequences discussion, and the In Architect section. The figure was omitted.
  - title: "Azure Architecture Center: Cache-Aside pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

A service reads user profiles on almost every request. The profiles change rarely, yet each read is a database query. The database is busy with work that returns the same answer many times.

## Solution

The application manages the cache itself. The cache never talks to the database. On a read, the application:

1. Looks up the key in the cache.
2. On a miss, loads the entry from the database.
3. Stores the entry in the cache with a time-to-live.
4. Returns the entry.

On a write, it updates the database and then deletes the cache key, so the next read loads fresh data.

~~~python
def get_user(user_id):
    key = f"user.{user_id}"
    cached = cache.get(key)
    if cached is not None:
        return json.loads(cached)
    user = db.query("SELECT * FROM users WHERE user_id = %s", (user_id,))
    if user is not None:
        cache.set(key, json.dumps(user), ttl=300)
    return user

def update_user(user_id, fields):
    db.update_user(user_id, fields)
    cache.delete(f"user.{user_id}")
~~~

Memcached and Redis are often used this way. The pattern is also called lazy loading.

## Consequences

Repeat reads become fast, and only requested data takes cache memory. A miss costs three round trips, so cold keys are slower than without a cache. Data can go stale when the database changes through a path that does not invalidate the key; a time-to-live bounds how long. When a cache node fails, its replacement starts empty and latency rises until it fills.

## In Architect

Keep cache reads, writes, and invalidation in the same component that owns the underlying table, usually its repository or adapter. Declare the cache as a resource and use a state-owner rule so no other component writes its keys; a second writer is the usual source of stale entries. Record the time-to-live and invalidation policy in a decision.
