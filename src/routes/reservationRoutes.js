const express = require('express');
const reservationController = require('../controllers/reservationController');

const router = express.Router();

router.post('/:id/cancel', reservationController.cancelReservation);

module.exports = router;
