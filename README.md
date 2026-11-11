# Tokatloscojones

## Hub de juegos

La portada (`/`) es un selector para los juegos independientes del proyecto:

- `/cartas/` abre Cartas Contra la Hispanidad y sus salas existentes.
- `/cunadometro/` abre Cuñadómetro, con salas, rondas de duelos aleatorios y retos en los que responde todo el grupo.

Cuñadómetro estructura cada partida en dos bloques de duelos separados por una ronda general, con otra ronda general como final. Antes de cada bloque, cada persona responde todos los duelos que tiene asignados; cuando el grupo termina, cada duelo se presenta de forma animada y se vota. En grupos impares se rotan las parejas para que todos jueguen exactamente el mismo número de duelos. Tras la general intermedia aparece la clasificación y la partida termina con un podio animado.

La duración se adapta al tamaño del grupo: en partidas rápidas/media/larga, cada persona juega 1/2/4 duelos por bloque si el grupo es par y 2/4/6 si es impar. El ajuste impar garantiza el mismo número exacto de duelos para todo el mundo. Cada partida suma dos rondas generales a los duelos.

## Conectar Neon

1. En Neon, abre **SQL Editor** y ejecuta [`db/schema.sql`](./db/schema.sql). Si ya lo ejecutaste antes, vuelve a ejecutarlo para añadir las columnas de fases y animaciones de Cuñadómetro. El script añade las tablas de partidas, rondas, respuestas, votos y consignas, el historial antirrepetición de cartas, y carga un mazo inicial sin duplicar cartas ya presentes.
2. Ejecuta también [`db/cunadometro-prompts.sql`](./db/cunadometro-prompts.sql) para cargar las consignas iniciales de duelos y rondas generales. Es seguro volver a ejecutarlo.
3. Para desarrollo local, copia [`.env.example`](./.env.example) a `.env` en la raíz y rellena `DATABASE_URL` con la cadena PostgreSQL de Neon. Conserva `sslmode=require`.
4. Genera un secreto de sesión localmente, sin compartirlo:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Pega el resultado en `PLAYER_TOKEN_SECRET` dentro de `.env`.
5. Ejecuta `npm run dev` para desarrollo. `npm run build` genera la salida compatible con Vercel.

## Desplegar en Vercel

Importa el repositorio de GitHub en Vercel y configura estas variables en **Settings → Environment Variables** para Production y Preview:

- `DATABASE_URL`: cadena de conexión PostgreSQL de Neon.
- `PLAYER_TOKEN_SECRET`: secreto aleatorio de al menos 32 caracteres.

No subas `.env` ni pegues secretos en el repositorio o en el chat. La aplicación usa el adaptador oficial `@astrojs/vercel` para SSR y endpoints API.

No uses variables `PUBLIC_` para estas credenciales. La URL de Neon y el secreto de sesión solo se leen en el servidor.

## API del juego

- `POST /api/rooms` crea una sala, el anfitrión y su mano inicial.
- `POST /api/rooms/:code/join` permite entrar y reparte la mano.
- `POST /api/rooms/:code/start` permite que solo el anfitrión cierre el lobby y empiece la partida, eligiendo 5, 10 o 20 rondas.
- `POST /api/rooms/:code/prepare` abre la fase previa para que cada persona cree su carta blanca.
- `POST /api/rooms/:code/custom-card` guarda o edita la carta blanca de un jugador antes de marcarse listo.
- `POST /api/rooms/:code/ready` marca a un jugador listo o permite que vuelva a editar su carta.
- `POST /api/rooms/:code/kick` permite que solo el anfitrión expulse a otra persona mientras la sala está esperando.
- `GET /api/rooms/:code?playerId=...` obtiene el estado; cada jugador solo recibe sus propias cartas.
- `POST /api/rooms/:code/reroll` cambia una carta de la mano del jugador por otra aleatoria; se permite una vez por ronda y antes de enviar respuesta.
- `POST /api/rooms/:code/submissions` juega la cantidad de cartas indicada por la negra y repone inmediatamente la mano hasta siete cartas, sin volver a repartirle cartas blancas que ya tuvo en esa partida.
- `POST /api/rooms/:code/vote` registra el voto; nadie puede votar su propia respuesta.
- `POST /api/rooms/:code/next` abre la siguiente ronda cuando se resuelve la votación.
- `DELETE /api/rooms/:code/players/:playerId` abandona la sala.
- `POST /api/cunadometro/rooms` y `POST /api/cunadometro/rooms/:code/join` crean o abren una sala independiente de Cuñadómetro.
- `POST /api/cunadometro/rooms/:code/start` inicia una partida rápida, media o larga. La cantidad de duelos por persona y el total de rondas se calculan según el número de jugadores.
- `POST /api/cunadometro/rooms/:code/answer`, `/vote` y `/next` gestionan las respuestas, votaciones y rondas.
- `GET /api/cunadometro/rooms/:code?playerId=...` obtiene el estado de la partida; las respuestas se mantienen ocultas hasta que el grupo termine de escribir.
- `DELETE /api/cunadometro/rooms/:code/players/:playerId` permite salir antes de empezar o al terminar; la partida en curso queda protegida contra abandonos que la bloqueen.

Las operaciones de estado usan transacciones y requieren el token de sesión que reciben los endpoints de creación/unión. La interfaz consulta el estado de la sala periódicamente para sincronizar a los participantes. Antes de empezar, cada persona escribe una carta blanca exclusiva de esa partida y marca que está lista; el anfitrión puede iniciar cuando todo el mundo esté listo. Todas las cartas personalizadas se reparten al comienzo a otro jugador, una por mano, y nunca se añaden al mazo global. Todas las personas juegan y votan; las respuestas no revelan a sus autores hasta cerrar la votación y los votos permanecen ocultos hasta que todo el mundo haya votado. Si hay empate, se repite el voto entre las respuestas empatadas en una **votación súbita**; si persiste, todas las respuestas empatadas suman un punto. Cada jugador puede cambiar una carta de su mano por ronda antes de responder, y recupera su oportunidad en la ronda siguiente. Las cartas que ya recibió un jugador, incluidas las jugadas y las cambiadas, no se le vuelven a repartir durante esa partida. Cada mano se repone hasta siete cartas en cuanto se juega una respuesta; si se agotan las cartas blancas nuevas, la operación informa del agotamiento en lugar de repartir un duplicado. Al cerrar la última ronda, la sala pasa a `finished` y muestra el ganador y la clasificación final.

Cuñadómetro mantiene sus salas, puntuaciones, respuestas y consignas en tablas separadas de las partidas de cartas. Las consignas activas se leen desde `cunadometro_prompts`; el juego selecciona de forma aleatoria y no repite ninguna dentro de una partida. La secuencia es: respuestas de los duelos de la primera mitad, presentación y votación de cada duelo, ronda general y clasificación intermedia; después, el mismo número de duelos por persona en la segunda mitad y una ronda general final. En los duelos responden dos participantes y vota el resto; en las generales responde y vota todo el grupo. Los empates otorgan un punto a cada respuesta más votada.
