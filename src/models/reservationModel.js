const { prisma } = require('../config/db');

async function getReservationForUpdate(tx, reservationId) {
  const res = await tx.$queryRaw`
    SELECT show_id, user_id, status FROM reservations WHERE id = ${reservationId} FOR UPDATE
  `;
  if (!res || res.length === 0) return null;
  return res[0];
}

async function getSeatsForReservation(tx, reservationId) {
  const seats = await tx.reservationSeat.findMany({
    where: { reservationId }
  });
  return seats.map(s => s.seatNumber);
}

async function releaseSeats(tx, showId, seats) {
  await tx.seat.updateMany({
    where: {
      showId,
      seatNumber: { in: seats }
    },
    data: { status: 'available' }
  });
}

async function cancelReservationStatus(tx, reservationId) {
  await tx.reservation.update({
    where: { id: reservationId },
    data: { status: 'cancelled' }
  });
}

module.exports = {
  getReservationForUpdate,
  getSeatsForReservation,
  releaseSeats,
  cancelReservationStatus
};
