const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { prisma } = require('../config/db');
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

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Advisory lock for the user to prevent per-user-limit race conditions
      const userLockInt = parseInt(crypto.createHash('md5').update(userId).digest('hex').substring(0, 8), 16);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${userLockInt})`;

      // Idempotency Check using raw SQL to avoid aborting the transaction on conflict
      const idempRes = await tx.$executeRaw`
        INSERT INTO idempotency_keys (key, user_id, request_body_hash, response_status, response_body) 
        VALUES (${idempotency_key}, ${userId}, ${bodyHash}, 0, '{}'::jsonb) 
        ON CONFLICT (key) DO NOTHING
      `;

      if (idempRes === 0) {
        // Key exists
        const existingKeys = await tx.$queryRaw`SELECT * FROM idempotency_keys WHERE key = ${idempotency_key}`;
        const existingKey = existingKeys[0];
        if (existingKey.request_body_hash !== bodyHash) {
          throw new Error('IDEMPOTENT_REPLAY_CONFLICT');
        }
        if (existingKey.response_status === 0) {
          throw new Error('CONCURRENT_REQUEST');
        }
        throw new Error(`RETURN_EXISTING|${existingKey.response_status}|${JSON.stringify(existingKey.response_body)}`);
      }

      // Check user limit
      const limitRes = await tx.$queryRaw`
        SELECT COUNT(*) as count FROM reservation_seats rs 
        JOIN reservations r ON rs.reservation_id = r.id 
        WHERE r.show_id = ${showId} AND r.user_id = ${userId} AND r.status = 'confirmed'
      `;
      const currentHeld = Number(limitRes[0].count);

      if (currentHeld + seats.length > DEFAULT_USER_LIMIT) {
        await saveIdempotencyResponse(tx, idempotency_key, 409, { error: 'Per-user limit exceeded' });
        throw new Error('PER_USER_LIMIT');
      }

      const sortedSeats = [...seats].sort();
      
      const seatsRes = await tx.$queryRaw`
        SELECT seat_number, status FROM seats WHERE show_id = ${showId} AND seat_number = ANY(${sortedSeats}) ORDER BY seat_number FOR UPDATE
      `;

      if (seatsRes.length !== sortedSeats.length) {
        await saveIdempotencyResponse(tx, idempotency_key, 400, { error: 'One or more seats do not exist' });
        throw new Error('INVALID_SEATS');
      }

      for (const seatRow of seatsRes) {
        if (seatRow.status !== 'available') {
          await saveIdempotencyResponse(tx, idempotency_key, 409, { error: 'Seat already taken' });
          throw new Error('SEAT_TAKEN');
        }
      }

      const show = await tx.show.findUnique({ where: { id: showId } });
      if (!show) {
        await saveIdempotencyResponse(tx, idempotency_key, 404, { error: 'Show not found' });
        throw new Error('SHOW_NOT_FOUND');
      }
      
      const amount_paise = show.pricePaise * seats.length;

      await tx.seat.updateMany({
        where: { showId, seatNumber: { in: sortedSeats } },
        data: { status: 'confirmed' }
      });

      const reservationId = uuidv4();
      
      await tx.reservation.create({
        data: {
          id: reservationId,
          showId,
          userId,
          amountPaise: amount_paise,
          status: 'confirmed'
        }
      });

      const resSeatsData = sortedSeats.map(seat => ({
        reservationId,
        showId,
        seatNumber: seat
      }));

      await tx.reservationSeat.createMany({
        data: resSeatsData
      });

      const successResponse = {
        reservation_id: reservationId,
        show_id: showId,
        user_id: userId,
        seats: sortedSeats,
        amount_paise,
        status: 'confirmed'
      };

      await saveIdempotencyResponse(tx, idempotency_key, 201, successResponse);

      return successResponse;
    }, { maxWait: 30000, timeout: 30000 });

    reservationsConfirmed.inc();
    const availableCount = await showModel.getAvailableSeatCount(showId);
    seatsAvailable.set({ show_id: showId }, availableCount);

    res.status(201).json(result);

  } catch (err) {
    if (err.message.startsWith('RETURN_EXISTING')) {
      const parts = err.message.split('|');
      return res.status(parseInt(parts[1], 10)).json(JSON.parse(parts[2]));
    }
    
    if (err.message === 'IDEMPOTENT_REPLAY_CONFLICT') {
      reservationsDeclined.inc({ reason: 'idempotent-replay-conflict' });
      return res.status(409).json({ error: 'Idempotency key already used with different body' });
    }
    if (err.message === 'CONCURRENT_REQUEST') return res.status(409).json({ error: 'Concurrent request with same idempotency key' });
    
    if (err.message === 'PER_USER_LIMIT') {
      reservationsDeclined.inc({ reason: 'per-user-limit' });
      return res.status(409).json({ error: 'Per-user limit exceeded' });
    }
    
    if (err.message === 'INVALID_SEATS') {
      reservationsDeclined.inc({ reason: 'invalid-seats' });
      return res.status(400).json({ error: 'One or more seats do not exist' });
    }
    
    if (err.message === 'SEAT_TAKEN') {
      reservationsDeclined.inc({ reason: 'seat-taken' });
      return res.status(409).json({ error: 'Seat already taken' });
    }
    
    if (err.message === 'SHOW_NOT_FOUND') return res.status(404).json({ error: 'Show not found' });

    console.error(JSON.stringify({ event: 'reserve_error', error: err.message }));
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function saveIdempotencyResponse(tx, key, status, body) {
  await tx.idempotencyKey.update({
    where: { key },
    data: {
      responseStatus: status,
      responseBody: body
    }
  });
}

module.exports = {
  createShow,
  getShowState,
  reserveSeats
};
