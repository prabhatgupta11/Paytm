const { pool } = require('../config/db');
const { seatsAvailable } = require('../config/metrics');
const reservationModel = require('../models/reservationModel');
const showModel = require('../models/showModel');

async function cancelReservation(req, res) {
  const reservationId = req.params.id;
  const userId = req.headers['x-user-id'];

  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const reservation = await reservationModel.getReservationForUpdate(client, reservationId);

    if (!reservation) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reservation not found' });
    }

    if (reservation.user_id !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized to cancel this reservation' });
    }

    if (reservation.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Reservation already cancelled' });
    }

    const showId = reservation.show_id;
    const seats = await reservationModel.getSeatsForReservation(client, reservationId);

    await reservationModel.releaseSeats(client, showId, seats);
    await reservationModel.cancelReservationStatus(client, reservationId);

    await client.query('COMMIT');
    
    const availableCount = await showModel.getAvailableSeatCount(showId);
    seatsAvailable.set({ show_id: showId }, availableCount);

    res.status(200).json({ message: 'Reservation cancelled successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
}

module.exports = {
  cancelReservation
};
