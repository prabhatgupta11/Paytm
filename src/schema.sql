CREATE TABLE IF NOT EXISTS shows (
    id VARCHAR(50) PRIMARY KEY,
    name TEXT NOT NULL,
    price_paise INT NOT NULL,
    total_seats INT NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
    show_id VARCHAR(50) REFERENCES shows(id),
    seat_number TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('available', 'held', 'confirmed')),
    PRIMARY KEY (show_id, seat_number)
);

CREATE TABLE IF NOT EXISTS reservations (
    id VARCHAR(50) PRIMARY KEY,
    show_id VARCHAR(50) REFERENCES shows(id),
    user_id TEXT NOT NULL,
    amount_paise INT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS reservation_seats (
    reservation_id VARCHAR(50) REFERENCES reservations(id),
    show_id VARCHAR(50),
    seat_number TEXT,
    FOREIGN KEY (show_id, seat_number) REFERENCES seats(show_id, seat_number),
    PRIMARY KEY (reservation_id, show_id, seat_number)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    request_body_hash TEXT NOT NULL,
    response_status INT NOT NULL,
    response_body JSONB NOT NULL
);

-- Index for checking per-user reservation limits quickly
CREATE INDEX IF NOT EXISTS idx_reservations_user_show ON reservations(user_id, show_id, status);
