import { useEffect, useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import { gsap } from 'gsap';
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
import { duelsPerPlayer, totalGameRounds } from '../lib/cunadometro-length';
import { GameApiError } from '../lib/game';

const SESSION_KEY = 'cunadometro-session';
const DUEL_REVEAL_DURATION_MS = 6100;

function getStoredSessionCredentials(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const stored = value as Record<string, unknown>;
  const room = stored.room;
  if (!room || typeof room !== 'object') return null;
  const roomCode = (room as Record<string, unknown>).code;
  if (
    typeof roomCode !== 'string'
    || !/^[A-Z2-9]{6}$/i.test(roomCode)
    || typeof stored.playerId !== 'string'
    || !stored.playerId
    || typeof stored.playerToken !== 'string'
    || !stored.playerToken
  ) return null;
  return { roomCode, playerId: stored.playerId, playerToken: stored.playerToken };
}

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
  const [duelAnswers, setDuelAnswers] = useState<Record<number, string>>({});
  const [revealElapsed, setRevealElapsed] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const promptRef = useRef<HTMLElement | null>(null);
  const answerRefs = useRef(new Map<string, HTMLButtonElement>());
  const scoreStripRef = useRef<HTMLElement | null>(null);
  const phaseBannerRef = useRef<HTMLDivElement | null>(null);
  const duelTaskListRef = useRef<HTMLDivElement | null>(null);

  const me = room?.players.find((player) => player.id === session?.playerId);
  const round = room?.round ?? null;
  const inDuel = round?.mode === 'duel' && Boolean(session && round.duelPlayerIds.includes(session.playerId));
  const hasAnswered = Boolean(round?.myAnswerId);
  const revealDelay = round?.mode === 'duel'
    ? DUEL_REVEAL_DURATION_MS
    : Math.max(1500, (round?.answers.length ?? 0) * 180 + 900);
  const revealReady = revealElapsed >= revealDelay + 500;
  const canAnswer = round?.status === 'answering' && (round.mode === 'all_play' || inDuel) && !hasAnswered;
  const canVote = round?.status === 'voting'
    && revealReady
    && !round.myVoteId
    && (round.mode === 'all_play' || !inDuel);

  useEffect(() => {
    const saved = window.localStorage.getItem(SESSION_KEY);
    if (!saved) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(saved);
    } catch {
      window.localStorage.removeItem(SESSION_KEY);
      return;
    }
    const credentials = getStoredSessionCredentials(parsed);
    if (!credentials) {
      window.localStorage.removeItem(SESSION_KEY);
      return;
    }

    void getCunadometroRoom(credentials.roomCode, credentials.playerId, credentials.playerToken)
      .then(({ room: restoredRoom }) => {
        if (!Array.isArray(restoredRoom.players) || !restoredRoom.players.some((player) => player.id === credentials.playerId)) {
          throw new Error('La sesión guardada no coincide con los datos actuales de la sala.');
        }
        const restoredSession = { ...credentials, room: restoredRoom };
        window.localStorage.setItem(SESSION_KEY, JSON.stringify(restoredSession));
        setSession(restoredSession);
        setRoom(restoredRoom);
        setName(restoredRoom.players.find((player) => player.id === credentials.playerId)?.name ?? '');
      })
      .catch((restoreError) => {
        if (restoreError instanceof GameApiError && [401, 403, 404].includes(restoreError.status)) {
          window.localStorage.removeItem(SESSION_KEY);
          setError('La sala ya no existe o tu sesión ha caducado. Vuelve a unirte.');
        } else {
          setError(restoreError instanceof Error ? restoreError.message : 'No se pudo recuperar la sesión.');
        }
      });
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

  useEffect(() => {
    if (!round?.revealStartedAt || round.status !== 'voting') {
      setRevealElapsed(0);
      return;
    }
    const revealAt = new Date(round.revealStartedAt).getTime();
    const updateElapsed = () => setRevealElapsed(Math.max(0, Date.now() - revealAt));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 100);
    return () => window.clearInterval(timer);
  }, [round?.number, round?.revealStartedAt, round?.status]);

  useLayoutEffect(() => {
    if (!round?.revealStartedAt || round.status !== 'voting' || !promptRef.current) return;
    const elapsed = Math.max(0, (Date.now() - new Date(round.revealStartedAt).getTime()) / 1000);
    const isDuel = round.mode === 'duel';
    const promptLiftAt = isDuel ? 2.65 : 0.95;
    const firstAnswerAt = isDuel ? 3.35 : 1.45;
    const answerGap = isDuel ? 2 : 0.18;
    const context = gsap.context(() => {
      const timeline = gsap.timeline();
      timeline.to(promptRef.current, {
        y: -28,
        scale: 0.94,
        rotateX: 5,
        opacity: 0.68,
        duration: 0.72,
        ease: 'back.in(1.35)',
      }, Math.max(0, promptLiftAt - elapsed));
      round.answers.forEach((answer, index) => {
        const element = answerRefs.current.get(answer.id);
        if (!element) return;
        timeline.fromTo(element, {
          autoAlpha: 0,
          y: 34,
          scale: 0.82,
          rotate: index % 2 === 0 ? -3 : 3,
          transformOrigin: '50% 100%',
        }, {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          rotate: 0,
          duration: 0.62,
          ease: 'back.out(1.7)',
        }, Math.max(0, firstAnswerAt + index * answerGap - elapsed));
      });
    });
    return () => context.revert();
  }, [round?.number, round?.mode, round?.revealStartedAt, round?.status, round?.answers.map((answer) => answer.id).join(',')]);

  useLayoutEffect(() => {
    if (!phaseBannerRef.current || !duelTaskListRef.current) return;
    const context = gsap.context(() => {
      gsap.fromTo(phaseBannerRef.current, {
        autoAlpha: 0,
        x: -45,
        rotate: -3,
        scale: 0.94,
      }, {
        autoAlpha: 1,
        x: 0,
        rotate: 0,
        scale: 1,
        duration: 0.72,
        ease: 'back.out(1.7)',
      });
      gsap.fromTo('.cu-duel-task', {
        autoAlpha: 0,
        y: 38,
        rotateX: 9,
        scale: 0.94,
        transformOrigin: '50% 0%',
      }, {
        autoAlpha: 1,
        y: 0,
        rotateX: 0,
        scale: 1,
        duration: 0.68,
        stagger: 0.14,
        delay: 0.2,
        ease: 'back.out(1.45)',
      });
    }, duelTaskListRef);
    return () => context.revert();
  }, [room?.gameStage, round?.number, round?.myDuelTasks.map((task) => task.number).join(',')]);

  useLayoutEffect(() => {
    if (!scoreStripRef.current || round?.status !== 'resolved') return;
    const context = gsap.context(() => {
      gsap.fromTo('.cu-score-strip > div', {
        y: 18,
        scale: 0.85,
        autoAlpha: 0,
      }, {
        y: 0,
        scale: 1,
        autoAlpha: 1,
        duration: 0.55,
        stagger: 0.075,
        ease: 'back.out(1.8)',
      });
    }, scoreStripRef);
    return () => context.revert();
  }, [round?.number, round?.status, room?.players.map((player) => player.score).join(',')]);

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
              <span>ELIGE EL RITMO</span>
              <div className="cu-length-picker">
                {([
                  { value: 5, label: 'RÁPIDA' },
                  { value: 10, label: 'MEDIA' },
                  { value: 20, label: 'LARGA' },
                ] as const).map((length) => (
                  <button
                    key={length.value}
                    className={roundsLimit === length.value ? 'active' : ''}
                    onClick={() => setRoundsLimit(length.value)}
                  >{length.label}</button>
                ))}
              </div>
              <p className="cu-length-summary">
                {room.players.length >= 3
                  ? `${duelsPerPlayer(roundsLimit, room.players.length)} duelos por persona en cada bloque · ${totalGameRounds(roundsLimit, room.players.length)} rondas en total`
                  : 'La duración se ajusta al número de personas.'}
              </p>
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
    const podium = ranking.slice(0, 3);
    return (
      <main className="cu-app cu-room-view cu-results">
        <header className="cu-game-header"><a className="cu-mini-logo" href="/">CUÑA<span>✳</span></a><span className="cu-kicker">PARTIDA TERMINADA</span></header>
        <section className="cu-waiting">
          <div className="cu-trophy">✦</div>
          <p className="cu-kicker">LA ÚLTIMA PALABRA</p>
          <h1>{champions.length > 1 ? 'EMPATE ÉPICO' : 'CAMPEÓN/A'}<br /><span>{champions.map((player) => player.name).join(' · ')}</span></h1>
          <div className="cu-podium" aria-label="Podio final">
            {[2, 1, 0].map((placeIndex, revealIndex) => {
              const player = podium[placeIndex];
              return player ? (
                <article className={`cu-podium-place cu-podium-place-${placeIndex + 1}`} key={player.id} style={{ animationDelay: `${revealIndex * 850}ms` }}>
                  <span className="cu-podium-crown">{placeIndex === 0 ? '♛' : placeIndex === 1 ? '✦' : '✧'}</span>
                  <span className={`cu-avatar cu-avatar-${placeIndex % 4}`}>{player.name.charAt(0)}</span>
                  <strong>{player.name}</strong>
                  <em>{player.score} PTS</em>
                  <b>{placeIndex + 1}</b>
                </article>
              ) : <span className={`cu-podium-empty cu-podium-empty-${placeIndex + 1}`} key={placeIndex} />;
            })}
          </div>
          <div className="cu-ranking">{ranking.slice(3).map((player, index) => <div className="cu-rank-row" key={player.id}><b>{String(index + 4).padStart(2, '0')}</b><span className={`cu-avatar cu-avatar-${(index + 3) % 4}`}>{player.name.charAt(0)}</span><strong>{player.name}</strong><em>{player.score} PTS</em></div>)}</div>
          <button className="cu-primary" onClick={() => void exitRoom()}>VOLVER AL SELECTOR <span>↗</span></button>
        </section>
      </main>
    );
  }

  if (room.gameStage === 'middle_ranking') {
    const ranking = [...room.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return (
      <main className="cu-app cu-room-view cu-intermission">
        <header className="cu-game-header"><a className="cu-mini-logo" href="/">CUÑA<span>✳</span></a><span className="cu-round-count">MITAD DE PARTIDA</span></header>
        <section className="cu-waiting">
          <div className="cu-trophy cu-intermission-star">✳</div>
          <p className="cu-kicker">EL MARCADOR SE RESETEA… MENTIRA</p>
          <h1>Así va el<br /><span>salseo.</span></h1>
          <div className="cu-ranking">{ranking.map((player, index) => <div className="cu-rank-row" key={player.id} style={{ animationDelay: `${index * 110}ms` }}><b>{String(index + 1).padStart(2, '0')}</b><span className={`cu-avatar cu-avatar-${index % 4}`}>{player.name.charAt(0)}</span><strong>{player.name}{player.id === me.id ? ' (tú)' : ''}</strong><em>{player.score} PTS</em></div>)}</div>
          {me.isHost
            ? <button className="cu-primary cu-next" disabled={pending} onClick={() => void perform(() => nextCunadometroRound(room.code, me.id, session.playerToken))}>A POR LA SEGUNDA MITAD <span>→</span></button>
            : <p className="cu-wait-note"><i></i> Esperando a que el anfitrión abra la segunda mitad…</p>}
        </section>
      </main>
    );
  }

  if (!round) return <main className="cu-app"><p className="cu-error">Cargando la ronda…</p></main>;

  const title = round.mode === 'duel' ? 'DUELO ALEATORIO' : 'TODO EL GRUPO JUEGA';
  const answerLength = answerText.trim().length;
  const isDuelAnswerPhase = room.gameStage === 'opening_answers' || room.gameStage === 'closing_answers';

  if (isDuelAnswerPhase) {
    const allMyTasksSent = round.myDuelTasks.length > 0 && round.myDuelTasks.every((task) => task.answerText !== null);
    return (
      <main className="cu-app cu-room-view cu-playing cu-answer-block">
        <header className="cu-game-header">
          <a className="cu-mini-logo" href="/">CUÑA<span>✳</span></a>
          <button className="cu-code-pill" onClick={() => void copyRoomCode()}>{copied ? 'COPIADO' : room.code}</button>
          <span className="cu-round-count">{round.number}<small> / {room.roundsLimit}</small></span>
        </header>
        <div className="cu-progress"><span style={{ width: `${round.number / room.roundsLimit * 100}%` }} /></div>
        <section className="cu-play-area">
          <div className="cu-phase-banner" ref={phaseBannerRef}>
            <span className="cu-phase-icon">VS</span>
            <div>
              <p className="cu-kicker">{room.gameStage === 'opening_answers' ? 'PRIMERA MITAD · FASE DE DUELOS' : 'SEGUNDA MITAD · FASE DE DUELOS'}</p>
              <h1>Te toca responder<br /><span>{round.myDuelTasks.length} duelos.</span></h1>
            </div>
          </div>
          <p className="cu-copy">Contesta ahora todos tus duelos. Cuando el grupo termine, las respuestas se revelarán una por una y podréis votar.</p>
          <div className="cu-phase-progress">
            <span>RESPUESTAS DEL GRUPO</span>
            <strong>{round.phaseSubmittedCount} / {round.phaseExpectedCount}</strong>
            <i><b style={{ width: `${round.phaseExpectedCount ? round.phaseSubmittedCount / round.phaseExpectedCount * 100 : 0}%` }} /></i>
          </div>
          <div className="cu-duel-task-list" ref={duelTaskListRef}>
            {round.myDuelTasks.map((task, index) => {
              const submitted = task.answerText !== null;
              const draft = duelAnswers[task.number] ?? '';
              return (
                <article className="cu-duel-task" key={task.number} style={{ animationDelay: `${index * 100}ms` }}>
                  <span className="cu-task-index">DUELO {String(index + 1).padStart(2, '0')} <i>·</i> CONSIGNA {String(task.number).padStart(2, '0')}</span>
                  <h2>{task.prompt}</h2>
                  {submitted ? (
                    <div className="cu-task-sent"><span>✓</span><strong>RESPUESTA GUARDADA</strong><em>{task.answerText}</em></div>
                  ) : (
                    <form className="cu-answer-form" onSubmit={(event) => {
                      event.preventDefault();
                      if (!pending && draft.trim().length >= 2) {
                        void perform(() => submitCunadometroAnswer(room.code, me.id, session.playerToken, draft, task.number));
                      }
                    }}>
                      <label htmlFor={`cu-answer-${task.number}`}>TU RESPUESTA</label>
                      <textarea
                        id={`cu-answer-${task.number}`}
                        value={draft}
                        onChange={(event) => setDuelAnswers((current) => ({ ...current, [task.number]: event.target.value }))}
                        maxLength={180}
                        placeholder="Que se note que has pensado lo justo…"
                      />
                      <div className="cu-answer-actions">
                        <span>{draft.trim().length}/180</span>
                        <button className="cu-primary" disabled={pending || draft.trim().length < 2}>GUARDAR DUELO <span>↗</span></button>
                      </div>
                    </form>
                  )}
                </article>
              );
            })}
          </div>
          {allMyTasksSent && <div className="cu-wait-card"><span className="cu-spinner"></span><strong>Ya están tus duelos. Que nadie mire.</strong><span>Esperando a que el resto termine sus respuestas.</span></div>}
          {error && <p className="cu-error" role="alert">{error}</p>}
        </section>
        <footer className="cu-footer"><span>FASE DE RESPUESTAS SECRETAS</span><span>MADE BY YAZAWA</span></footer>
      </main>
    );
  }

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
        <article className="cu-prompt" ref={promptRef} key={`${round.number}-${round.prompt}`}>
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
            <div className="cu-stage-heading">
              <strong>{revealReady ? (round.mode === 'duel' ? 'EL PÚBLICO DECIDE' : 'VOTA LA MÁS BRILLANTE') : 'ATENCIÓN, SALEN LAS RESPUESTAS'}</strong>
              <span>{round.answers.length} RESPUESTAS</span>
            </div>
            <div className="cu-answers">
              {round.answers.map((answer, index) => {
                const isMine = round.myAnswerId === answer.id;
                return (
                  <button
                    className={`cu-answer-card cu-answer-reveal ${round.myVoteId === answer.id ? 'is-voted' : ''} ${isMine ? 'is-own-answer' : ''}`}
                    key={answer.id}
                    ref={(element) => {
                      if (element) answerRefs.current.set(answer.id, element);
                      else answerRefs.current.delete(answer.id);
                    }}
                    disabled={!canVote || isMine}
                    onClick={() => void perform(() => voteCunadometroAnswer(room.code, me.id, session.playerToken, answer.id))}
                  >
                    <small>IDEA {String(index + 1).padStart(2, '0')}</small><strong>{answer.text}</strong>
                    {isMine ? <span className="cu-own-answer-label">TU RESPUESTA</span> : canVote && <span>VOTAR ESTA <b>↗</b></span>}
                  </button>
                );
              })}
            </div>
            <p className="cu-vote-note">
              {round.myVoteId
                ? 'Voto secreto enviado · esperando al resto.'
                : !revealReady
                  ? round.mode === 'duel' ? 'Lee la consigna… se revela la primera idea en un instante.' : 'Las ideas están entrando en escena…'
                  : canVote
                    ? 'Vota una respuesta; el resultado se revela al final.'
                    : 'Quienes responden no votan esta ronda.'}
              {' '}{round.votesSubmittedCount}/{round.eligibleVoterCount}
            </p>
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
      <section className="cu-score-strip" ref={scoreStripRef}>
        {room.players.map((player, index) => <div key={player.id}><span className={`cu-avatar cu-avatar-${index % 4}`}>{player.name.charAt(0)}</span><span>{player.name}{player.id === me.id ? ' (tú)' : ''}</span><b>{player.score}</b></div>)}
      </section>
      <footer className="cu-footer"><span>PARTIDA EN CURSO · VUELVE A ESTA PANTALLA PARA CONTINUAR</span><span>CONSIGNA ORIGINAL · MADE BY YAZAWA</span></footer>
    </main>
  );
}
