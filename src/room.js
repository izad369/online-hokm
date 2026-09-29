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
    this.publicGame = null;
    this.publicState = null;
    this.publicQueue = [];
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
    const url = new URL(request.url);
    const pg = url.searchParams.get('publicGame');
    if (pg === 'ttt' || pg === 'connect4') this.publicGame = pg;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const sessionId = crypto.randomUUID();

    // Use the standard Durable Objects WebSocket API here.
    // The room code currently keeps its live state and listeners in memory,
    // so the server-side socket must be accepted with server.accept().
    // acceptWebSocket() is the Hibernation API and would bypass the
    // addEventListener('message'/'close') handlers used below.
    server.accept();

    this.sessions.set(sessionId, { ws: server, seat: -1, name: null, publicGame: this.publicGame, publicPlayer: -1 });

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

  publicSend(id,obj){const s=this.sessions.get(id);try{s?.ws.send(JSON.stringify(obj))}catch{}}
  publicBroadcast(obj){const d=JSON.stringify(obj);for(const s of this.sessions.values())if(s.publicGame===this.publicGame)try{s.ws.send(d)}catch{}}
  publicNew(){return {game:this.publicGame,board:this.publicGame==='ttt'?Array(9).fill(''):Array(42).fill(''),turn:0,players:[],over:false,winner:null,messages:[]}}
  tttWin(b){const L=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];for(const x of L)if(b[x[0]]&&b[x[0]]===b[x[1]]&&b[x[1]]===b[x[2]])return b[x[0]];return b.every(Boolean)?'draw':null}
  c4Win(b){for(let r=0;r<6;r++)for(let c=0;c<4;c++){let i=r*7+c,v=b[i];if(v&&v===b[i+1]&&v===b[i+2]&&v===b[i+3])return v}for(let c=0;c<7;c++)for(let r=0;r<3;r++){let i=r*7+c,v=b[i];if(v&&v===b[i+7]&&v===b[i+14]&&v===b[i+21])return v}for(let r=0;r<3;r++)for(let c=0;c<4;c++){let i=r*7+c,v=b[i];if(v&&v===b[i+8]&&v===b[i+16]&&v===b[i+24])return v}for(let r=3;r<6;r++)for(let c=0;c<4;c++){let i=r*7+c,v=b[i];if(v&&v===b[i-6]&&v===b[i-12]&&v===b[i-18])return v}return b.every(Boolean)?'draw':null}
  publicStateSend(){if(this.publicState)this.publicBroadcast({type:'state',...this.publicState})}
  handlePublic(id,msg){const s=this.sessions.get(id);if(!s)return;if(msg.type==='find'){s.name=String(msg.name||'Player').slice(0,20);this.publicQueue=this.publicQueue.filter(x=>this.sessions.has(x));const mate=this.publicQueue.find(x=>x!==id);if(!mate){if(!this.publicQueue.includes(id))this.publicQueue.push(id);this.publicSend(id,{type:'queued',game:this.publicGame});return}this.publicQueue=this.publicQueue.filter(x=>x!==mate&&x!==id);this.publicState=this.publicNew();this.publicState.players=[this.sessions.get(mate)?.name||'Player',s.name];this.sessions.get(mate).publicPlayer=0;s.publicPlayer=1;this.publicSend(mate,{type:'matched',game:this.publicGame,player:0});this.publicSend(id,{type:'matched',game:this.publicGame,player:1});this.publicStateSend();return}if(msg.type==='chat'&&this.publicState){const text=String(msg.text||'').slice(0,300).trim();if(!text)return;this.publicState.messages.push({from:s.name||'Player',text});if(this.publicState.messages.length>60)this.publicState.messages.shift();this.publicStateSend();return}if(msg.type==='move'&&this.publicState&&!this.publicState.over){const p=s.publicPlayer;if(p!==this.publicState.turn)return;const mark=p===0?'X':'O';if(this.publicGame==='ttt'){const i=Number(msg.i);if(!Number.isInteger(i)||i<0||i>8||this.publicState.board[i])return;this.publicState.board[i]=mark;this.publicState.winner=this.tttWin(this.publicState.board)}else{const c=Number(msg.c);if(!Number.isInteger(c)||c<0||c>6)return;let row=-1;for(let r=5;r>=0;r--)if(!this.publicState.board[r*7+c]){row=r;break}if(row<0)return;this.publicState.board[row*7+c]=mark;this.publicState.winner=this.c4Win(this.publicState.board)}if(this.publicState.winner)this.publicState.over=true;else this.publicState.turn=1-this.publicState.turn;this.publicStateSend();return}if(msg.type==='rematch'&&this.publicState&&this.publicState.players.length===2){const names=this.publicState.players;this.publicState=this.publicNew();this.publicState.players=names;this.publicStateSend()}}
  publicLeave(id){this.publicQueue=this.publicQueue.filter(x=>x!==id);if(this.publicState&&this.publicState.players.length===2&&!this.publicState.over){this.publicState.over=true;this.publicState.winner=this.sessions.get(id)?.publicPlayer===0?'O':'X';this.publicStateSend()}}

  onClose(sessionId) {
    const sess = this.sessions.get(sessionId);
    if(sess?.publicGame){this.publicLeave(sessionId);this.sessions.delete(sessionId);return;}
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
    if (sess.publicGame) { this.handlePublic(sessionId, msg); return; }
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
        // Keep the room in the lobby until the host presses Start Game.
        break;
      }
      case 'start': {
        if (g.phase !== 'waiting') break;
        if (sess.seat !== 0) {
          this.send(sess, { type: 'error', error: 'Only player 1 (host) can start the game.' });
          break;
        }
        if (!g.players.every(Boolean)) {
          this.send(sess, { type: 'error', error: 'Need 4 players before starting.' });
          break;
        }
        this.pushChat(null, 'Game started by ' + g.players[0].name);
        this.startRound();
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
