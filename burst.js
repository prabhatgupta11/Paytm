const fs = require('fs');
const crypto = require('crypto');
const http = require('http');

const BASE_URL = process.argv[2] || 'http://localhost:3000';

const agent = new http.Agent({ keepAlive: true, maxSockets: 500 });

async function makeRequest(method, path, body, headers = {}) {
  const url = `${BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    agent,
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
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function uuid() {
  return crypto.randomUUID();
}

async function runBurst() {
  console.log(`Starting burst test against ${BASE_URL}...`);
  
  // 1. Create show
  const seats = [];
  for (let i = 1; i <= 20; i++) seats.push(`A${i}`);
  for (let i = 1; i <= 20; i++) seats.push(`B${i}`);
  for (let i = 1; i <= 20; i++) seats.push(`C${i}`);
  const showRes = await makeRequest('POST', '/shows', {
    name: "Burst Concert",
    seats,
    price_paise: 25000
  });
  
  if (showRes.status !== 201) {
    console.error("Failed to create show:", showRes.body);
    process.exit(1);
  }
  const showId = showRes.body.id;
  console.log(`Created show ${showId} with ${seats.length} seats.`);

  let promises = [];
  
  // Scenario 1: Hot Seat Contention
  // 500 users trying to buy A1 concurrently
  const hotSeat = 'A1';
  for (let i = 0; i < 500; i++) {
    promises.push(
      makeRequest('POST', `/shows/${showId}/reserve`, 
      { seats: [hotSeat], idempotency_key: uuid() }, 
      { 'x-user-id': `hot-user-${i}` })
    );
  }

  // Scenario 2: Per-user limit
  // 1 user trying to buy 10 unique seats concurrently, limit is 4
  const greedyUser = 'greedy-user';
  for (let i = 1; i <= 10; i++) {
    promises.push(
      makeRequest('POST', `/shows/${showId}/reserve`,
      { seats: [`B${i}`], idempotency_key: uuid() },
      { 'x-user-id': greedyUser })
    );
  }

  // Scenario 3: Idempotent retries
  // 1 user, 10 retries with the SAME idempotency key and same seat
  const retryUser = 'retry-user';
  const retryKey = uuid();
  for (let i = 0; i < 10; i++) {
    promises.push(
      makeRequest('POST', `/shows/${showId}/reserve`,
      { seats: ['C1'], idempotency_key: retryKey },
      { 'x-user-id': retryUser })
    );
  }

  // Scenario 4: Idempotent conflict
  // 1 user, same key, DIFFERENT seats (should 409)
  const conflictUser = 'conflict-user';
  const conflictKey = uuid();
  promises.push(
    makeRequest('POST', `/shows/${showId}/reserve`,
    { seats: ['C2'], idempotency_key: conflictKey },
    { 'x-user-id': conflictUser })
  );
  // Give it a tiny delay or concurrent, let's do concurrent
  promises.push(
    makeRequest('POST', `/shows/${showId}/reserve`,
    { seats: ['C3'], idempotency_key: conflictKey },
    { 'x-user-id': conflictUser })
  );

  // Scenario 5: Valid diverse reservations to add load
  // 100 users buying various free seats safely
  for (let i = 2; i <= 20; i++) {
    promises.push(
      makeRequest('POST', `/shows/${showId}/reserve`,
      { seats: [`A${i}`], idempotency_key: uuid() },
      { 'x-user-id': `normie-${i}` })
    );
  }

  console.log(`Firing ${promises.length} concurrent requests...`);
  const results = await Promise.all(promises);
  console.log(`All requests completed.`);

  // Analyze results
  const statusCounts = {};
  const reasonCounts = {};
  
  for (const r of results) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    if (r.status === 409) {
      const reason = r.body.error || 'unknown 409';
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }

  console.log('--- Results Distribution ---');
  console.log('HTTP Status Codes:', statusCounts);
  if (Object.keys(reasonCounts).length > 0) {
    console.log('409 Reasons:', reasonCounts);
  }
  
  // Verify Reconciliation Invariant
  const finalState = await makeRequest('GET', `/shows/${showId}`);
  const { available, confirmed, held, total } = finalState.body.counts;
  console.log('\n--- Final Show State ---');
  console.log(`Available: ${available}, Confirmed: ${confirmed}, Held: ${held} -> Total: ${total}`);
  
  if (available + confirmed + held === total) {
    console.log('✅ Reconciliation Invariant HOLDS');
  } else {
    console.error('❌ Reconciliation Invariant FAILED');
  }

  // Verification checks based on our scenarios
  
  // Check greedy user holds <= 4 seats
  let greedyHolds = 0;
  for (const seat in finalState.body.seats) {
     // Actually we can't easily know who holds what from GET /shows/:id, 
     // but we can trust the test if only greedyUser requested B1-B10
     if (seat.startsWith('B') && finalState.body.seats[seat] === 'confirmed') {
       greedyHolds++;
     }
  }
  if (greedyHolds <= 4) {
    console.log(`✅ Per-user limit holds (Greedy user got ${greedyHolds} seats)`);
  } else {
    console.error(`❌ Per-user limit FAILED (Greedy user got ${greedyHolds} seats)`);
  }
}

runBurst().catch(console.error);
