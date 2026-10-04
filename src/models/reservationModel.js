const { pool } = require('../config/db');

async function getReservationForUpdate(client, reservationId) {
  const res = await client.query(
    'SELECT show_id, user_id, status FROM reservations WHERE id = $1 FOR UPDATE',
    [reservationId]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0];
}

async function getSeatsForReservation(client, reservationId) {
  const res = await client.query(
    'SELECT seat_number FROM reservation_seats WHERE reservation_id = $1',
    [reservationId]
  );
  return res.rows.map(row => row.seat_number);
}

async function releaseSeats(client, showId, seats) {
  await client.query(
    'UPDATE seats SET status = $1 WHERE show_id = $2 AND seat_number = ANY($3)',
    ['available', showId, seats]
  );
}

async function cancelReservationStatus(client, reservationId) {
  await client.query(
    'UPDATE reservations SET status = $1 WHERE id = $2',
    ['cancelled', reservationId]
  );
}

module.exports = {
  getReservationForUpdate,
  getSeatsForReservation,
  releaseSeats,
  cancelReservationStatus
};
