const { pool } = require('../config/db');

async function createShow(id, name, price_paise, seats) {
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
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getShowById(showId) {
  const showRes = await pool.query('SELECT id, name, price_paise, total_seats FROM shows WHERE id = $1', [showId]);
  if (showRes.rows.length === 0) return null;
  return showRes.rows[0];
}

async function getSeatsByShow(showId) {
  const seatsRes = await pool.query('SELECT seat_number, status FROM seats WHERE show_id = $1', [showId]);
  return seatsRes.rows;
}

async function getAvailableSeatCount(showId) {
  const res = await pool.query("SELECT COUNT(*) FROM seats WHERE show_id = $1 AND status = 'available'", [showId]);
  return parseInt(res.rows[0].count, 10);
}

module.exports = {
  createShow,
  getShowById,
  getSeatsByShow,
  getAvailableSeatCount
};
