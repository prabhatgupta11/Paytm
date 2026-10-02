const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const promClient = require('prom-client');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ticket_service',
  max: 200, // connection pool limit
});

// Setup Prometheus metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const reservationsConfirmed = new promClient.Counter({
  name: 'reservations_confirmed_total',
  help: 'Total confirmed reservations',
});
register.registerMetric(reservationsConfirmed);

const reservationsDeclined = new promClient.Counter({
  name: 'reservations_declined_total',
  help: 'Total declined reservations',
  labelNames: ['reason'],
});
register.registerMetric(reservationsDeclined);

const seatsAvailable = new promClient.Gauge({
  name: 'seats_available',
  help: 'Current seats available per show',
  labelNames: ['show_id'],
});
register.registerMetric(seatsAvailable);

// Init DB
async function initDb() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
  console.log(JSON.stringify({ msg: 'Database initialized', event: 'db_init' }));
}

// Middleware for structured logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      event: 'request',
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      user_id: req.headers['x-user-id'] || 'anonymous',
      req_id: req.headers['x-request-id'] || uuidv4()
    }));
  });
  next();
});

const DEFAULT_USER_LIMIT = 4;

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

app.get('/livez', (req, res) => {
  res.send('OK');
});

app.get('/readyz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.send('OK');
  } catch (err) {
    console.error(JSON.stringify({ event: 'readyz_failed', error: err.message }));
    res.status(503).send('Unavailable');
  }
});

