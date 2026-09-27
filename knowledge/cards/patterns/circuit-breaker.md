---
id: circuit-breaker
kind: pattern
title: Circuit breaker
summary: Stop calling a failing dependency for a while, fail fast instead, and probe it before resuming normal traffic.
problem: >-
  When a dependency hangs or fails, callers keep waiting on it. Threads and connections pile up,
  the caller slows down or crashes, and the failure spreads up the call chain.
forces:
  - A slow failure costs more than a fast one because it holds resources.
  - The dependency needs relief from traffic to recover.
  - Callers need a clear signal to use a fallback.
  - Thresholds set too low trip on noise; too high and they trip too late.
use_when:
  - A remote dependency can fail or slow down independently of the caller.
  - The caller has a useful fallback, such as cached data, a default, or a clear error.
  - Failures are frequent enough that repeated timeouts would exhaust resources.
avoid_when:
  - The resource is local and in process, where an exception is already fast.
  - Every request must reach the dependency, and failing fast has no better outcome than waiting.
tradeoffs:
  - Protects the caller and the dependency, but rejects some requests that would have succeeded.
  - Adds state per dependency that must be observed and tuned.
  - Breaker state is per process, so a fleet may disagree about the dependency's health.
code_signals:
  - Wrappers with closed, open, and half-open states around remote calls.
  - Failure counters or error-rate windows keyed by dependency.
  - Fallback branches that run when a call is rejected without being attempted.
contract_templates: []
related:
  - retry
  - bulkhead
  - anti-corruption-layer
  - ports-and-adapters
sources:
  - title: "CircuitBreaker (Martin Fowler)"
    url: https://martinfowler.com/bliki/CircuitBreaker.html
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Release It! Design and Deploy Production-Ready Software, 2nd edition (Michael Nygard)"
    url: https://pragprog.com/titles/mnee2/release-it-second-edition/
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Azure Architecture Center: Circuit Breaker pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

A dependency starts timing out. Each request to it waits the full timeout, holds a thread or connection, and then fails. Soon the caller has no free capacity for work that does not even need the dependency.

## Solution

Wrap calls to the dependency in a small state machine. While closed, calls pass through and failures are counted. When failures cross a threshold, the breaker opens: calls fail at once without touching the dependency. After a cool-down, the breaker goes half-open and lets a few trial calls through. Success closes it; failure opens it again.

~~~ts
class Breaker {
  private failures = 0;
  private openedAt = 0;
  constructor(private threshold: number, private coolDownMs: number) {}
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const open = this.failures >= this.threshold;
    if (open && Date.now() - this.openedAt < this.coolDownMs) throw new Error("circuit open");
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.threshold) this.openedAt = Date.now();
      throw err;
    }
  }
}
~~~

Report state changes to monitoring. An open breaker is an operational event.

## Consequences

Failures become fast and visible, and the caller keeps capacity for other work. The dependency gets time to recover. Callers must handle the rejection, so each call site needs a fallback or a clear error. Thresholds and cool-downs need tuning against real traffic.

## In Architect

Keep breakers inside the adapter component that owns the remote client, next to retries and timeouts. Other components should call the adapter through its entrypoint and never create their own clients. An external-imports rule that confines the client package to the adapter keeps that true. Record the fallback behavior in a decision, since callers depend on it.
