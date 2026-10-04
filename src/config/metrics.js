const promClient = require('prom-client');

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const reservationsConfirmed = new promClient.Counter({
  name: 'reservations_confirmed_total',
  help: 'Total confirmed reservations',
});
register.registerMetric(reservationsConfirmed);

const reservationsDeclined = new promClient.Counter({
  name: 'reservations_declined_total',
  help: 'Total declined reservations',
  labelNames: ['reason'],
});
register.registerMetric(reservationsDeclined);

const seatsAvailable = new promClient.Gauge({
  name: 'seats_available',
  help: 'Current seats available per show',
  labelNames: ['show_id'],
});
register.registerMetric(seatsAvailable);

module.exports = {
  register,
  reservationsConfirmed,
  reservationsDeclined,
  seatsAvailable
};
