import { useState, type SubmitEvent } from 'react';
import GameArena from './GameArena';
import { createRoom, joinRoom, type GameRoom } from '../lib/game';

export default function RoomLobby() {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [room, setRoom] = useState<GameRoom | null>(null);
  const [playerId, setPlayerId] = useState('');
  const [playerToken, setPlayerToken] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function handleCreateRoom(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const playerName = name.trim();
    if (!playerName) {
      setError('Escribe un nombre para que tu gente sepa quién la ha liado.');
      return;
    }

    setPending(true);
    setError('');
    try {
      const result = await createRoom(playerName);
      setRoom(result.room);
      setPlayerId(result.playerId);
      setPlayerToken(result.playerToken);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo crear la sala.');
    } finally {
      setPending(false);
    }
  }

  async function handleJoinRoom(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const playerName = name.trim();
    const roomCode = code.trim();
    if (!playerName) {
      setError('Escribe tu nombre antes de entrar en la sala.');
      return;
    }
    setPending(true);
    setError('');
    try {
      const result = await joinRoom(roomCode, playerName);
      setRoom(result.room);
      setPlayerId(result.playerId);
      setPlayerToken(result.playerToken);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo entrar en la sala.');
    } finally {
      setPending(false);
    }
  }

  if (room && playerId) {
    return <GameArena
      initialRoom={room}
      playerId={playerId}
      playerToken={playerToken}
      onLeave={() => { setRoom(null); setPlayerId(''); setPlayerToken(''); }}
    />;
  }

  return (
    <section className="lobby-card" aria-label="Crear o unirse a una sala">
      <div className="lobby-heading">
        <div>
          <p className="section-kicker">TU PARTIDA EMPIEZA AQUÍ</p>
          <h2>¿Quién se apunta?</h2>
        </div>
        <span className="lobby-symbol" aria-hidden="true">✳</span>
      </div>
      <label className="field-label" htmlFor="player-name">TU ALIAS</label>
      <input
        id="player-name"
        className="text-input"
        maxLength={20}
        placeholder="Ej. La Juani del grupo"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="lobby-actions">
        <form onSubmit={handleCreateRoom}>
          <button className="button button-primary" type="submit" disabled={pending}>
            <span>＋</span> Crear partida
          </button>
        </form>
        <div className="join-form">
          <form onSubmit={handleJoinRoom}>
            <label className="field-label" htmlFor="room-code">¿TIENES CÓDIGO?</label>
            <div className="join-controls">
              <input
                id="room-code"
                className="text-input code-input"
                maxLength={3}
                inputMode="numeric"
                pattern="[0-9]{3}"
                placeholder="123"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 3))}
                aria-label="Código de sala"
              />
              <button className="button button-secondary" type="submit" disabled={pending || !/^\d{3}$/.test(code)}>Unirme <span>→</span></button>
            </div>
          </form>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="lobby-hint"><span>ⓘ</span> Las salas se guardan en Neon y puedes unirte desde cualquier dispositivo.</p>
    </section>
  );
}
