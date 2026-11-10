import 'dotenv/config';
import postgres, { type Sql } from 'postgres';

let client: Sql | undefined;

export function getDb(): Sql {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Falta DATABASE_URL. Añade la cadena de conexión de Neon al archivo .env.');
  }

  if (!client) {
    client = postgres(connectionString, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: 'require',
      onnotice: () => {},
    });
  }

  return client;
}
