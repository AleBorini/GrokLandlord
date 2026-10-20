-- Landlord register reminders: store as little as possible.
-- Only: email, region, timestamps, tokens. No names, no IP addresses, no postcodes.
CREATE TABLE subscribers (
  id                 INTEGER PRIMARY KEY,
  email              TEXT    NOT NULL,              -- lower-cased
  region             TEXT    NOT NULL,              -- one of the 9 region ids
  status             TEXT    NOT NULL CHECK (status IN ('pending', 'confirmed')),
  confirm_token_hash TEXT,                          -- SHA-256 of the confirmation token; NULL once confirmed
  unsub_token        TEXT    NOT NULL UNIQUE,       -- random, used in every unsubscribe link
  created_at         INTEGER NOT NULL,              -- ms since epoch (also the consent time)
  confirm_sent_at    INTEGER NOT NULL,              -- last confirmation email, for the resend cooldown
  confirmed_at       INTEGER,
  UNIQUE (email, region)
);
CREATE UNIQUE INDEX idx_subscribers_confirm ON subscribers (confirm_token_hash);
CREATE INDEX idx_subscribers_status_region ON subscribers (status, region);

-- One row per reminder actually sent, so the same reminder is never sent twice.
CREATE TABLE sends (
  subscriber_id INTEGER NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
  reminder_key  TEXT    NOT NULL,
  sent_at       INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, reminder_key)
);
