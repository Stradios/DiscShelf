-- DiscShelf community database.
-- One row per (barcode, title, format) answer. Votes count how many people confirmed it.
-- Only barcode, title, format, year and TMDB ids are stored. No user data of any kind.

CREATE TABLE IF NOT EXISTS releases (
  barcode    TEXT    NOT NULL,
  title_key  TEXT    NOT NULL,            -- normalised title, used to group spelling variants
  title      TEXT    NOT NULL,            -- title as first submitted
  format     TEXT    NOT NULL,            -- DVD, Blu-ray, 4K UHD, HD DVD, Other
  year       TEXT    NOT NULL DEFAULT '',
  tmdb_id    TEXT    NOT NULL DEFAULT '',
  poster     TEXT    NOT NULL DEFAULT '', -- TMDB image URL only, never an uploaded image
  votes      INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL,
  PRIMARY KEY (barcode, title_key, format)
);

CREATE INDEX IF NOT EXISTS idx_releases_barcode ON releases (barcode, votes DESC);
