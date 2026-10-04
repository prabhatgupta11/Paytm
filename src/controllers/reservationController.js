const { prisma } = require('../config/db');
const { seatsAvailable } = require('../config/metrics');
const reservationModel = require('../models/reservationModel');
const showModel = require('../models/showModel');

async function cancelReservation(req, res) {
  const reservationId = req.params.id;
  const userId = req.headers['x-user-id'];

  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' });

  try {
    const showId = await prisma.$transaction(async (tx) => {
      const reservation = await reservationModel.getReservationForUpdate(tx, reservationId);

      if (!reservation) {
        throw new Error('NOT_FOUND');
      }

      if (reservation.user_id !== userId) {
        throw new Error('FORBIDDEN');
      }

      if (reservation.status === 'cancelled') {
        throw new Error('ALREADY_CANCELLED');
      }

      const sId = reservation.show_id;
      const seats = await reservationModel.getSeatsForReservation(tx, reservationId);

      await reservationModel.releaseSeats(tx, sId, seats);
      await reservationModel.cancelReservationStatus(tx, reservationId);

      return sId;
    }, { maxWait: 30000, timeout: 30000 });

    const availableCount = await showModel.getAvailableSeatCount(showId);
    seatsAvailable.set({ show_id: showId }, availableCount);

    res.status(200).json({ message: 'Reservation cancelled successfully' });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Reservation not found' });
    if (err.message === 'FORBIDDEN') return res.status(403).json({ error: 'Not authorized to cancel this reservation' });
    if (err.message === 'ALREADY_CANCELLED') return res.status(400).json({ error: 'Reservation already cancelled' });
    
    console.error("Cancel Error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = {
  cancelReservation
};
