-- Hide untracked Usage cards. Changelog only. The same statement is in schema.sql.
-- Additive: one new table. No existing table or column changes.
-- usage_hidden_cards holds the Usage and Costs cards the operator hid because
-- no tracking or feed is connected. Display only: no total reads it. A key
-- applies only while that card has no data; a card with data is always shown.
-- Rollback: drop the table; every card is then shown again.
create table if not exists usage_hidden_cards (
  card_key text primary key check (card_key ~ '^(provider:[a-z0-9._:-]{1,100}|grok:(local|openrouter|shadow)|claude:shadow)$'),
  hidden_at timestamptz not null default now()
);
