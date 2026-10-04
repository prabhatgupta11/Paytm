const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { prisma, initDb } = require('./config/db');
const { register } = require('./config/metrics');
const showRoutes = require('./routes/showRoutes');
const reservationRoutes = require('./routes/reservationRoutes');

const app = express();
app.use(express.json());

// Middleware for structured logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      event: 'request',
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      user_id: req.headers['x-user-id'] || 'anonymous',
      req_id: req.headers['x-request-id'] || uuidv4()
    }));
  });
  next();
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

app.get('/livez', (req, res) => {
  res.send('OK');
});

app.get('/readyz', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.send('OK');
  } catch (err) {
    console.error(JSON.stringify({ event: 'readyz_failed', error: err.message }));
    res.status(503).send('Unavailable');
  }
});

app.use('/shows', showRoutes);
app.use('/reservations', reservationRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDb();
  console.log(JSON.stringify({ event: 'server_start', port: PORT }));
});
