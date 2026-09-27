---
id: bulkhead
kind: pattern
title: Bulkhead
summary: Split resources such as threads, connections, and queues into isolated pools so that one overloaded part cannot exhaust capacity for the rest.
problem: >-
  When all work shares one pool of resources, a single slow dependency or noisy client can
  consume every thread or connection and take down unrelated features.
forces:
  - Shared pools use capacity efficiently.
  - Isolated pools protect some work at the cost of idle capacity elsewhere.
  - Choosing partitions requires knowing which work matters most.
use_when:
  - Some workloads are more critical than others and must survive overload in the rest.
  - Several dependencies have different failure modes or latencies.
  - Tenants or clients can generate very uneven load.
avoid_when:
  - The system is small and load is steady, so partitioning only wastes capacity.
  - All work shares the same dependency, so isolating pools does not isolate failures.
tradeoffs:
  - Limits the blast radius of overload and failure.
  - Lowers peak throughput because pools cannot borrow from each other.
  - Adds configuration that must track real traffic.
code_signals:
  - rule-kind:independent
  - Separate connection pools, thread pools, or semaphores per dependency or per tenant.
  - Concurrency limits configured per route or per worker queue.
  - Separate deployments or processes for critical and best-effort work.
contract_templates:
  - |
    id: critical-and-batch-independent
    kind: independent
    level: warn
    description: Critical request handling and batch work share no code paths.
    members: [checkout, reporting]
related:
  - circuit-breaker
  - queue-based-load-leveling
  - retry
  - modular-monolith
sources:
  - title: "Release It! Design and Deploy Production-Ready Software, 2nd edition (Michael Nygard)"
    url: https://pragprog.com/titles/mnee2/release-it-second-edition/
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Azure Architecture Center: Bulkhead pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

A service handles checkout and also generates reports. Both use the same database pool. One day a report query runs slowly, holds every connection, and checkout stops working. The report was not important; checkout was.

## Solution

Partition resources by the failures you want to contain. Give each dependency, tenant class, or workload its own pool with its own limit. When a pool is full, its callers wait or fail, and other pools continue.

~~~ts
const checkoutSlots = new Semaphore(40);
const reportSlots = new Semaphore(5);

export async function runReport(q: Query) {
  return reportSlots.run(() => db.query(q)); // at most 5 at once
}
~~~

Partitions can live at many levels: a semaphore in code, a separate connection pool, a separate worker queue, or a separate deployment.

## Consequences

Overload in one area stays in that area. Critical paths keep capacity reserved. In exchange, total capacity is split, so some pools sit idle while others queue. The limits need monitoring and adjusting as traffic changes.

## In Architect

Code level partitions are easier to keep when the workloads are separate components. An independent rule keeps those components from importing each other, so that a change for one does not quietly bring the other's code path, and its resources, along. Record which workloads are isolated and why in a decision, including the limits, so that later tuning keeps the intent.
