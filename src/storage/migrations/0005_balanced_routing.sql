ALTER TABLE logical_calls ADD COLUMN routing_policy TEXT NOT NULL DEFAULT 'balanced';
ALTER TABLE request_attempts ADD COLUMN routing_policy TEXT NOT NULL DEFAULT 'balanced';
ALTER TABLE request_attempts ADD COLUMN observed_model TEXT;
ALTER TABLE request_attempts ADD COLUMN observed_provider TEXT;
