# Cartas Caos

## Conectar Neon

1. En Neon, abre **SQL Editor** y ejecuta [`db/schema.sql`](./db/schema.sql). El script añade las columnas de ronda, las tablas de votos y cartas personalizadas, y carga un mazo inicial sin duplicar cartas ya presentes.
2. Para desarrollo local, copia [`.env.example`](./.env.example) a `.env` en la raíz y rellena `DATABASE_URL` con la cadena PostgreSQL de Neon. Conserva `sslmode=require`.
3. Genera un secreto de sesión localmente, sin compartirlo:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Pega el resultado en `PLAYER_TOKEN_SECRET` dentro de `.env`.
4. Ejecuta `npm run dev` para desarrollo. `npm run build` genera la salida compatible con Vercel.

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
- `POST /api/rooms/:code/submissions` juega la cantidad de cartas indicada por la negra y repone inmediatamente la mano hasta siete cartas.
- `POST /api/rooms/:code/vote` registra el voto; nadie puede votar su propia respuesta.
- `POST /api/rooms/:code/next` abre la siguiente ronda cuando se resuelve la votación.
- `DELETE /api/rooms/:code/players/:playerId` abandona la sala.

Las operaciones de estado usan transacciones y requieren el token de sesión que reciben los endpoints de creación/unión. La interfaz consulta el estado de la sala periódicamente para sincronizar a los participantes. Antes de empezar, cada persona escribe una carta blanca exclusiva de esa partida y marca que está lista; el anfitrión puede iniciar cuando todo el mundo esté listo. Todas las cartas personalizadas se reparten al comienzo a otro jugador, una por mano, y nunca se añaden al mazo global. Todas las personas juegan y votan; las respuestas no revelan a sus autores hasta cerrar la votación. En cuanto se registra un voto, se muestra en directo quién lo ha emitido, a qué respuesta y el recuento actualizado. Si hay empate, se repite el voto entre las respuestas empatadas en una **votación súbita**; si persiste, todas las respuestas empatadas suman un punto. Cada mano se repone hasta siete cartas en cuanto se juega una respuesta. Al cerrar la última ronda, la sala pasa a `finished` y muestra el ganador y la clasificación final.
