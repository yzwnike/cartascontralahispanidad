import { useEffect, useState, type SubmitEvent } from 'react';
import {
  createCunadometroRoom,
  getCunadometroRoom,
  joinCunadometroRoom,
  leaveCunadometroRoom,
  nextCunadometroRound,
  startCunadometroRoom,
  submitCunadometroAnswer,
  voteCunadometroAnswer,
  type CunadometroRoom,
  type CunadometroSession,
} from '../lib/cunadometro';
import { GameApiError } from '../lib/game';

const SESSION_KEY = 'cunadometro-session';

function ModeMark({ mode }: { mode: 'duel' | 'all_play' }) {
  return <span className={`mode-mark ${mode === 'duel' ? 'mode-mark-duel' : 'mode-mark-group'}`}>{mode === 'duel' ? 'VS' : '✳'}</span>;
}

export default function CunadometroApp() {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [session, setSession] = useState<CunadometroSession | null>(null);
  const [room, setRoom] = useState<CunadometroRoom | null>(null);
  const [roundsLimit, setRoundsLimit] = useState<5 | 10 | 20>(10);
  const [answerText, setAnswerText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const me = room?.players.find((player) => player.id === session?.playerId);
  const round = room?.round ?? null;
  const inDuel = round?.mode === 'duel' && Boolean(session && round.duelPlayerIds.includes(session.playerId));
  const hasAnswered = Boolean(round?.myAnswerId);
  const canAnswer = round?.status === 'answering' && (round.mode === 'all_play' || inDuel) && !hasAnswered;
  const canVote = round?.status === 'voting'
    && !round.myVoteId
    && (round.mode === 'all_play' || !inDuel);

  useEffect(() => {
    const saved = window.localStorage.getItem(SESSION_KEY);
    if (!saved) return;
    try {
      const restored = JSON.parse(saved) as CunadometroSession;
      if (!restored.room?.code || !restored.playerId || !restored.playerToken) throw new Error('Invalid session');
      setSession(restored);
      setRoom(restored.room);
      setName(restored.room.players.find((player) => player.id === restored.playerId)?.name ?? '');
      void getCunadometroRoom(restored.room.code, restored.playerId, restored.playerToken)
        .then((result) => setRoom(result.room))
        .catch((restoreError) => {
          if (restoreError instanceof GameApiError && [403, 404].includes(restoreError.status)) {
            window.localStorage.removeItem(SESSION_KEY);
            setSession(null);
            setRoom(null);
            setError('La sala ya no existe o tu jugador ya no está en ella.');
          } else {
            setError(restoreError instanceof Error ? restoreError.message : 'No se pudo recuperar la sesión.');
          }
        });
    } catch {
      window.localStorage.removeItem(SESSION_KEY);
    }
  }, []);

  useEffect(() => {
    if (!session || !room) return;
    const timer = window.setInterval(() => {
      void getCunadometroRoom(room.code, session.playerId, session.playerToken)
        .then((result) => setRoom(result.room))
        .catch((syncError) => {
          if (syncError instanceof GameApiError && syncError.status === 403) {
            window.localStorage.removeItem(SESSION_KEY);
            setSession(null);
            setRoom(null);
            setError('Tu sesión ya no forma parte de esta sala.');
          }
        });
    }, 1400);
    return () => window.clearInterval(timer);
  }, [room?.code, session?.playerId, session?.playerToken]);

  useEffect(() => {
    setAnswerText('');
  }, [round?.number]);

  function storeSession(next: CunadometroSession) {
    setSession(next);
    setRoom(next.room);
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  }

  async function enterRoom(event: SubmitEvent<HTMLFormElement>, action: 'create' | 'join') {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      const result = action === 'create'
        ? await createCunadometroRoom(name)
        : await joinCunadometroRoom(code, name);
      storeSession(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo abrir la sala.');
    } finally {
      setPending(false);
    }
  }

  async function createRoomNow() {
    setError('');
    setPending(true);
    try {
      storeSession(await createCunadometroRoom(name));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo abrir la sala.');
    } finally {
      setPending(false);
    }
  }

  async function perform(action: () => Promise<{ room: CunadometroRoom }>) {
    if (!session) return;
    setError('');
    setPending(true);
    try {
      const result = await action();
      setRoom(result.room);
      setSession((current) => current ? { ...current, room: result.room } : current);
      window.localStorage.setItem(SESSION_KEY, JSON.stringify({ ...session, room: result.room }));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'No se pudo completar la jugada.');
    } finally {
      setPending(false);
    }
  }

  async function copyRoomCode() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('No se pudo copiar el código. Compártelo manualmente.');
    }
  }

  async function exitRoom() {
    if (room?.status === 'playing') {
      setError('La partida está en curso. Al volver, podrás continuar desde este dispositivo.');
      return;
    }
    if (room && session) {
      try {
        await leaveCunadometroRoom(room.code, session.playerId, session.playerToken);
      } catch (leaveError) {
        setError(leaveError instanceof Error ? leaveError.message : 'No se pudo salir de la sala.');
        return;
      }
    }
    window.localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setRoom(null);
    setError('');
  }

  if (!room || !session) {
    return (
      <main className="cu-app">
        <a className="cu-back" href="/">← SALA DE JUEGOS</a>
        <section className="cu-intro">
          <div className="cu-logo"><span>CUÑA</span><i>✳</i></div>
          <p className="cu-kicker">INGENIO, PIQUE Y UN POCO DE CARA</p>
          <h1>¿Quién tiene<br /><span>la mejor salida?</span></h1>
          <p className="cu-copy">Duelos de ocurrencias y retos para que todo el grupo se venga arriba. Mínimo 3 personas.</p>
        </section>
        <section className="cu-lobby">
          <label htmlFor="cu-name">TU ALIAS</label>
          <input id="cu-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={20} placeholder="Ej. La reina del tardeo" />
          <button className="cu-primary" disabled={pending || !name.trim()} onClick={() => void createRoomNow()}>
            {pending ? 'ABRIENDO…' : 'CREAR SALA'} <span>↗</span>
          </button>
          <div className="cu-divider"><span>O ENTRA EN UNA SALA</span></div>
          <form onSubmit={(event) => void enterRoom(event, 'join')}>
            <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={6} placeholder="CÓDIGO" aria-label="Código de sala" />
            <button className="cu-secondary" disabled={pending || !name.trim() || code.trim().length !== 6}>UNIRME</button>
          </form>
          {error && <p className="cu-error" role="alert">{error}</p>}
        </section>
        <footer className="cu-footer"><a href="/">← OTROS JUEGOS</a><span>CONSIGNAS ORIGINALES · RISA EN GRUPO</span></footer>
      </main>
    );
  }

  if (!me) {
    return <main className="cu-app"><p className="cu-error">Tu sesión ya no aparece en esta sala.</p><button className="cu-secondary" onClick={exitRoom}>Volver</button></main>;
  }

  if (room.status === 'waiting') {
    return (
      <main className="cu-app cu-room-view">
        <header className="cu-game-header">
          <a className="cu-mini-logo" href="/">CUÑA<span>✳</span></a>
          <button className="cu-code-pill" onClick={() => void copyRoomCode()}>{copied ? 'COPIADO' : 'SALA'} <strong>{room.code}</strong> ⧉</button>
        </header>
        <section className="cu-waiting">
          <p className="cu-kicker">LA MESA ESTÁ SERVIDA</p>
          <h1>Reúne a tu<br /><span>equipo de opinión.</span></h1>
          <p className="cu-copy">Comparte el código y esperad a tener al menos tres personas.</p>
          <div className="cu-roster">
            {room.players.map((player, index) => (
              <div className="cu-person" key={player.id} style={{ animationDelay: `${index * 70}ms` }}>
                <span className={`cu-avatar cu-avatar-${index % 4}`}>{player.name.charAt(0).toUpperCase()}</span>
                <span>{player.name}{player.id === me.id ? ' (tú)' : ''}</span>
                {player.isHost && <small>ANFITRIÓN/A</small>}
              </div>
            ))}
            {room.players.length < 3 && <div className="cu-person cu-person-wait"><span className="cu-avatar">＋</span><span>Falta gente para el primer duelo</span></div>}
          </div>
          {me.isHost ? (
            <div className="cu-round-picker">
              <span>RONDAS</span>
              <div>{([5, 10, 20] as const).map((count) => <button key={count} className={roundsLimit === count ? 'active' : ''} onClick={() => setRoundsLimit(count)}>{count}</button>)}</div>
              <button className="cu-primary" disabled={pending || room.players.length < 3} onClick={() => void perform(() => startCunadometroRoom(room.code, me.id, session.playerToken, roundsLimit))}>
                EMPEZAR PARTIDA <span>→</span>
              </button>
            </div>
          ) : <p className="cu-wait-note"><i></i> Esperando a que el anfitrión empiece…</p>}
          {error && <p className="cu-error" role="alert">{error}</p>}
        </section>
        <footer className="cu-footer"><button onClick={() => void exitRoom()}>SALIR</button><span>CUÑADÓMETRO · MADE BY YAZAWA</span></footer>
      </main>
    );
  }

  if (room.status === 'finished') {
    const ranking = [...room.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const highest = ranking[0]?.score ?? 0;
    const champions = ranking.filter((player) => player.score === highest);
    return (
      <main className="cu-app cu-room-view cu-results">
        <header className="cu-game-header"><a className="cu-mini-logo" href="/">CUÑA<span>✳</span></a><span className="cu-kicker">PARTIDA TERMINADA</span></header>
        <section className="cu-waiting">
          <div className="cu-trophy">✦</div>
          <p className="cu-kicker">VEREDICTO DEL GRUPO</p>
          <h1>{champions.length > 1 ? 'Empate de' : 'La última palabra'}<br /><span>{champions.map((player) => player.name).join(' · ')}</span></h1>
          <div className="cu-ranking">{ranking.map((player, index) => <div className="cu-rank-row" key={player.id}><b>{String(index + 1).padStart(2, '0')}</b><span className={`cu-avatar cu-avatar-${index % 4}`}>{player.name.charAt(0)}</span><strong>{player.name}</strong><em>{player.score} PTS</em></div>)}</div>
          <button className="cu-primary" onClick={() => void exitRoom()}>VOLVER AL SELECTOR <span>↗</span></button>
        </section>
      </main>
    );
  }

  if (!round) return <main className="cu-app"><p className="cu-error">Cargando la ronda…</p></main>;

  const title = round.mode === 'duel' ? 'DUELO ALEATORIO' : 'TODO EL GRUPO JUEGA';
  const answerLength = answerText.trim().length;

  return (
    <main className="cu-app cu-room-view cu-playing">
      <header className="cu-game-header">
        <a className="cu-mini-logo" href="/">CUÑA<span>✳</span></a>
        <button className="cu-code-pill" onClick={() => void copyRoomCode()}>{copied ? 'COPIADO' : room.code}</button>
        <span className="cu-round-count">{round.number}<small> / {room.roundsLimit}</small></span>
      </header>
      <div className="cu-progress"><span style={{ width: `${round.number / room.roundsLimit * 100}%` }} /></div>
      <section className="cu-play-area">
        <div className="cu-mode-label"><ModeMark mode={round.mode} /><span>{title}</span></div>
        {round.mode === 'duel' && (
          <div className="cu-duelists">
            {round.duelPlayerIds.map((id) => {
              const contestant = room.players.find((player) => player.id === id);
              return <span key={id}>{contestant?.name ?? 'Jugador/a'}{id === me.id ? ' · TÚ' : ''}</span>;
            })}
            <i>VS</i>
          </div>
        )}
        <article className="cu-prompt" key={`${round.number}-${round.prompt}`}>
          <span>CONSIGNA {String(round.number).padStart(2, '0')}</span>
          <h1>{round.prompt}</h1>
        </article>

        {canAnswer && (
          <form className="cu-answer-form" onSubmit={(event) => {
            event.preventDefault();
            if (!pending && answerLength >= 2) void perform(() => submitCunadometroAnswer(room.code, me.id, session.playerToken, answerText));
          }}>
            <label htmlFor="cu-answer">{round.mode === 'duel' ? 'TU REMATE' : 'TU RESPUESTA'}</label>
            <textarea id="cu-answer" value={answerText} onChange={(event) => setAnswerText(event.target.value)} maxLength={180} placeholder="Que se note que has pensado lo justo…" />
            <div className="cu-answer-actions"><span>{answerLength}/180 · nadie la verá hasta que acabe el grupo</span><button className="cu-primary" disabled={pending || answerLength < 2}>ENVIAR <span>↗</span></button></div>
          </form>
        )}

        {round.status === 'answering' && !canAnswer && (
          <div className="cu-wait-card">
            <span className="cu-spinner"></span>
            <strong>{hasAnswered ? 'Respuesta enviada. Que nadie mire.' : 'Esta vez te toca de público.'}</strong>
            <span>{round.submittedCount}/{round.mode === 'duel' ? 2 : room.players.length} respuestas en secreto</span>
          </div>
        )}

        {round.status === 'voting' && (
          <>
            <div className="cu-stage-heading"><strong>{round.mode === 'duel' ? 'EL PÚBLICO DECIDE' : 'VOTA LA MÁS BRILLANTE'}</strong><span>{round.answers.length} RESPUESTAS</span></div>
            <div className="cu-answers">
              {round.answers.map((answer, index) => (
                <button className={`cu-answer-card ${round.myVoteId === answer.id ? 'is-voted' : ''}`} key={answer.id} disabled={!canVote} onClick={() => void perform(() => voteCunadometroAnswer(room.code, me.id, session.playerToken, answer.id))}>
                  <small>IDEA {String(index + 1).padStart(2, '0')}</small><strong>{answer.text}</strong>
                  {canVote && <span>VOTAR ESTA <b>↗</b></span>}
                </button>
              ))}
            </div>
            <p className="cu-vote-note">{round.myVoteId ? 'Voto secreto enviado · esperando al resto.' : canVote ? 'Vota una respuesta; el resultado se revela al final.' : 'Quienes responden no votan esta ronda.'} {round.votesSubmittedCount}/{round.eligibleVoterCount}</p>
          </>
        )}

        {round.status === 'resolved' && (
          <>
            <div className="cu-stage-heading"><strong>EL GRUPO HA HABLADO</strong><span>VOTOS REVELADOS</span></div>
            <div className="cu-answers">
              {round.answers.map((answer, index) => {
                const author = room.players.find((player) => player.id === answer.playerId);
                const votes = round.voteCounts[answer.id] ?? 0;
                const voters = round.publicVotes.filter((vote) => vote.answerId === answer.id);
                return <article className={`cu-answer-card cu-result-card ${answer.isWinner ? 'is-winner' : ''}`} key={answer.id}>
                  <small>IDEA {String(index + 1).padStart(2, '0')} · {author?.name ?? 'Jugador/a'}</small>
                  <strong>{answer.text}</strong>
                  <span>{answer.isWinner ? '✦ SE LLEVA EL PUNTO' : 'FINA OBSERVACIÓN'} · {votes} {votes === 1 ? 'VOTO' : 'VOTOS'}</span>
                  <div className="cu-voter-list">{voters.map((vote) => <i key={vote.voterId}>{vote.voterName}</i>)}</div>
                </article>;
              })}
            </div>
            {me.isHost
              ? <button className="cu-primary cu-next" disabled={pending} onClick={() => void perform(() => nextCunadometroRound(room.code, me.id, session.playerToken))}>{round.number === room.roundsLimit ? 'VER CLASIFICACIÓN' : 'SIGUIENTE RONDA'} <span>→</span></button>
              : <p className="cu-wait-note"><i></i> Esperando a que el anfitrión pase de ronda…</p>}
          </>
        )}
        {error && <p className="cu-error" role="alert">{error}</p>}
      </section>
      <section className="cu-score-strip">
        {room.players.map((player, index) => <div key={player.id}><span className={`cu-avatar cu-avatar-${index % 4}`}>{player.name.charAt(0)}</span><span>{player.name}{player.id === me.id ? ' (tú)' : ''}</span><b>{player.score}</b></div>)}
      </section>
      <footer className="cu-footer"><span>PARTIDA EN CURSO · VUELVE A ESTA PANTALLA PARA CONTINUAR</span><span>CONSIGNA ORIGINAL · MADE BY YAZAWA</span></footer>
    </main>
  );
}
