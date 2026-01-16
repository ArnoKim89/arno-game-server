const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
// HTTP health check
// ---------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('FOURVIVE Signaling Server is Running...');
  }
});

const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_EXTERNAL_HOSTNAME;
const HEALTH_CHECK_INTERVAL = 10 * 60 * 1000;

if (RENDER_URL) {
  const baseUrl = RENDER_URL.startsWith('http') ? RENDER_URL : `https://${RENDER_URL}`;
  const isHttps = baseUrl.startsWith('https');
  const httpModule = isHttps ? https : http;

  console.log(`[Health Check] auto ping: ${baseUrl} (every ${HEALTH_CHECK_INTERVAL / 1000}s)`);

  const performHealthCheck = () => {
    httpModule
      .get(baseUrl, (res) => {
        console.log(`[Health Check] ok: ${res.statusCode} (${new Date().toLocaleTimeString()})`);
      })
      .on('error', (err) => {
        console.log(`[Health Check] err: ${err.message} (${new Date().toLocaleTimeString()})`);
      });
  };

  setTimeout(performHealthCheck, 5000);
  setInterval(performHealthCheck, HEALTH_CHECK_INTERVAL);
} else {
  console.log('[Health Check] RENDER_EXTERNAL_URL not set (fine for local).');
}

// ---------------------------------------------------------
// WebSocket signaling
// ---------------------------------------------------------
const wss = new WebSocket.Server({ server });
console.log(`Signaling server started on port ${PORT}`);

// Room model: star topology (host <-> peers). No TURN here.
// roomCode -> { createdAt, hostWs, peers: Map(peerId, ws) }
const rooms = new Map();

// Basic anti-abuse: join attempts per IP per minute
const ipJoinBucket = new Map(); // ip -> { windowStartMs, count }
const JOIN_WINDOW_MS = 60_000;
const JOIN_LIMIT_PER_WINDOW = 60;

const ROOM_CODE_LEN = 6;
const ROOM_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ROOM_TTL_MS = 30 * 60_000; // 30 minutes idle cleanup (best-effort)

function nowMs() {
  return Date.now();
}

function randInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function generateRoomCode() {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    s += ROOM_CODE_ALPHABET[randInt(ROOM_CODE_ALPHABET.length)];
  }
  return s;
}

function createUniqueRoomCode() {
  // Try a few times; collision chance is tiny at small scale.
  for (let i = 0; i < 20; i++) {
    const code = generateRoomCode();
    if (!rooms.has(code)) return code;
  }
  // Fallback (should not happen)
  return `${generateRoomCode()}${generateRoomCode()}`.slice(0, ROOM_CODE_LEN);
}

function safeSendJson(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function rateLimitJoin(ip) {
  const t = nowMs();
  const cur = ipJoinBucket.get(ip);
  if (!cur || t - cur.windowStartMs > JOIN_WINDOW_MS) {
    ipJoinBucket.set(ip, { windowStartMs: t, count: 1 });
    return false;
  }
  cur.count += 1;
  return cur.count > JOIN_LIMIT_PER_WINDOW;
}

function cleanupEmptyRoom(code) {
  const r = rooms.get(code);
  if (!r) return;
  const hasHost = r.hostWs && r.hostWs.readyState === WebSocket.OPEN;
  const peerCount = r.peers ? r.peers.size : 0;
  if (!hasHost && peerCount === 0) {
    rooms.delete(code);
    console.log(`[room] deleted ${code}`);
  }
}

function removePeerFromRoom(ws) {
  if (!ws.roomCode) return;
  const code = ws.roomCode;
  const room = rooms.get(code);
  if (!room) return;

  if (ws.role === 'host') {
    // Host left: inform peers and detach host.
    console.log(`[room] host left ${code}`);
    room.hostWs = null;
    for (const [peerId, peerWs] of room.peers.entries()) {
      safeSendJson(peerWs, { t: 'host_left' });
      // peers stay connected to signaling but room has no host now.
    }
  } else if (ws.role === 'peer') {
    const peerId = ws.peerId;
    if (peerId && room.peers.has(peerId)) {
      room.peers.delete(peerId);
      console.log(`[room] peer left ${code}: ${peerId} (peers=${room.peers.size})`);
      if (room.hostWs) safeSendJson(room.hostWs, { t: 'peer_left', id: peerId });
    }
  }

  ws.roomCode = null;
  ws.role = null;
  ws.peerId = null;

  cleanupEmptyRoom(code);
}

function handleCreate(ws) {
  if (ws.roomCode) {
    safeSendJson(ws, { t: 'error', code: 'already_in_room' });
    return;
  }

  const roomCode = createUniqueRoomCode();
  const room = {
    createdAt: nowMs(),
    hostWs: ws,
    peers: new Map(),
  };
  rooms.set(roomCode, room);

  ws.roomCode = roomCode;
  ws.role = 'host';
  ws.peerId = 'host';

  console.log(`[room] created ${roomCode} (host)`);
  safeSendJson(ws, { t: 'created', code: roomCode, id: 'host', role: 'host' });
}

function handleJoin(ws, ip, msg) {
  if (ws.roomCode) {
    safeSendJson(ws, { t: 'error', code: 'already_in_room' });
    return;
  }
  if (rateLimitJoin(ip)) {
    safeSendJson(ws, { t: 'error', code: 'rate_limited' });
    return;
  }

  const roomCode = (msg && typeof msg.code === 'string') ? msg.code.trim().toUpperCase() : '';
  if (!roomCode || roomCode.length !== ROOM_CODE_LEN) {
    safeSendJson(ws, { t: 'error', code: 'invalid_room_code' });
    return;
  }

  const room = rooms.get(roomCode);
  if (!room || !room.hostWs || room.hostWs.readyState !== WebSocket.OPEN) {
    safeSendJson(ws, { t: 'error', code: 'room_not_found' });
    return;
  }

  // Allocate peer id
  let peerId = '';
  for (let i = 0; i < 40; i++) {
    peerId = `p${Math.random().toString(36).slice(2, 10)}`;
    if (!room.peers.has(peerId)) break;
  }

  ws.roomCode = roomCode;
  ws.role = 'peer';
  ws.peerId = peerId;
  room.peers.set(peerId, ws);

  console.log(`[room] join ${roomCode}: ${peerId} (peers=${room.peers.size})`);

  safeSendJson(ws, { t: 'joined', code: roomCode, id: peerId, role: 'peer', hostId: 'host' });
  safeSendJson(room.hostWs, { t: 'peer_joined', code: roomCode, id: peerId });
}

function handleSignal(ws, msg) {
  const roomCode = ws.roomCode;
  if (!roomCode) {
    safeSendJson(ws, { t: 'error', code: 'not_in_room' });
    return;
  }
  const room = rooms.get(roomCode);
  if (!room) {
    safeSendJson(ws, { t: 'error', code: 'room_not_found' });
    return;
  }

  const to = msg && typeof msg.to === 'string' ? msg.to : '';
  const data = msg ? msg.data : undefined;

  if (!to || typeof data === 'undefined') {
    safeSendJson(ws, { t: 'error', code: 'bad_signal' });
    return;
  }

  let targetWs = null;
  if (to === 'host') {
    targetWs = room.hostWs;
  } else {
    targetWs = room.peers.get(to);
  }

  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    safeSendJson(ws, { t: 'error', code: 'peer_not_found' });
    return;
  }

  safeSendJson(targetWs, {
    t: 'signal',
    code: roomCode,
    from: ws.peerId || (ws.role === 'host' ? 'host' : 'unknown'),
    to,
    data,
  });
}

