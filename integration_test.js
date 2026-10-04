const crypto = require('crypto');
const http = require('http');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';

async function makeRequest(method, path, body, headers = {}) {
  const url = `${BASE_URL}${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch(e) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function uuid() { return crypto.randomUUID(); }

async function runTests() {
  console.log("=== Running Comprehensive PRD Tests ===\n");

  // 1. Create a show
  console.log("1. Create a show — POST /shows");
  const showRes = await makeRequest('POST', '/shows', {
    name: "Test Concert",
    seats: ["A1", "A2", "A3", "B1", "B2"],
    price_paise: 25000
  });
  assert.strictEqual(showRes.status, 201);
  assert.strictEqual(showRes.body.total_seats, 5);
  const showId = showRes.body.id;
  console.log("✅ Show created successfully.\n");

  // 2. Reserve a seat
  console.log("2. Reserve a seat — POST /shows/{id}/reserve");
  const idempKey1 = uuid();
  const userId = 'user-123';
  const res1 = await makeRequest('POST', `/shows/${showId}/reserve`, 
    { seats: ["A1", "A2"], idempotency_key: idempKey1 }, 
    { 'x-user-id': userId }
  );
  assert.strictEqual(res1.status, 201);
  assert.strictEqual(res1.body.status, 'confirmed');
  const reservationId = res1.body.reservation_id;
  console.log("✅ Seat successfully reserved.\n");

  // Idempotency: exact same request
  console.log("2a. Idempotency (Exact Retry)");
  const resRetry = await makeRequest('POST', `/shows/${showId}/reserve`, 
    { seats: ["A1", "A2"], idempotency_key: idempKey1 }, 
    { 'x-user-id': userId }
  );
  assert.strictEqual(resRetry.status, 201);
  assert.strictEqual(resRetry.body.reservation_id, reservationId); // Same reservation
  console.log("✅ Retry returned the original reservation.\n");

  // Idempotency: conflict (same key, different seats)
  console.log("2b. Idempotency (Conflict)");
  const resConflict = await makeRequest('POST', `/shows/${showId}/reserve`, 
    { seats: ["A3"], idempotency_key: idempKey1 }, 
    { 'x-user-id': userId }
  );
  assert.strictEqual(resConflict.status, 409);
  console.log("✅ Conflicting idempotent request rejected (409).\n");

  // No double-sell
  console.log("2c. No double-sell");
  const resDouble = await makeRequest('POST', `/shows/${showId}/reserve`, 
    { seats: ["A1"], idempotency_key: uuid() }, 
    { 'x-user-id': 'user-456' }
  );
  assert.strictEqual(resDouble.status, 409);
  console.log("✅ Double-sell successfully rejected (409).\n");

  // Per-user limit
  console.log("2d. Per-user limit (Default 4)");
  const resLimit1 = await makeRequest('POST', `/shows/${showId}/reserve`, 
    { seats: ["A3", "B1"], idempotency_key: uuid() }, 
    { 'x-user-id': userId }
  );
  assert.strictEqual(resLimit1.status, 201); // User now has 4 seats (A1,A2,A3,B1)
  
  const resLimitFail = await makeRequest('POST', `/shows/${showId}/reserve`, 
    { seats: ["B2"], idempotency_key: uuid() }, 
    { 'x-user-id': userId }
  );
  assert.strictEqual(resLimitFail.status, 409); // Exceeds limit
  console.log("✅ Per-user limit enforced cleanly (409).\n");

  // Partial requests (all-or-nothing)
  console.log("2e. Partial requests (All-or-nothing)");
  const resPartial = await makeRequest('POST', `/shows/${showId}/reserve`, 
    { seats: ["B2", "A1"], idempotency_key: uuid() }, // B2 free, A1 taken
    { 'x-user-id': 'user-789' }
  );
  assert.strictEqual(resPartial.status, 409);
  // B2 should still be available
  const stateCheck = await makeRequest('GET', `/shows/${showId}`);
  assert.strictEqual(stateCheck.body.seats['B2'], 'available');
  console.log("✅ All-or-nothing partial request handled securely.\n");

  // 3. Release/expire a hold
  console.log("3. Release a hold — POST /reservations/{id}/cancel");
  const resCancel = await makeRequest('POST', `/reservations/${reservationId}/cancel`, {}, { 'x-user-id': userId });
  assert.strictEqual(resCancel.status, 200);
  
  // Verify seat is re-bookable
  const resRebook = await makeRequest('POST', `/shows/${showId}/reserve`, 
    { seats: ["A1"], idempotency_key: uuid() }, 
    { 'x-user-id': 'user-789' }
  );
  assert.strictEqual(resRebook.status, 201);
  console.log("✅ Released seat cleanly rebooked by another user.\n");

  // Security: only owner can cancel
  const resCancelFail = await makeRequest('POST', `/reservations/${resRebook.body.reservation_id}/cancel`, {}, { 'x-user-id': 'hacker-000' });
  assert.strictEqual(resCancelFail.status, 403);
  console.log("✅ Security: Cancel forbidden for non-owners (403).\n");

  // 4. Show State & Reconciliation
  console.log("4. Show state — GET /shows/{id} and Invariant");
  const finalState = await makeRequest('GET', `/shows/${showId}`);
  assert.strictEqual(finalState.status, 200);
  const { available, confirmed, held, total } = finalState.body.counts;
  assert.strictEqual(available + confirmed + held, total);
  console.log(`✅ Reconciliation Invariant Holds: ${available} + ${confirmed} + ${held} = ${total}\n`);

  // 5. Health & Metrics
  console.log("5. Health & Metrics");
  const liveRes = await makeRequest('GET', '/livez');
  assert.strictEqual(liveRes.status, 200);
  const readyRes = await makeRequest('GET', '/readyz');
  assert.strictEqual(readyRes.status, 200);
  const metricsRes = await makeRequest('GET', '/metrics');
  assert.strictEqual(metricsRes.status, 200);
  console.log("✅ Health probes and Prometheus metrics endpoints active.\n");

  console.log("=== ALL PRD FUNCTIONAL REQUIREMENTS PASSED ===");
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