// 1. Create a show
app.post('/shows', async (req, res) => {
  const { name, seats, price_paise } = req.body;
  if (!name || !seats || !Array.isArray(seats) || price_paise == null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const id = uuidv4();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO shows (id, name, price_paise, total_seats) VALUES ($1, $2, $3, $4)',
      [id, name, price_paise, seats.length]
    );

    for (const seat of seats) {
      await client.query(
        'INSERT INTO seats (show_id, seat_number, status) VALUES ($1, $2, $3)',
        [id, seat, 'available']
      );
    }
    await client.query('COMMIT');
    seatsAvailable.set({ show_id: id }, seats.length);
    res.status(201).json({ id, name, price_paise, total_seats: seats.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// 2. Reserve a seat
app.post('/shows/:id/reserve', async (req, res) => {
  const showId = req.params.id;
  const { seats, idempotency_key } = req.body;
  const userId = req.headers['x-user-id']; // Identity from auth token

  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' });
  if (!seats || !Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'Invalid seats' });
  if (!idempotency_key) return res.status(400).json({ error: 'Missing idempotency_key' });

  // Compute hash of the request body for idempotency comparison
  const bodyString = JSON.stringify({ seats });
  const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency Check
    const idempRes = await client.query(
      'INSERT INTO idempotency_keys (key, user_id, request_body_hash, response_status, response_body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING RETURNING *',
      [idempotency_key, userId, bodyHash, 0, '{}'] // 0 means pending, will update later
    );

    if (idempRes.rowCount === 0) {
      // Key already exists. Fetch it.
      const existingKey = await client.query('SELECT * FROM idempotency_keys WHERE key = $1', [idempotency_key]);
      const record = existingKey.rows[0];
      
      // If the body hash is different, it's a conflict
      if (record.request_body_hash !== bodyHash) {
        await client.query('ROLLBACK');
        reservationsDeclined.inc({ reason: 'idempotent-replay-conflict' });
        return res.status(409).json({ error: 'Idempotency key already used with different body' });
      }
      // If it's the exact same request, return the saved response
      await client.query('ROLLBACK');
      if (record.response_status === 0) {
         // This means the previous request failed before finishing or is concurrent.
         // Let's treat it as conflict for concurrent.
         return res.status(409).json({ error: 'Concurrent request with same idempotency key' });
      }
      return res.status(record.response_status).json(record.response_body);
    }

    // Check user limit
    const limitRes = await client.query(
      'SELECT COUNT(*) as count FROM reservation_seats rs JOIN reservations r ON rs.reservation_id = r.id WHERE r.show_id = $1 AND r.user_id = $2 AND r.status = $3',
      [showId, userId, 'confirmed']
    );
    const currentHeld = parseInt(limitRes.rows[0].count, 10);
    if (currentHeld + seats.length > DEFAULT_USER_LIMIT) {
      await saveIdempotencyResponse(client, idempotency_key, 409, { error: 'Per-user limit exceeded' });
      await client.query('COMMIT');
      reservationsDeclined.inc({ reason: 'per-user-limit' });
      return res.status(409).json({ error: 'Per-user limit exceeded' });
    }

    // Lock seats in a consistent order to prevent deadlocks
    const sortedSeats = [...seats].sort();
    
    // Check if seats exist and are available
    const seatsRes = await client.query(
      'SELECT seat_number, status FROM seats WHERE show_id = $1 AND seat_number = ANY($2) ORDER BY seat_number FOR UPDATE',
      [showId, sortedSeats]
    );

    if (seatsRes.rows.length !== sortedSeats.length) {
      await saveIdempotencyResponse(client, idempotency_key, 400, { error: 'One or more seats do not exist' });
      await client.query('COMMIT');
      reservationsDeclined.inc({ reason: 'invalid-seats' });
      return res.status(400).json({ error: 'One or more seats do not exist' });
    }

    for (const seatRow of seatsRes.rows) {
      if (seatRow.status !== 'available') {
        await saveIdempotencyResponse(client, idempotency_key, 409, { error: 'Seat already taken' });
        await client.query('COMMIT');
        reservationsDeclined.inc({ reason: 'seat-taken' });
        return res.status(409).json({ error: 'Seat already taken' });
      }
    }

    // Get show price
    const showRes = await client.query('SELECT price_paise FROM shows WHERE id = $1', [showId]);
    if (showRes.rows.length === 0) {
      await saveIdempotencyResponse(client, idempotency_key, 404, { error: 'Show not found' });
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Show not found' });
    }
    const price_paise = showRes.rows[0].price_paise;
    const amount_paise = price_paise * seats.length;

    // Proceed to reserve
    await client.query(
      'UPDATE seats SET status = $1 WHERE show_id = $2 AND seat_number = ANY($3)',
      ['confirmed', showId, sortedSeats]
    );

    const reservationId = uuidv4();
    await client.query(
      'INSERT INTO reservations (id, show_id, user_id, amount_paise, status) VALUES ($1, $2, $3, $4, $5)',
      [reservationId, showId, userId, amount_paise, 'confirmed']
    );

    for (const seat of sortedSeats) {
      await client.query(
        'INSERT INTO reservation_seats (reservation_id, show_id, seat_number) VALUES ($1, $2, $3)',
        [reservationId, showId, seat]
      );
    }

    const successResponse = {
      reservation_id: reservationId,
      show_id: showId,
      user_id: userId,
      seats: sortedSeats,
      amount_paise,
      status: 'confirmed'
    };

    await saveIdempotencyResponse(client, idempotency_key, 201, successResponse);
    await client.query('COMMIT');
    
    // Update metrics
    reservationsConfirmed.inc();
    const availableRes = await pool.query("SELECT COUNT(*) FROM seats WHERE show_id = $1 AND status = 'available'", [showId]);
    seatsAvailable.set({ show_id: showId }, parseInt(availableRes.rows[0].count, 10));

    res.status(201).json(successResponse);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(JSON.stringify({ event: 'reserve_error', error: err.message }));
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

async function saveIdempotencyResponse(client, key, status, body) {
  await client.query(
    'UPDATE idempotency_keys SET response_status = $1, response_body = $2 WHERE key = $3',
    [status, body, key]
  );
}

// 3. Release/expire a hold
app.post('/reservations/:id/cancel', async (req, res) => {
  const reservationId = req.params.id;
  const userId = req.headers['x-user-id']; // Identity from auth token

  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Use FOR UPDATE to prevent concurrent cancellations
    const resvRes = await client.query(
      'SELECT show_id, user_id, status FROM reservations WHERE id = $1 FOR UPDATE',
      [reservationId]
    );

    if (resvRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const reservation = resvRes.rows[0];
    if (reservation.user_id !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized to cancel this reservation' });
    }

    if (reservation.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Reservation already cancelled' });
    }

    const showId = reservation.show_id;

    // Get the seats for this reservation
    const seatsRes = await client.query(
      'SELECT seat_number FROM reservation_seats WHERE reservation_id = $1',
      [reservationId]
    );
    const seats = seatsRes.rows.map(row => row.seat_number);

    // Release the seats
    await client.query(
      'UPDATE seats SET status = $1 WHERE show_id = $2 AND seat_number = ANY($3)',
      ['available', showId, seats]
    );

    // Cancel reservation
    await client.query(
      'UPDATE reservations SET status = $1 WHERE id = $2',
      ['cancelled', reservationId]
    );

    await client.query('COMMIT');
    
    const availableRes = await pool.query("SELECT COUNT(*) FROM seats WHERE show_id = $1 AND status = 'available'", [showId]);
    seatsAvailable.set({ show_id: showId }, parseInt(availableRes.rows[0].count, 10));

    res.status(200).json({ message: 'Reservation cancelled successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// 4. Show state
app.get('/shows/:id', async (req, res) => {
  const showId = req.params.id;
  try {
    const showRes = await pool.query('SELECT id, name, price_paise, total_seats FROM shows WHERE id = $1', [showId]);
    if (showRes.rows.length === 0) {
      return res.status(404).json({ error: 'Show not found' });
    }
    
    const seatsRes = await pool.query('SELECT seat_number, status FROM seats WHERE show_id = $1', [showId]);
    
    let availableCount = 0;
    let confirmedCount = 0;
    let heldCount = 0; // if we use holds in the future

    const seatsMap = {};
    for (const row of seatsRes.rows) {
      seatsMap[row.seat_number] = row.status;
      if (row.status === 'available') availableCount++;
      else if (row.status === 'confirmed') confirmedCount++;
      else if (row.status === 'held') heldCount++;
    }

    res.status(200).json({
      ...showRes.rows[0],
      counts: {
        available: availableCount,
        confirmed: confirmedCount,
        held: heldCount,
        total: availableCount + confirmedCount + heldCount
      },
      seats: seatsMap
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDb();
  console.log(JSON.stringify({ event: 'server_start', port: PORT }));
});
