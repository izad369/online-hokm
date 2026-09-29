// Hokm Online — Cloudflare Worker entrypoint
// Serves static assets from ./public and routes WebSocket connections
// to a Durable Object instance per room.

import { RoomDO } from './room.js';

export { RoomDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket endpoint: /ws?room=CODE
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const publicGame=url.searchParams.get('publicGame');
      const room=publicGame==='ttt'?'PUBTTT':publicGame==='connect4'?'PUBC4':(url.searchParams.get('room') || 'LOBBY').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'LOBBY';
      const id = env.ROOM.idFromName(room);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    // Serve static assets (index.html etc.)
    return env.ASSETS.fetch(request);
  },
};
