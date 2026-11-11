-- Apply once to the existing Neon database from its SQL Editor.
-- These additions track the round, judge, and grouped multi-card submissions.

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS round_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rounds_limit integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS judge_player_id uuid;

ALTER TABLE played_cards
  ADD COLUMN IF NOT EXISTS round_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS submission_id uuid;

CREATE TABLE IF NOT EXISTS round_votes (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  vote_number integer NOT NULL CHECK (vote_number IN (1, 2)),
  voter_player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, round_number, vote_number, voter_player_id)
);

CREATE TABLE IF NOT EXISTS room_custom_cards (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  card_text text NOT NULL CHECK (char_length(btrim(card_text)) BETWEEN 3 AND 160),
  is_ready boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, player_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rooms_judge_player_id_fkey'
      AND conrelid = 'rooms'::regclass
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_judge_player_id_fkey
      FOREIGN KEY (judge_player_id) REFERENCES players(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS players_room_created_idx
  ON players (room_id, created_at, id);
CREATE INDEX IF NOT EXISTS played_cards_room_round_idx
  ON played_cards (room_id, round_number, submission_id);
CREATE INDEX IF NOT EXISTS round_votes_room_round_idx
  ON round_votes (room_id, round_number, vote_number, submission_id);
CREATE UNIQUE INDEX IF NOT EXISTS room_custom_cards_unique_text_idx
  ON room_custom_cards (room_id, lower(btrim(card_text)));
CREATE INDEX IF NOT EXISTS cards_type_id_idx
  ON cards (type, id);

INSERT INTO cards (type, text, pick, author)
SELECT 'black', seed.text, 1, 'Cartas Caos'
FROM (VALUES
  ('Lo último que me esperaba ver en el metro de Barcelona a las 3 de la mañana es a _____ con una bolsa del Lidl.'),
  ('En España no tenemos un AVE que funcione bien porque el presupuesto se gastó íntegramente en _____.'),
  ('Mi plan para salir de esta crisis vital y de la precariedad laboral es _____ y confiar en la providencia.'),
  ('Lo que verdaderamente destruyó mi salud mental a los 22 años fue _____ y 4 cafés de máquina.'),
  ('Cuando vas a casa de tu abuela y te dice que estás muy flaco, procede a sacarte _____ de la cocina.'),
  ('Excusas baratas para cancelar un plan a última hora: «Lo siento, me ha surgido un imprevisto con _____».')
) AS seed(text)
WHERE NOT EXISTS (
  SELECT 1 FROM cards existing WHERE existing.type = 'black' AND existing.text = seed.text
);

INSERT INTO cards (type, text, pick, author)
SELECT 'white', seed.text, 1, 'Cartas Caos'
FROM (VALUES
  ('Un audio de WhatsApp de 9 minutos y medio explicando una movida de amor propio.'),
  ('Un kebab de 4 euros que sabe a radiación nuclear.'),
  ('Discutir de política con un cuñao en Nochebuena.'),
  ('El grupo de WhatsApp de la uni que lleva inactivo desde 2023.'),
  ('Perder el último bus nocturno y tener que cruzar media ciudad andando.'),
  ('Una ruptura amistosa pero con pasivo-agresividad en los stories de Instagram.'),
  ('Decir «ahora voy» desde la cama y no moverse jamás.'),
  ('Un tupper de croquetas de procedencia misteriosa.'),
  ('Una autistada de 6 horas programando una web chorra a las 4 de la mañana.'),
  ('El «tenemos que quedar» más falso de la historia.'),
  ('Un Bizum de 2,35 euros reclamado con un Excel.'),
  ('Un señor diciendo «esto con Franco no pasaba» en la cola del súper.'),
  ('Hacer contacto visual con el vecino mientras ambos sacáis la basura.'),
  ('Un tinto de verano caliente en un vaso de plástico.'),
  ('La playlist triste que se activa sola al volver de fiesta.'),
  ('Un «jajaja» que en realidad significa «no me vuelvas a hablar».')
) AS seed(text)
WHERE NOT EXISTS (
  SELECT 1 FROM cards existing WHERE existing.type = 'white' AND existing.text = seed.text
);
