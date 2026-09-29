# ♠ Court Piece — Online Multiplayer Card Game

A fully online, real-time **multiplayer** trick-taking card game with **built-in chat**, designed to be deployed on **Cloudflare Workers** (free tier friendly).

![Game](https://img.shields.io/badge/platform-Cloudflare%20Workers-orange) ![Lang](https://img.shields.io/badge/language-JavaScript-yellow) ![License](https://img.shields.io/badge/license-MIT-green)

## 🎮 Features

- 🏠 **Create Room / Join Room** — start a new room with one click or join with a code
- 👥 **4-player online multiplayer** — shareable invite link
- 🔴 **Real-time gameplay** over WebSockets (Cloudflare Durable Objects — one instance per room)
- 💬 **In-game chat** with all players
- 🃏 **Full rules**:
  - First Ace dealt in round 1 determines the **trump chooser**
  - The chooser picks the trump suit from their first 5 cards
  - Follow-suit enforcement
  - 7 tricks wins the round
  - **Shutout** (7–0) = 2 match points
  - First team to **7 match points** wins the game
  - Trump chooser rotates when their team loses a round
- 🔌 **Auto-reconnect** — refresh or drop connection and rejoin the same seat
- 🌐 **English UI**, mobile-friendly responsive layout
- 🚫 **No build step** — plain JavaScript, no bundler required

## 🏗️ How It Works

| Component | Tech |
|---|---|
| Static client | Vanilla HTML/CSS/JS served via Workers Assets |
| Real-time transport | WebSockets |
| Game state & rooms | Cloudflare Durable Objects (`RoomDO`), one per room code |
| Hosting | Cloudflare Workers |

Each room is a Durable Object named by its room code, holding all game state, player sessions, and chat history. The server never reveals other players' hands — each client receives a personalized state snapshot.

## 🚀 Deploy to Cloudflare

### 1. Prerequisites
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js 18+

### 2. Install & login

```bash
npm install
npx wrangler login
```

### 3. Deploy

```bash
npm run deploy
```

Wrangler will print your liv
e URL, e.g. `https://online-hokm.<your-subdomain>.workers.dev`.

> **Note:** Durable Objects (including WebSocket support) are available on the Workers **free tier** — no paid plan needed.

### 4. Local development

```bash
npm run dev
```

Then open http://localhost:8787.

## 🕹️ How to Play

1. Open the site, enter your name, then **Create Room** (new game) or **Join Room** (with a code).
2. Copy the **invite link** (top-right button) and share it with 3 friends.
3. Once 4 players have joined, the game starts automatically.
4. The first Ace dealt determines the trump chooser, who picks the trump suit.
5. Players take turns playing one card; you must follow suit if you can.
6. The highest card of the led suit wins the trick — unless trumped.
7. First team to win **7 tricks** takes the round; **7 match points** wins the game.

**Teams:** Seat 1 & Seat 3 vs Seat 2 & Seat 4.

## 📁 Project Structure

```
├── src/
│   ├── index.js    # Worker entrypoint — assets + WebSocket routing
│   └── room.js     # RoomDO — full game logic & chat
├── public/
│   └── index.html  # Client UI (lobby, table, chat)
├── wrangler.toml   # Cloudflare config (Durable Objects binding)
└── package.json
```

## 📄 License

[MIT](LICENSE)

<!-- deploy-trigger: 2026-09-29 rebuild -->
