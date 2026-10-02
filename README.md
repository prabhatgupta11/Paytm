# Seat Reservation Service

This is a highly concurrent seat reservation service that provides a JSON API for reserving seats atomically under scale.

## Running Locally

Requirements: Docker and docker-compose installed.

```sh
docker-compose up --build -d
```
This will start the PostgreSQL database and the Node.js API server on port 3000.

## Running the Burst Test

To simulate a stampede and verify correctness:
```sh
node burst.js http://localhost:3000
```
This script creates a show and fires concurrent reservation requests, demonstrating how the system correctly handles:
- Hot seat contention (500 users trying to grab `A1` exactly at the same time).
- Per-user seat limits (capped at 4).
- Idempotency enforcement and conflict resolution.

## API Endpoints

- `POST /shows` - Create a show
- `POST /shows/{id}/reserve` - Reserve seats
- `POST /reservations/{id}/cancel` - Cancel a reservation
- `GET /shows/{id}` - Get current state of the show
- `GET /metrics` - Prometheus metrics
- `GET /livez` - Liveness probe
- `GET /readyz` - Readiness probe (checks DB)

## Deployment (Render, Fly.io, etc.)

Since this is a standard Dockerized application, you can deploy it to Render by creating a new **Web Service** and selecting the Docker runtime. Ensure you also provision a PostgreSQL instance on Render and provide the `DATABASE_URL` as an environment variable to the web service.

Metrics are exposed out-of-the-box at `/metrics`. 
Logs are structured as JSON for easy ingestion.
