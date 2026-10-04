const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { pool } = require('../config/db');
const { seatsAvailable, reservationsDeclined, reservationsConfirmed } = require('../config/metrics');
const showModel = require('../models/showModel');

const DEFAULT_USER_LIMIT = 4;

async function createShow(req, res) {
  const { name, seats, price_paise } = req.body;
  if (!name || !seats || !Array.isArray(seats) || price_paise == null) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const id = uuidv4();
  try {
    await showModel.createShow(id, name, price_paise, seats);
    seatsAvailable.set({ show_id: id }, seats.length);
    res.status(201).json({ id, name, price_paise, total_seats: seats.length });
  } catch (err) {
    console.error(JSON.stringify({ event: 'create_show_error', error: err.message }));
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function getShowState(req, res) {
  const showId = req.params.id;
  try {
    const show = await showModel.getShowById(showId);
    if (!show) {
      return res.status(404).json({ error: 'Show not found' });
    }
    
    const seats = await showModel.getSeatsByShow(showId);
    
    let availableCount = 0;
    let confirmedCount = 0;
    let heldCount = 0;

    const seatsMap = {};
    for (const row of seats) {
      seatsMap[row.seat_number] = row.status;
      if (row.status === 'available') availableCount++;
      else if (row.status === 'confirmed') confirmedCount++;
      else if (row.status === 'held') heldCount++;
    }

    res.status(200).json({
      ...show,
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
}

async function reserveSeats(req, res) {
  const showId = req.params.id;
  const { seats, idempotency_key } = req.body;
  const userId = req.headers['x-user-id'];

  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' });
  if (!seats || !Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'Invalid seats' });
  if (!idempotency_key) return res.status(400).json({ error: 'Missing idempotency_key' });

  const bodyString = JSON.stringify({ seats });
  const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency Check
    const idempRes = await client.query(
      'INSERT INTO idempotency_keys (key, user_id, request_body_hash, response_status, response_body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING RETURNING *',
      [idempotency_key, userId, bodyHash, 0, '{}']
    );

    if (idempRes.rowCount === 0) {
      const existingKey = await client.query('SELECT * FROM idempotency_keys WHERE key = $1', [idempotency_key]);
      const record = existingKey.rows[0];
      
      if (record.request_body_hash !== bodyHash) {
        await client.query('ROLLBACK');
        reservationsDeclined.inc({ reason: 'idempotent-replay-conflict' });
        return res.status(409).json({ error: 'Idempotency key already used with different body' });
      }
      await client.query('ROLLBACK');
      if (record.response_status === 0) {
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

    const sortedSeats = [...seats].sort();
    
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

    const show = await showModel.getShowById(showId);
    if (!show) {
      await saveIdempotencyResponse(client, idempotency_key, 404, { error: 'Show not found' });
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Show not found' });
    }
    const amount_paise = show.price_paise * seats.length;

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
    
    reservationsConfirmed.inc();
    const availableCount = await showModel.getAvailableSeatCount(showId);
    seatsAvailable.set({ show_id: showId }, availableCount);

    res.status(201).json(successResponse);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(JSON.stringify({ event: 'reserve_error', error: err.message }));
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
}

async function saveIdempotencyResponse(client, key, status, body) {
  await client.query(
    'UPDATE idempotency_keys SET response_status = $1, response_body = $2 WHERE key = $3',
    [status, body, key]
  );
}

module.exports = {
  createShow,
  getShowState,
  reserveSeats
};
