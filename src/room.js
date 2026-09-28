// Court Piece game logic — Cloudflare Durable Object, one instance per room.
// Rules:
//  - 4 players, 2 teams (seats 0/2 vs 1/3)
//  - Round 1: first Ace dealt determines the Caller (trump chooser)
//  - Subsequent rounds: previous Caller keeps role if their team wins, else passes to next player
//  - Caller picks trump from first 5 cards dealt to them; then all players get 13 cards
//  - Follow suit enforced; highest card of led suit wins unless trumped
//  - 7 tricks wins the round; KOT (7-0) is worth 2 match points
//  - First team to 7 match points wins the game

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i]));

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function fullDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ s, r });
  return d;
}

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();   // sessionId -> { ws, seat }
    this.game = this.newGame();
  }

  newGame() {
    return {
      phase: 'waiting',        // waiting | dealing | choosing | playing | roundEnd | gameOver
      players: [null, null, null, null],  // { name, sessionId }
      caller: -1,
      trumpSuit: null,
      hands: [[], [], [], []],
      scores: [0, 0],           // match points per team
      roundWins: [0, 0],        // tricks this round per team
      trick: [],                // { seat, card }
      leader: 0,
      turn: 0,
      firstAceReveal: null,     // { seat, card } during round-1 dealing
      roundNo: 0,
      messages: [],             // chat history
      winner: -1,
    };
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const sessionId = crypto.randomUUID();
    this.state.acceptWebSocket(server);
    this.sessions.set(sessionId, { ws: server, seat: -1, name: null });

    server.send(JSON.stringify({ type: 'welcome', sessionId }));

    server.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      try { this.handle(sessionId, msg); } catch (e) { /* keep room alive */ }
    });

    server.addEventListener('close', () => this.onClose(sessionId));
    server.addEventListener('error', () => this.onClose(sessionId));

    return new Response(null, { status: 101, webSocket: client });
  }

  onClose(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (sess && sess.seat >= 0 && this.game.players[sess.seat]) {
      this.pushChat(null, this.game.players[sess.seat].name + ' disconnected (seat kept for rejoin)');
    }
    this.sessions.delete(sessionId);
    this.broadcastState();
  }

  sendAll(obj) {
    const data = JSON.stringify(obj);
    for (const s of this.sessions.values()) {
      try { s.ws.send(data); } catch { /* ignore broken */ }
    }
  }

  send(sess, obj) { try { sess.ws.send(JSON.stringify(obj)); } catch {} }

  handle(sessionId, msg) {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    const g = this.game;

    switch (msg.type) {
      case 'join': {
        const name = String(msg.name || 'Player').slice(0, 20).trim();

        // Reclaim an existing seat by name (reconnect support)
        const reclaim = g.players.findIndex(p => p && p.name === name);
        if (reclaim >= 0) {
          g.players[reclaim].sessionId = sessionId;
          sess.seat = reclaim;
          sess.name = name;
          this.send(sess, { type: 'joined', seat: reclaim });
          this.pushChat(null, name + ' reconnected');
          break;
        }

        if (sess.seat >= 0) { this.send(sess, { type: 'joined', seat: sess.seat }); break; }
        // Prefer a seat whose previous owner is gone
        let seat = g.players.findIndex(p => p && !this.sessions.has(p.sessionId));
        if (seat === -1) seat = g.players.findIndex(p => !p);
        if (seat === -1) { this.send(sess, { type: 'error', error: 'Room is full (4 players max)' }); break; }

        g.players[seat] = { name, sessionId };
        sess.seat = seat;
        sess.name = name;
        this.send(sess, { type: 'joined', seat });
        this.pushChat(null, name + ' joined as player ' + (seat + 1));
        if (g.phase === 'waiting' && g.players.every(Boolean)) this.startRound();
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 300);
        if (sess.seat >= 0 && text.trim() && g.players[sess.seat]) {
          this.pushChat(g.players[sess.seat].name, text.trim());
        }
        break;
      }
      case 'chooseTrump': {
        if (g.phase !== 'choosing' || sess.seat !== g.caller) break;
        if (!SUITS.includes(msg.suit)) break;
        this.setTrump(msg.suit);
        break;
      }
      case 'play': {
        if (g.phase !== 'playing' || sess.seat !== g.turn) break;
        const cardIdx = g.hands[sess.seat].findIndex(c => c.s === msg.suit && c.r === msg.rank);
        if (cardIdx === -1) break;
        const card = g.hands[sess.seat][cardIdx];
        if (!this.isLegalPlay(sess.seat, card)) {
          this.send(sess, { type: 'error', error: 'You must follow suit!' });
          break;
        }
        g.hands[sess.seat].splice(cardIdx, 1);
        g.trick.push({ seat: sess.seat, card });
        if (g.trick.length === 4) {
          const winner = this.trickWinner(g.trick, g.trumpSuit);
          g.roundWins[winner % 2]++;
          g.trick = [];
          g.turn = winner;
          g.leader = winner;
          if (g.roundWins[0] === 7 || g.roundWins[1] === 7) this.endRound();
          else if (g.hands.every(h => h.length === 0)) this.endRound();
        } else {
          g.turn = (g.turn + 1) % 4;
        }
        break;
      }
      case 'restart': {
        if (g.phase === 'gameOver') {
          const players = g.players.map(p => p ? { name: p.name, sessionId: null } : null);
          this.game = this.newGame();
          this.game.players = players;
          for (const [id, s2] of this.sessions) {
            const st = this.game.players.findIndex(p => p && p.name === s2.name);
            if (st >= 0) {
              this.game.players[st].sessionId = id;
              s2.seat = st;
            } else {
              s2.seat = -1;
            }
          }
          if (this.game.players.every(Boolean)) this.startRound();
        }
        break;
      }
      case 'ping': break;
    }

    this.broadcastState();
  }

  pushChat(from, text) {
    this.game.messages.push({ from, text, t: Date.now() });
    if (this.game.messages.length > 100) this.game.messages.shift();
    this.sendAll({ type: 'chat', messages: this.game.messages });
  }

  startRound() {
    const g = this.game;
    g.roundNo++;
    g.roundWins = [0, 0];
    g.trick = [];
    g.hands = [[], [], [], []];
    g.trumpSuit = null;
    g.phase = 'dealing';

    if (g.caller === -1) {
      // Round 1: deal one card at a time; first Ace determines the Caller.
      const deck = shuffle(fullDeck());
      for (let i = 0; i < deck.length; i++) {
        const seat = i % 4;
        if (deck[i].r === 'A') {
          g.caller = seat;
          g.firstAceReveal = { seat, card: deck[i] };
          break;
        }
      }
      if (g.caller === -1) g.caller = 0; // unreachable with a full deck
      this.sendAll({ type: 'callerDecided', seat: g.caller, reveal: g.firstAceReveal });
    }

    // Deal 5 cards to each player first, Caller chooses trump.
    const deck = shuffle(fullDeck());
    for (let i = 0; i < 4; i++) {
      g.hands[i] = deck.slice(i * 5, i * 5 + 5);
    }
    g.remainingDeck = deck.slice(20);
    g.phase = 'choosing';
    g.turn = g.caller;
  }

  setTrump(suit) {
    const g = this.game;
    g.trumpSuit = suit;
    this.sendAll({ type: 'trumpChosen', suit });
    // Deal remaining cards: Caller gets 8 more, others 13 more.
    const rest = g.remainingDeck;
    g.hands[g.caller].push(...rest.slice(0, 8));
    let idx = 8;
    for (let i = 1; i <= 3; i++) {
      const seat = (g.caller + i) % 4;
      g.hands[seat].push(...rest.slice(idx, idx + 13));
      idx += 13;
    }
    delete g.remainingDeck;
    g.phase = 'playing';
    g.turn = g.caller;
    g.leader = g.caller;
  }

  isLegalPlay(seat, card) {
    const g = this.game;
    if (g.trick.length === 0) return true;
    const ledSuit = g.trick[0].card.s;
    if (card.s === ledSuit) return true;
    // Must follow suit if possible
    return !g.hands[seat].some(c => c.s === ledSuit);
  }

  trickWinner(trick, trump) {
    let best = trick[0];
    for (const t of trick.slice(1)) {
      const c = t.card;
      const b = best.card;
      if (c.s === trump && b.s !== trump) best = t;
      else if (c.s === b.s && RANK_VALUE[c.r] > RANK_VALUE[b.r]) best = t;
    }
    return best.seat;
  }

  endRound() {
    const g = this.game;
    const winningTeam = g.roundWins[0] === 7 ? 0 : 1;
    const kot = g.roundWins[1 - winningTeam] === 0;
    g.scores[winningTeam] += kot ? 2 : 1;

    if (g.scores[0] >= 7 || g.scores[1] >= 7) {
      g.phase = 'gameOver';
      g.winner = g.scores[0] >= 7 ? 0 : 1;
      this.sendAll({ type: 'gameOver', winner: g.winner, scores: g.scores });
      return;
    }

    this.sendAll({ type: 'roundEnd', winnerTeam: winningTeam, kot, scores: g.scores });
    // Caller keeps role if their team won the round; otherwise passes clockwise.
    const callerTeam = g.caller % 2;
    if (callerTeam !== winningTeam) g.caller = (g.caller + 1) % 4;
    g.phase = 'roundEnd';
    // Auto-start next round shortly
    setTimeout(() => {
      if (this.game.phase === 'roundEnd') {
        this.startRound();
        this.broadcastState();
      }
    }, 3000);
  }

  // Send a personalized state snapshot to each client (hands are private).
  broadcastState() {
    const g = this.game;
    for (const sess of this.sessions.values()) {
      const seat = sess.seat;
      const state = {
        type: 'state',
        phase: g.phase,
        players: g.players.map((p) => p ? { name: p.name, connected: this.sessions.has(p.sessionId) } : null),
        you: seat,
        caller: g.caller,
        trumpSuit: g.trumpSuit,
        scores: g.scores,
        roundWins: g.roundWins,
        trick: g.trick,
        turn: g.turn,
        hand: seat >= 0 ? g.hands[seat] : [],
        handCounts: g.hands.map(h => h.length),
        firstAceReveal: g.firstAceReveal,
        roundNo: g.roundNo,
        winner: g.winner,
        messages: g.messages,
      };
      this.send(sess, state);
    }
  }
}