// Legacy support: old binary protocol (msgId=200 room register; then raw relay)
function handleLegacyBinary(ws, data) {
  if (!Buffer.isBuffer(data) || data.length === 0) return false;
  const msgId = data.readUInt8(0);
  if (msgId !== 200) return false;

  let rawString = data.toString('utf8', 1);
  const roomCode = rawString.replace(/\0/g, '').trim().toUpperCase();
  if (!roomCode) return true;

  // If room exists -> treat as peer; else -> host
  let room = rooms.get(roomCode);
  if (!room) {
    room = { createdAt: nowMs(), hostWs: ws, peers: new Map() };
    rooms.set(roomCode, room);
    ws.roomCode = roomCode;
    ws.role = 'host';
    ws.peerId = 'host';
    console.log(`[legacy] created room ${roomCode} (host)`);
  } else {
    // Peer join; no peerId in legacy, just add to peers map with random id
    let peerId = `p${Math.random().toString(36).slice(2, 10)}`;
    while (room.peers.has(peerId)) peerId = `p${Math.random().toString(36).slice(2, 10)}`;
    ws.roomCode = roomCode;
    ws.role = 'peer';
    ws.peerId = peerId;
    room.peers.set(peerId, ws);
    console.log(`[legacy] join room ${roomCode}: ${peerId}`);
  }
  return true;
}

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[ws] connected ip=${ip}`);

  ws.isAlive = true;
  ws.roomCode = null;
  ws.role = null; // 'host' | 'peer'
  ws.peerId = null; // 'host' or 'p...'

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    try {
      // Legacy binary path
      if (handleLegacyBinary(ws, data)) return;

      // JSON signaling protocol (text frames)
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        // Ignore unknown data
        return;
      }

      if (!msg || typeof msg.t !== 'string') return;

      switch (msg.t) {
        case 'create':
          handleCreate(ws);
          break;
        case 'join':
          handleJoin(ws, ip, msg);
          break;
        case 'signal':
          handleSignal(ws, msg);
          break;
        case 'leave':
          removePeerFromRoom(ws);
          safeSendJson(ws, { t: 'left' });
          break;
        case 'ping':
          safeSendJson(ws, { t: 'pong', ts: msg.ts || null });
          break;
        default:
          safeSendJson(ws, { t: 'error', code: 'unknown_type' });
          break;
      }
    } catch (e) {
      console.error('[ws] message error', e);
      safeSendJson(ws, { t: 'error', code: 'server_error' });
    }
  });

  ws.on('close', () => {
    removePeerFromRoom(ws);
    console.log(`[ws] closed ip=${ip}`);
  });
});

// WS keepalive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

// Best-effort room cleanup by TTL (host gone + idle)
setInterval(() => {
  const t = nowMs();
  for (const [code, room] of rooms.entries()) {
    const hostAlive = room.hostWs && room.hostWs.readyState === WebSocket.OPEN;
    if (hostAlive) continue;
    if (t - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(code);
      console.log(`[room] ttl cleanup ${code}`);
    }
  }
}, 60_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on port ${PORT}`);
});