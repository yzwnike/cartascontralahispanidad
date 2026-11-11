-- Apply once to the existing Neon database from its SQL Editor.
-- These additions track rounds, judges, grouped submissions, and card rerolls.

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS round_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rounds_limit integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS judge_player_id uuid;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS rooms_active_code_unique
  ON rooms (code) WHERE status <> 'finished';

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

CREATE TABLE IF NOT EXISTS round_card_rerolls (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  round_number integer NOT NULL CHECK (round_number > 0),
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, round_number, player_id)
);

CREATE TABLE IF NOT EXISTS room_player_white_cards (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  card_key text NOT NULL,
  card_text text NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, player_id, card_key)
);

CREATE TABLE IF NOT EXISTS cunadometro_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(6) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished')),
  round_number integer NOT NULL DEFAULT 0,
  rounds_limit integer NOT NULL DEFAULT 10 CHECK (rounds_limit IN (5, 10, 20)),
  game_stage varchar(30) NOT NULL DEFAULT 'lobby',
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE cunadometro_rooms DROP CONSTRAINT IF EXISTS cunadometro_rooms_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS cunadometro_active_code_unique
  ON cunadometro_rooms (code) WHERE status <> 'finished';

ALTER TABLE cunadometro_rooms
  ADD COLUMN IF NOT EXISTS game_stage varchar(30) NOT NULL DEFAULT 'legacy';
UPDATE cunadometro_rooms SET game_stage = 'lobby' WHERE status = 'waiting' AND game_stage = 'legacy';
ALTER TABLE cunadometro_rooms ALTER COLUMN game_stage SET DEFAULT 'lobby';

CREATE TABLE IF NOT EXISTS cunadometro_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES cunadometro_rooms(id) ON DELETE CASCADE,
  name varchar(20) NOT NULL,
  score integer NOT NULL DEFAULT 0,
  is_host boolean NOT NULL DEFAULT false,
  duels_played integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE cunadometro_players
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS cunadometro_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES cunadometro_rooms(id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  mode varchar(20) NOT NULL CHECK (mode IN ('duel', 'all_play')),
  phase varchar(30) NOT NULL DEFAULT 'legacy',
  prompt_text text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'answering' CHECK (status IN ('answering', 'voting', 'resolved')),
  duel_player_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  reveal_started_at timestamptz,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (room_id, round_number)
);

ALTER TABLE cunadometro_rounds
  ADD COLUMN IF NOT EXISTS phase varchar(30) NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS reveal_started_at timestamptz;

CREATE TABLE IF NOT EXISTS cunadometro_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode varchar(20) NOT NULL CHECK (mode IN ('duel', 'all_play')),
  prompt_text text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (mode, prompt_text)
);

CREATE TABLE IF NOT EXISTS cunadometro_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES cunadometro_rooms(id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  player_id uuid NOT NULL REFERENCES cunadometro_players(id) ON DELETE CASCADE,
  answer_text varchar(180) NOT NULL CHECK (char_length(btrim(answer_text)) BETWEEN 2 AND 180),
  is_winner boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (room_id, round_number, player_id),
  FOREIGN KEY (room_id, round_number) REFERENCES cunadometro_rounds(room_id, round_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cunadometro_votes (
  room_id uuid NOT NULL REFERENCES cunadometro_rooms(id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  voter_player_id uuid NOT NULL REFERENCES cunadometro_players(id) ON DELETE CASCADE,
  answer_id uuid NOT NULL REFERENCES cunadometro_answers(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, round_number, voter_player_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS cunadometro_players_unique_name_idx
  ON cunadometro_players (room_id, lower(name));
CREATE INDEX IF NOT EXISTS cunadometro_answers_round_idx
  ON cunadometro_answers (room_id, round_number, created_at);
CREATE INDEX IF NOT EXISTS cunadometro_votes_round_idx
  ON cunadometro_votes (room_id, round_number, answer_id);
CREATE INDEX IF NOT EXISTS cunadometro_prompts_mode_idx
  ON cunadometro_prompts (mode, is_active);

INSERT INTO room_player_white_cards (room_id, player_id, card_key, card_text)
SELECT room_id, player_id, lower(btrim(card_text)), card_text
FROM played_cards
WHERE card_text IS NOT NULL AND btrim(card_text) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO room_player_white_cards (room_id, player_id, card_key, card_text)
SELECT p.room_id, p.id, lower(btrim(held.card_text)), held.card_text
FROM players p
JOIN rooms r ON r.id = p.room_id
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(p.hand) = 'array' THEN p.hand ELSE '[]'::jsonb END
) AS held(card_text)
WHERE r.status IN ('playing', 'judging', 'sudden_vote')
  AND btrim(held.card_text) <> ''
ON CONFLICT DO NOTHING;

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
