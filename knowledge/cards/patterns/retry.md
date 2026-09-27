---
id: retry
kind: pattern
title: Retry with backoff
summary: Repeat a failed call to a remote dependency after a growing, randomized delay, a bounded number of times.
problem: >-
  Calls to networks, databases, and other services fail for short periods. Failing the whole
  operation on the first transient error wastes work, but retrying blindly can multiply load on a
  dependency that is already struggling.
forces:
  - Most transient faults clear within seconds.
  - Every retry adds load at the moment the dependency is weakest.
  - Callers at several layers may each retry, so attempts multiply.
  - Only safe operations can be repeated without side effects.
use_when:
  - The failure is likely transient, such as a timeout, a dropped connection, or a throttling response.
  - The operation is idempotent or carries an idempotency key.
  - The caller can afford the extra latency of a few attempts.
avoid_when:
  - The error is permanent, such as a validation failure or a missing permission.
  - The dependency is known to be down; a circuit breaker should fail fast instead.
  - A lower layer, such as the client library, already retries.
tradeoffs:
  - Higher success rate for transient faults, at the cost of tail latency.
  - Retries without jitter synchronize clients and create load spikes.
  - Retry budgets and attempt limits need tuning per dependency.
code_signals:
  - Loops or wrappers around network calls that catch errors and call again.
  - Sleep or delay calls with exponential growth and a random component.
  - Retry settings in HTTP, database, or queue client configuration.
  - Several nested layers that each wrap the same call in a retry.
contract_templates: []
related:
  - circuit-breaker
  - idempotency-key
  - bulkhead
  - queue-based-load-leveling
sources:
  - title: "Timeouts, retries, and backoff with jitter (Amazon Builders' Library)"
    url: https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Release It! Design and Deploy Production-Ready Software, 2nd edition (Michael Nygard)"
    url: https://pragprog.com/titles/mnee2/release-it-second-edition/
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Azure Architecture Center: Retry pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/retry
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

A service calls something it does not control. Most failures are brief: a connection resets, a leader election runs, a rate limit resets a second later. If the caller gives up at once, users see errors that a second attempt would have avoided.

## Solution

Classify errors first. Retry only transient ones, and only for operations that are safe to repeat. Wait between attempts, grow the wait exponentially, add random jitter so clients spread out, and stop after a small number of attempts or when a deadline passes.

~~~ts
async function withRetry<T>(call: () => Promise<T>, attempts = 4, baseMs = 100): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (err) {
      if (i + 1 >= attempts || !isTransient(err)) throw err;
      const cap = baseMs * 2 ** i;
      await Bun.sleep(Math.random() * cap); // full jitter
    }
  }
}
~~~

Retry in one layer only, usually the one closest to the remote call. Upper layers should see a single result.

## Consequences

Transient faults stop reaching users. The price is latency on failing requests and extra load on the dependency. Without an overall limit, retries can turn a small outage into an overload. Pair retries with a circuit breaker so that a dependency that is fully down gets a rest instead of more traffic.

## In Architect

Put retry policy in the adapter that owns the remote client, so that one component decides how a dependency is retried. Record the attempt limits and which errors count as transient in a decision, because other code relies on those semantics. If several components wrap the same client with their own loops, treat that as scattered functionality and move the policy into the adapter.
