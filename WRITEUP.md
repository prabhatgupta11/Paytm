# Seat Reservation at Scale - Writeup

## The Atomic Decision
The core requirement is to handle highly concurrent requests to reserve seats without double-selling, and with exactly-once idempotency. 

The atomic decision is implemented using a **single PostgreSQL transaction with row-level locking**:
1. **Idempotency Guard**: We insert the `idempotency_key` into an `idempotency_keys` table with an `ON CONFLICT DO NOTHING` clause. If it exists, we check if the request body hashes match (rejecting with 409 if they don't, or returning the previous result if it was already processed).
2. **User Limit Check**: We run a `COUNT(*)` query for the user's currently confirmed seats for the show. If `count + new_seats > limit`, we abort the transaction.
3. **Pessimistic Locking for Seats**: To prevent race conditions, we issue a `SELECT ... FOR UPDATE` on the requested seats. 
   - **Crucial step to prevent deadlock**: The seats are strictly sorted lexicographically before the query. This ensures that concurrent transactions locking intersecting sets of seats will acquire the locks in the exact same order, completely eliminating the possibility of deadlocks.
4. **State Verification**: If any seat isn't 'available', we rollback and return 409.
5. **Commit**: Update the seats, insert the reservation, update the idempotency result, and commit.

This mechanism pushes the decision into the database's locking engine. Because of `FOR UPDATE`, the second concurrent request for the same seat blocks until the first finishes. Once the first finishes (updating the seat to 'confirmed'), the second request reads the updated row, sees it's no longer 'available', and cleanly declines with a 409. No 500s are produced under contention.

## Idempotency
- **Storage**: Keys are stored in the `idempotency_keys` table.
- **Enforcement**: Using PostgreSQL's `UNIQUE` constraint on the key, we ensure that a key can only be inserted once. 
- **Conflict Handling**: When a conflict occurs during insertion, we fetch the existing record. The `request_body_hash` is compared against the incoming request's hash. If they differ, a 409 is returned. 
- **Retry Handling**: If the hash matches, we return the stored `response_status` and `response_body` which were saved atomically with the successful (or rejected) transaction.

## Holds & Expiry
I implemented explicit release of a hold/reservation via `POST /reservations/{id}/cancel`. 
Under this model, "reserve" instantly transitions the seat to 'confirmed'. If a user cancels, the seat transitions back to 'available'. 
For a production system, we could easily add auto-expiry by recording an `expires_at` timestamp in the `reservations` table and running a periodic sweeper (or relying on a time-based index) to cancel un-paid reservations, but explicit cancellation satisfies the requirements cleanly.

## Consistency vs Availability under a Partition
The architecture prioritizes **Consistency (CP in CAP)**.
- If the database is partitioned or unreachable, the application fails closed. The `/readyz` probe immediately returns 503, dropping the node from the load balancer.
- We cannot safely issue tickets in a partitioned state (Availability) without risking double-sells. The single PostgreSQL database acts as the source of truth to guarantee the reconciliation invariant at all times.

## Observability
- **Metrics**: Exposed via `/metrics` using Prometheus format.
  - `reservations_confirmed_total` (Counter)
  - `reservations_declined_total` (Counter) with labels for reasons (`seat-taken`, `per-user-limit`, etc.)
  - `seats_available` (Gauge) by `show_id`
- **What I'd get paged for at 2am**: 
  - Elevated 5xx error rates.
  - Plunge in `seats_available` combined with zero `reservations_confirmed_total` (indicating a potential logic flaw or deadlock).
  - Database CPU/connections maxing out.
  - The `readyz` probe failing continuously.

## AI Usage
AI usage was directed to generate boilerplate scaffolding, write the Express router setup, structure the Prometheus metrics code, and generate the baseline burst testing script. The core transactional logic (the sequence of operations, the `FOR UPDATE` lock, deadlock avoidance through sorting) was explicitly decided and directed by me, as this requires precision that standard LLM boilerplate sometimes misses (e.g. failing to sort rows for `FOR UPDATE`).

## What I'd do next
1. **Connection Bouncer**: Use `PgBouncer` to handle thousands of incoming connections smoothly.
2. **Caching**: Cache `/shows/:id` heavily. The actual reservation must go to DB, but reading state can be slightly stale.
3. **Queueing**: If scale increases 100x (e.g., millions of requests), place requests into a Kafka queue and process sequentially per show to eliminate DB lock contention completely, though this changes the API to be strictly asynchronous.
