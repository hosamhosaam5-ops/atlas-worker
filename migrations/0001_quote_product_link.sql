-- ATLAS migration 0001: bind quotes to catalog products.
-- Safe additive migration: preserves all existing quote rows.
ALTER TABLE order_quotes ADD COLUMN product_id TEXT;
CREATE INDEX IF NOT EXISTS idx_order_quotes_product ON order_quotes(product_id, status);
