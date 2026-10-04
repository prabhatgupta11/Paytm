const express = require('express');
const showController = require('../controllers/showController');

const router = express.Router();

router.post('/', showController.createShow);
router.post('/:id/reserve', showController.reserveSeats);
router.get('/:id', showController.getShowState);

module.exports = router;
