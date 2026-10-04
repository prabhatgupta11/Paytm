const { prisma } = require('../config/db');

async function createShow(id, name, price_paise, seats) {
  await prisma.$transaction(async (tx) => {
    await tx.show.create({
      data: {
        id,
        name,
        pricePaise: price_paise,
        totalSeats: seats.length,
      }
    });

    const seatData = seats.map(seat => ({
      showId: id,
      seatNumber: seat,
      status: 'available'
    }));

    await tx.seat.createMany({
      data: seatData
    });
  });
}

async function getShowById(showId) {
  const show = await prisma.show.findUnique({
    where: { id: showId }
  });
  if (!show) return null;
  return {
    id: show.id,
    name: show.name,
    price_paise: show.pricePaise,
    total_seats: show.totalSeats
  };
}

async function getSeatsByShow(showId) {
  const seats = await prisma.seat.findMany({
    where: { showId }
  });
  return seats.map(s => ({
    seat_number: s.seatNumber,
    status: s.status
  }));
}

async function getAvailableSeatCount(showId) {
  return await prisma.seat.count({
    where: { showId, status: 'available' }
  });
}

module.exports = {
  createShow,
  getShowById,
  getSeatsByShow,
  getAvailableSeatCount
};
