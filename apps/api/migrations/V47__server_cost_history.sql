CREATE TABLE server_cost_snapshot (
  sampled_at    timestamptz PRIMARY KEY,
  current_usage numeric NOT NULL CHECK (current_usage >= 0)
);
