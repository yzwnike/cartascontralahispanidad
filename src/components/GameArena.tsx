import { useEffect, useState, type CSSProperties } from 'react';
import {
  getRoom,
  leaveRoom as leaveRoomRequest,
  nextRound as nextRoundRequest,
  startRoom as startRoomRequest,
  submitCards as submitCardsRequest,
  voteForSubmission as voteForSubmissionRequest,
  type GameRoom,
} from '../lib/game';

type Props = {
  initialRoom: GameRoom;
  playerId: string;
  playerToken: string;
  onLeave: () => void;
};

export default function GameArena({ initialRoom, playerId, playerToken, onLeave }: Props) {
  const [room, setRoom] = useState(initialRoom);
  const [selectedCards, setSelectedCards] = useState<number[]>([]);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [roundsLimit, setRoundsLimit] = useState<5 | 10 | 20>(initialRoom.roundsLimit);
  const player = room.players.find((item) => item.id === playerId);
  const allResponsesIn = room.submittedCount === room.players.length && room.players.length >= 2;
  const hasSubmitted = room.mySubmissionId !== null;
  const canVote = allResponsesIn
    && (room.status === 'judging' || room.status === 'sudden_vote')
    && room.myVoteId === null
    && room.winnerIds.length === 0;

  useEffect(() => {
    let active = true;
    const syncRoom = async () => {
      try {
        const result = await getRoom(room.code, playerId, playerToken);
        if (active) {
          setRoom(result.room);
          setSyncError('');
        }
      } catch (error) {
        if (active) setSyncError(error instanceof Error ? error.message : 'No se pudo actualizar la sala.');
      }
    };
    const interval = window.setInterval(() => { void syncRoom(); }, 1200);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [room.code, playerId, playerToken]);

  if (!player) {
    return (
      <section className="game-shell">
        <p className="form-error">Tu jugador ya no aparece en esta sala.</p>
        <button className="button button-secondary" onClick={onLeave}>Volver al inicio</button>
      </section>
    );
  }

  async function runAction(action: () => Promise<{ room: GameRoom }>) {
    setActionError('');
    try {
      const result = await action();
      setRoom(result.room);
      setSelectedCards([]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'No se pudo completar la acción.');
    }
  }

  function toggleCard(index: number) {
    setSelectedCards((current) => {
      if (current.includes(index)) return current.filter((selected) => selected !== index);
      if (current.length >= room.pick) return current;
      return [...current, index];
    });
  }

  async function submitCard() {
    if (!player || selectedCards.length !== room.pick || hasSubmitted || room.status !== 'playing') return;
    const cards = selectedCards.map((index) => player.hand[index]);
    await runAction(() => submitCardsRequest(room.code, playerId, playerToken, cards));
  }

  async function voteForSubmission(submissionId: string) {
    await runAction(() => voteForSubmissionRequest(room.code, playerId, playerToken, submissionId));
  }

  async function startNextRound() {
    await runAction(() => nextRoundRequest(room.code, playerId, playerToken));
  }

  async function startGame() {
    await runAction(() => startRoomRequest(room.code, playerId, playerToken, roundsLimit));
  }

  async function leaveCurrentRoom() {
    setActionError('');
    try {
      await leaveRoomRequest(room.code, playerId, playerToken);
      onLeave();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'No se pudo salir de la sala.');
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'No se pudo copiar el código de sala.');
    }
  }

  if (room.status === 'waiting') {
    return (
      <section className="game-shell lobby-shell" aria-label="Sala de espera">
        <header className="game-hud">
          <button className="brand game-brand" onClick={leaveCurrentRoom} aria-label="Salir de la sala">
            <span className="brand-mark">CC</span><span>CARTAS<span className="brand-accent">CAOS</span></span>
          </button>
          <button className="room-code-button" onClick={copyCode} title="Copiar código de sala">
            CÓDIGO <strong>{room.code}</strong> <span>{copied ? 'COPIADO' : '⧉'}</span>
          </button>
          <span className="connection-note"><span className="status-dot"></span> EN VIVO</span>
        </header>

        <div className="waiting-content">
          <div className="waiting-orbit" aria-hidden="true"><span>✳</span><i></i><i></i><i></i></div>
          <p className="section-kicker">LOBBY DE LA MOVIDA</p>
          <h1>La partida empieza<br /><span>cuando tú quieras.</span></h1>
          <p className="waiting-copy">Pasa el código al grupo. Cuando estén todos dentro, dale al botón y que empiece el salseo.</p>
          <div className="waiting-roster">
            <div className="roster-heading"><span>EN LA SALA</span><strong>{room.players.length} {room.players.length === 1 ? 'JUGADOR' : 'JUGADORES'}</strong></div>
            <ul className="player-list">
              {room.players.map((item, index) => (
                <li className={`player-row ${item.id === playerId ? 'is-you' : ''}`} key={item.id}>
                  <span className={`player-avatar avatar-${index % 4}`}>{item.name.trim().charAt(0).toUpperCase()}</span>
                  <span className="player-info"><strong>{item.name}{item.id === playerId ? ' (tú)' : ''}</strong><small>{item.isHost ? 'ANFITRIÓN/A' : 'LISTO/A'}</small></span>
                  <span className="roster-check" aria-label="Conectado">✓</span>
                </li>
              ))}
            </ul>
            <p className="waiting-pulse"><span className="status-dot"></span> Esperando a que se una tu gente...</p>
          </div>
          {player.isHost ? (
            <>
              <fieldset className="rounds-picker">
                <legend>ELIGE LA DURACIÓN DE LA PARTIDA</legend>
                <div className="round-options">
                  {([5, 10, 20] as const).map((count) => (
                    <button
                      type="button"
                      key={count}
                      aria-pressed={roundsLimit === count}
                      className={`round-option ${roundsLimit === count ? 'round-option-selected' : ''}`}
                      onClick={() => setRoundsLimit(count)}
                    >
                      <strong>{count}</strong><span>RONDAS</span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <button className="button button-primary start-game-button" disabled={room.players.length < 2} onClick={() => void startGame()}>
                Empezar partida · {roundsLimit} rondas <span>→</span>
              </button>
              {room.players.length < 2 && <p className="lobby-hint"><span>✦</span> Hace falta que se una otra persona para poder votar.</p>}
            </>
          ) : (
            <div className="host-wait-note"><span className="status-dot"></span> El anfitrión empieza cuando estéis listos</div>
          )}
          {actionError && <p className="form-error" role="alert">{actionError}</p>}
        </div>
        <div className="game-footnote"><span>Las nuevas incorporaciones se cierran cuando empiece la partida.</span><button onClick={() => void leaveCurrentRoom()}>Salir de la sala</button></div>
      </section>
    );
  }

  if (room.status === 'finished') {
    const ranking = [...room.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const highestScore = ranking[0]?.score ?? 0;
    const champions = ranking.filter((item) => item.score === highestScore);

    return (
      <section className="game-shell results-shell" aria-label="Resultados finales">
        <div className="confetti-field" aria-hidden="true">
          {Array.from({ length: 42 }, (_, index) => (
            <i
              key={index}
              style={{
                left: `${(index * 47 + 13) % 100}%`,
                animationDelay: `${(index % 13) * -0.37}s`,
                animationDuration: `${5 + (index % 7) * 0.65}s`,
                '--confetti-hue': `${(index * 41) % 360}`,
              } as CSSProperties & { '--confetti-hue': string }}
            />
          ))}
        </div>
        <header className="game-hud results-hud">
          <span className="brand"><span className="brand-mark">CC</span><span>CARTAS<span className="brand-accent">CAOS</span></span></span>
          <span className="results-rounds">{room.roundsLimit} RONDAS · SALA {room.code}</span>
        </header>
        <div className="results-content">
          <div className="trophy-emblem" aria-hidden="true"><span>♛</span><i></i><i></i></div>
          <p className="section-kicker">FIN DE LA PARTIDA</p>
          <h1 className="results-title">{champions.length === 1 ? 'EL CAOS TIENE' : 'EMPATE DE'}<br /><span>{champions.length === 1 ? 'NUEVO REY' : 'LEYENDAS'}</span></h1>
          <p className="results-subtitle">{room.roundsLimit} rondas. Cero dignidad. Un grupo con mucho que hablar.</p>

          <section className="champion-card" aria-label="Ganador de la partida">
            <span className="champion-crown" aria-hidden="true">✦</span>
            <span className="champion-kicker">{champions.length === 1 ? 'CAMPEÓN/A ABSOLUTO/A' : 'CAMPEONES/AS · EMPATE'}</span>
            <div className="champion-avatars">
              {champions.map((item, index) => (
                <span className={`champion-avatar avatar-${index % 4}`} key={item.id}>{item.name.trim().charAt(0).toUpperCase()}</span>
              ))}
            </div>
            <h2>{champions.map((item) => item.name).join(' · ') || 'Sin ganador'}</h2>
            <span className="champion-score">{highestScore} <small>{highestScore === 1 ? 'PUNTO' : 'PUNTOS'}</small></span>
            <span className="champion-caption">EL HUMOR MÁS CUESTIONABLE DEL GRUPO</span>
          </section>

          <section className="final-ranking">
            <div className="ranking-heading"><span>CLASIFICACIÓN FINAL</span><span>PTS</span></div>
            <ol>
              {ranking.map((item, index) => (
                <li className={`ranking-row ${item.score === highestScore ? 'ranking-winner' : ''}`} key={item.id} style={{ animationDelay: `${450 + index * 110}ms` }}>
                  <span className={`ranking-place ${index < 3 ? `place-${index + 1}` : ''}`}>{index === 0 ? '✦' : String(index + 1).padStart(2, '0')}</span>
                  <span className={`ranking-avatar avatar-${index % 4}`}>{item.name.trim().charAt(0).toUpperCase()}</span>
                  <span className="ranking-name">{item.name}{item.id === playerId ? ' (tú)' : ''}</span>
                  <strong className="ranking-score">{item.score}</strong>
                </li>
              ))}
            </ol>
          </section>
          <button className="button button-primary results-exit" onClick={() => void leaveCurrentRoom()}>Volver al inicio <span>↗</span></button>
          {actionError && <p className="form-error" role="alert">{actionError}</p>}
        </div>
      </section>
    );
  }

  return (
    <section className="game-shell" aria-label="Partida en curso">
      <header className="game-hud">
        <button className="brand game-brand" onClick={leaveCurrentRoom} aria-label="Salir de la partida">
          <span className="brand-mark">CC</span><span>CARTAS<span className="brand-accent">CAOS</span></span>
        </button>
        <button className="room-code-button" onClick={copyCode} title="Copiar código de sala">
          SALA <strong>{room.code}</strong> <span>{copied ? 'COPIADO' : '⧉'}</span>
        </button>
        <div className="round-label">RONDA <strong>{String(room.round).padStart(2, '0')}</strong><span> / {room.roundsLimit}</span></div>
      </header>
      <div className="round-progress" aria-label={`Ronda ${room.round} de ${room.roundsLimit}`}><span style={{ width: `${(room.round / room.roundsLimit) * 100}%` }} /></div>

      <div className="game-layout">
        <aside className="players-panel">
          <div className="panel-title"><span>EN LA MOVIDA</span><span className="player-count">{room.players.length}</span></div>
          <ul className="player-list">
            {room.players.map((item, index) => (
              <li className={`player-row ${item.id === playerId ? 'is-you' : ''}`} key={item.id}>
                <span className={`player-avatar avatar-${index % 4}`}>{item.name.trim().charAt(0).toUpperCase()}</span>
                <span className="player-info"><strong>{item.name}{item.id === playerId ? ' (tú)' : ''}</strong><small>TODOS JUEGAN</small></span>
                <span className="player-score">{item.score}<small>PTS</small></span>
              </li>
            ))}
          </ul>
          <div className="judge-note"><span>✦</span> Todos responden. Todos votan.</div>
          <div className="connection-note"><span className={`status-dot ${syncError ? 'status-error' : ''}`}></span> {syncError ? 'REVISANDO CONEXIÓN' : 'NEON · EN LÍNEA'}</div>
        </aside>

        <div className="arena-main">
          <div className="arena-title"><span className="section-kicker">LA PLAZA</span><span className="phase-label">{room.winnerIds.length > 0 ? 'RONDA CERRADA' : room.status === 'sudden_vote' ? 'VOTACIÓN SÚBITA' : room.status === 'judging' ? 'VOTACIÓN ABIERTA' : hasSubmitted ? 'RESPUESTA ENVIADA' : 'ELIGE TU RESPUESTA'}</span></div>
          <article className="black-card" key={`${room.round}-${room.blackCard}`}>
            <span className="black-card-label">CARTA NEGRA <span>✳</span></span>
            <p>{room.blackCard}</p>
            <span className="black-card-foot">CARTAS CAOS — EDICIÓN ESPAÑA · JUGAD {room.pick}</span>
          </article>

          <section className={`responses ${room.status === 'sudden_vote' ? 'sudden-vote-round' : ''}`}>
            <div className="response-heading"><h3>{room.status === 'sudden_vote' ? 'Votación súbita' : allResponsesIn ? 'Respuestas anónimas' : 'Respuestas en secreto'}</h3><span>{room.submittedCount} / {room.players.length}</span></div>
            {!allResponsesIn ? (
              <div className="empty-table response-wait"><span className="waiting-spinner" aria-hidden="true"></span><strong>{room.submittedCount === 0 ? 'Las cartas siguen boca abajo' : `${room.submittedCount} respuesta${room.submittedCount === 1 ? '' : 's'} en secreto`}</strong><span>Nadie puede ver las respuestas hasta que termine todo el mundo.</span></div>
            ) : room.submissions.length === 0 ? (
              <div className="empty-table">Aún no hay respuestas para votar.</div>
            ) : (
              <div className="submission-grid" key={`submissions-${room.round}`}>
                {room.submissions.map((submission, index) => {
                  const owner = room.players.find((item) => item.id === submission.playerId);
                  const isWinner = owner ? room.winnerIds.includes(owner.id) : false;
                  const isOwn = submission.id === room.mySubmissionId;
                  const isVoteOption = room.voteOptions.includes(submission.id);
                  const voteCount = room.voteCounts[submission.id];
                  return (
                    <button
                      className={`submission-card ${isWinner ? 'winning-card' : ''} ${canVote && isVoteOption && !isOwn ? 'judge-pick vote-option' : ''} ${room.myVoteId === submission.id ? 'voted-card' : ''}`}
                      key={submission.id}
                      style={{ animationDelay: `${Math.min(index, 8) * 90}ms` }}
                      disabled={!canVote || !isVoteOption || isOwn}
                      onClick={() => void voteForSubmission(submission.id)}
                    >
                      <span className="submission-number">
                        RESPUESTA {String(index + 1).padStart(2, '0')}
                        {isWinner ? ' · GANADORA' : isOwn ? ' · TU RESPUESTA' : ''}
                        {voteCount !== undefined ? ` · ${voteCount} VOTO${voteCount === 1 ? '' : 'S'}` : ''}
                      </span>
                      <span>{submission.cards.join(' + ')}</span>
                      {room.winnerIds.length > 0 && <small>{isWinner ? `🏆 ${owner?.name} gana esta ronda` : `De ${owner?.name ?? 'jugador/a'}`}</small>}
                      {canVote && isVoteOption && !isOwn && <small>VOTAR POR ESTA · TOCA LA CARTA</small>}
                      {isOwn && room.status === 'sudden_vote' && <small>No puedes votar tu propia respuesta</small>}
                      {room.myVoteId === submission.id && <small>Tu voto está aquí</small>}
                    </button>
                  );
                })}
              </div>
            )}
            {allResponsesIn && room.winnerIds.length === 0 && (
              <p className="table-tip">
                {room.status === 'sudden_vote'
                  ? room.myVoteId ? 'Voto secreto enviado. Esperando al resto para resolver la votación súbita.' : '¡Empate! Vuelve a votar entre las respuestas empatadas.'
                  : room.myVoteId ? `Voto secreto enviado · ${room.votesSubmittedCount}/${room.eligibleVoterCount} han votado.` : 'Vota en secreto por la respuesta que más te haya hecho gracia. La tuya no se puede votar.'}
              </p>
            )}
            {room.winnerIds.length > 0 && <button className="button button-primary next-round" onClick={() => void startNextRound()}>¡Otra ronda, venga! <span>→</span></button>}
          </section>
        </div>
      </div>

      <section className="hand-section">
        <div className="hand-heading"><div><span className="section-kicker">TU MANO</span><h3>{hasSubmitted ? 'Mano repuesta · ya puedes votar' : room.status === 'playing' ? `Elige ${room.pick} carta${room.pick === 1 ? '' : 's'} blanca${room.pick === 1 ? '' : 's'}` : 'Esperando a la siguiente ronda'}</h3></div><span className="hand-count">{player.hand.length} / 7 CARTAS</span></div>
        <div className="hand-cards">
          {player.hand.map((card, index) => (
            <button
              type="button"
              className={`hand-card ${selectedCards.includes(index) ? 'selected-card' : ''}`}
              key={`${card}-${index}`}
              onClick={() => toggleCard(index)}
              disabled={hasSubmitted || room.status !== 'playing'}
              aria-pressed={selectedCards.includes(index)}
            >
              <span className="hand-card-index">CARTA {String(index + 1).padStart(2, '0')}</span>{card}
            </button>
          ))}
        </div>
        <div className="hand-footer">
          <span>{hasSubmitted ? 'Has recibido una carta nueva por cada carta jugada.' : selectedCards.length === room.pick ? 'Selección lista para jugar' : `Selecciona ${room.pick - selectedCards.length} carta${room.pick - selectedCards.length === 1 ? '' : 's'} más`}</span>
          <button className="button button-primary submit-button" disabled={selectedCards.length !== room.pick || room.status !== 'playing'} onClick={() => void submitCard()}>Jugar carta <span>↗</span></button>
        </div>
      </section>
      {(actionError || syncError) && <p className="form-error" role="alert">{actionError || syncError}</p>}
      <div className="game-footnote"><span>Partida sincronizada con Neon · puedes jugar desde cualquier dispositivo.</span><button onClick={() => void leaveCurrentRoom()}>Salir de la sala</button></div>
      <span className="sr-only" aria-live="polite">{room.submittedCount} respuestas enviadas</span>
    </section>
  );
}
