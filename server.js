const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { URL } = require('url');

const port = process.env.PORT || 3000;

function getClientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.length > 0) return xf.split(',')[0].trim();
    return req.socket?.remoteAddress || '0.0.0.0';
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk.toString('utf8'); });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function json(res, statusCode, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

// 방코드 매치메이커(HTTP): roomCode -> { hostIp, port, hostKey, expiresAt }
const httpRooms = new Map();
const ROOM_TTL_MS = 30 * 60 * 1000;

// WebRTC 시그널링(HTTP long-poll):
// - Render는 SDP/ICE를 "전달"만 하고 실제 트래픽은 P2P(DataChannel) 직결
const rtcRooms = new Map(); // roomCode -> { events: [], seq: 0, expiresAt }
const RTC_TTL_MS = 30 * 60 * 1000;

function getRtcRoom(roomCode) {
    const now = Date.now();
    let r = rtcRooms.get(roomCode);
    if (!r || r.expiresAt <= now) {
        r = { events: [], seq: 0, expiresAt: now + RTC_TTL_MS };
        rtcRooms.set(roomCode, r);
    } else {
        r.expiresAt = now + RTC_TTL_MS;
    }
    return r;
}

function pushRtcEvent(roomCode, ev) {
    const r = getRtcRoom(roomCode);
    r.seq += 1;
    r.events.push({ seq: r.seq, t: Date.now(), ...ev });
    if (r.events.length > 200) r.events.splice(0, r.events.length - 200);
    return r.seq;
}

function cleanupRtcRooms() {
    const now = Date.now();
    for (const [code, r] of rtcRooms.entries()) {
        if (!r || r.expiresAt <= now) rtcRooms.delete(code);
    }
}
setInterval(cleanupRtcRooms, 30 * 1000).unref?.();

function normalizeRoomCode(code) {
    if (typeof code !== 'string') return '';
    return code.replace(/\0/g, '').trim().toUpperCase();
}

function isValidRoomCode(code) {
    // 대문자/숫자 4~10자
    return /^[A-Z0-9]{4,10}$/.test(code);
}

function cleanupRooms() {
    const now = Date.now();
    for (const [code, room] of httpRooms.entries()) {
        if (!room || room.expiresAt <= now) httpRooms.delete(code);
    }
}
setInterval(cleanupRooms, 30 * 1000).unref?.();

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const ip = getClientIp(req);

        // Health check
        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Game Server is Running...');
            return;
        }

        // CORS preflight (선택)
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
            });
            res.end();
            return;
        }

        // -----------------------------------------------------------------
        // POST /room/create  { roomCode, port?, hostKey? } -> { ok, roomCode, hostIp, port, hostKey, expiresInMs }
        // POST /room/join    { roomCode }                -> { ok, roomCode, hostIp, port }
        // -----------------------------------------------------------------
        if (req.method === 'POST' && (url.pathname === '/room/create' || url.pathname === '/room/join')) {
            const raw = await readBody(req);
            let body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

            const roomCode = normalizeRoomCode(body.roomCode);
            if (!isValidRoomCode(roomCode)) {
                console.log(`[HTTP] ${ip} ${req.method} ${url.pathname} -> invalid_room_code (${String(body.roomCode || '').slice(0, 32)})`);
                json(res, 400, { ok: false, error: 'invalid_room_code' });
                return;
            }

            if (url.pathname === '/room/create') {
                const portNum = Number(body.port);
                const p = Number.isFinite(portNum) && portNum > 0 && portNum < 65536 ? portNum : 6510;

                // 기존 방이 있으면 hostKey로만 갱신 허용(하이재킹 방지)
                const existing = httpRooms.get(roomCode);
                if (existing) {
                    const providedKey = typeof body.hostKey === 'string' ? body.hostKey : '';
                    if (!providedKey || providedKey !== existing.hostKey) {
                        console.log(`[HTTP] ${ip} POST /room/create room=${roomCode} -> room_code_taken`);
                        json(res, 409, { ok: false, error: 'room_code_taken' });
                        return;
                    }
                }

                const hostKey = existing?.hostKey || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
                const expiresAt = Date.now() + ROOM_TTL_MS;
                httpRooms.set(roomCode, { hostIp: ip, port: p, hostKey, expiresAt });
                console.log(`[HTTP] ${ip} POST /room/create room=${roomCode} port=${p} -> ok`);

                json(res, 200, { ok: true, roomCode, hostIp: ip, port: p, hostKey, expiresInMs: ROOM_TTL_MS });
                return;
            }

            // /room/join
            const room = httpRooms.get(roomCode);
            if (!room || room.expiresAt <= Date.now()) {
                httpRooms.delete(roomCode);
                console.log(`[HTTP] ${ip} POST /room/join room=${roomCode} -> room_not_found`);
                json(res, 404, { ok: false, error: 'room_not_found' });
                return;
            }

            console.log(`[HTTP] ${ip} POST /room/join room=${roomCode} -> ok hostIp=${room.hostIp} port=${room.port}`);
            json(res, 200, { ok: true, roomCode, hostIp: room.hostIp, port: room.port });
            return;
        }

        // -----------------------------------------------------------------
        // WebRTC 시그널링
        // POST /rtc/push { roomCode, type, from, to?, data } -> { ok, seq }
        // GET  /rtc/poll?roomCode=XXXX&since=0&to=host|client -> { ok, now, events:[...] }
        // type: "offer" | "answer" | "ice"
        // data: { sdp } or { candidate, sdpMid, sdpMLineIndex }
        // -----------------------------------------------------------------
        if (req.method === 'POST' && url.pathname === '/rtc/push') {
            const raw = await readBody(req);
            let body = {};
            try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

            const roomCode = normalizeRoomCode(body.roomCode);
            if (!isValidRoomCode(roomCode)) {
                console.log(`[HTTP] ${ip} POST /rtc/push -> invalid_room_code`);
                json(res, 400, { ok: false, error: 'invalid_room_code' });
                return;
            }
            const type = typeof body.type === 'string' ? body.type : '';
            if (!['offer', 'answer', 'ice'].includes(type)) {
                console.log(`[HTTP] ${ip} POST /rtc/push room=${roomCode} -> invalid_type(${type})`);
                json(res, 400, { ok: false, error: 'invalid_type' });
                return;
            }
            const from = typeof body.from === 'string' ? body.from : 'unknown';
            const to = typeof body.to === 'string' ? body.to : '';
            const data = typeof body.data === 'object' && body.data ? body.data : {};

            const seq = pushRtcEvent(roomCode, { kind: 'rtc', type, from, to, ip, data });
            console.log(`[HTTP] ${ip} POST /rtc/push room=${roomCode} type=${type} from=${from} to=${to || '*'} -> seq=${seq}`);
            json(res, 200, { ok: true, seq });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/rtc/poll') {
            const roomCode = normalizeRoomCode(url.searchParams.get('roomCode') || '');
            if (!isValidRoomCode(roomCode)) {
                console.log(`[HTTP] ${ip} GET /rtc/poll -> invalid_room_code`);
                json(res, 400, { ok: false, error: 'invalid_room_code' });
                return;
            }
            const since = Number(url.searchParams.get('since') || '0') || 0;
            const to = (url.searchParams.get('to') || '').toString();

            const r = getRtcRoom(roomCode);
            const events = r.events.filter((e) => e.seq > since && (!to || !e.to || e.to === to));
            if (events.length > 0) {
                console.log(`[HTTP] ${ip} GET /rtc/poll room=${roomCode} since=${since} to=${to || '*'} -> ${events.length} event(s), now=${r.seq}`);
            }
            json(res, 200, { ok: true, now: r.seq, events });
            return;
        }

        // Fallback
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    } catch (e) {
        console.error('[HTTP Error]', e);
        try { json(res, 500, { ok: false, error: 'server_error' }); } catch {}
    }
});

const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_EXTERNAL_HOSTNAME;
const HEALTH_CHECK_INTERVAL = 10 * 60 * 1000;

if (RENDER_URL) {
    const baseUrl = RENDER_URL.startsWith('http') ? RENDER_URL : `https://${RENDER_URL}`;
    const isHttps = baseUrl.startsWith('https');
    const httpModule = isHttps ? https : http;
    
    console.log(`[Health Check] 자동 ping 시작: ${baseUrl} (${HEALTH_CHECK_INTERVAL / 1000}초마다)`);

    const performHealthCheck = () => {
        httpModule.get(baseUrl, (res) => {
            console.log(`[Health Check] 성공: ${res.statusCode} (${new Date().toLocaleTimeString()})`);
        }).on('error', (err) => {
            console.log(`[Health Check] 오류: ${err.message} (${new Date().toLocaleTimeString()})`);
        });
    };

    setTimeout(performHealthCheck, 5000);
    setInterval(performHealthCheck, HEALTH_CHECK_INTERVAL);
} else {
    console.log('[Health Check] RENDER_EXTERNAL_URL 환경 변수가 설정되지 않았습니다.');
    console.log('[Health Check] Render 대시보드에서 환경 변수를 설정하거나, 외부 서비스(UptimeRobot 등)를 사용하세요.');
}

const wss = new WebSocket.Server({ server });

console.log(`서버가 ${port} 포트에서 시작되었습니다.`);

const rooms = {}; // roomCode -> Set of WebSocket clients

wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[연결됨] IP: ${ip}`);

    ws.isAlive = true;
    ws.roomID = null;
    ws.isHost = false;
    ws.clientIP = ip; // 클라이언트 IP 저장 (호스트 IP 전달용)

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        if (!Buffer.isBuffer(data) || data.length === 0) return;

        try {
            const msgId = data.readUInt8(0);

            // 방 코드 등록 (200)
            if (msgId === 200) {
                let rawString = data.toString('utf8', 1);
                const roomCode = rawString.replace(/\0/g, '').trim();
                
                // 이미 방에 등록된 클라이언트는 다시 등록하지 않음
                if (ws.roomID === roomCode && rooms[roomCode] && rooms[roomCode].has(ws)) {
                    return; // 이미 등록됨, 무시
                }
                
                ws.roomID = roomCode;
                
                if (!rooms[roomCode]) {
                    rooms[roomCode] = new Set();
                    ws.isHost = true;
                    console.log(`[방 생성] 코드: ${roomCode} (호스트)`);
                } else {
                    ws.isHost = false;
                    console.log(`[입장] 방: ${roomCode} (클라이언트)`);
                    
                    // 클라이언트가 방에 입장할 때 호스트의 IP를 MSG_HOST_IP로 전송
                    // 호스트 찾기
                    let hostFound = false;
                    rooms[roomCode].forEach((client) => {
                        if (client.isHost && client.readyState === WebSocket.OPEN) {
                            hostFound = true;
                            // MSG_HOST_IP (201) 전송: [MSG_ID(1)][host_id(4)][host_ip(string)]
                            const hostIP = client.clientIP || '127.0.0.1';
                            const buffer = Buffer.allocUnsafe(1 + 4 + hostIP.length + 1);
                            buffer.writeUInt8(201, 0); // MSG_HOST_IP
                            buffer.writeUInt32BE(0, 1); // host_id (호스트는 항상 0)
                            buffer.write(hostIP, 5, 'utf8');
                            buffer.writeUInt8(0, 5 + hostIP.length); // null terminator
                            
                            ws.send(buffer);
                            console.log(`[호스트 IP 전송] 방: ${roomCode}, 호스트 IP: ${hostIP} -> 클라이언트`);
                        }
                    });
                    
                    if (!hostFound) {
                        console.log(`[경고] 방: ${roomCode}에 호스트가 없습니다.`);
                    }
                }
                rooms[roomCode].add(ws);
                console.log(`[현재 인원] 방: ${roomCode} / ${rooms[roomCode].size}명`);
                return;
            }

            // 모든 패킷을 방의 다른 클라이언트들에게 중계
            if (ws.roomID && rooms[ws.roomID]) {
                rooms[ws.roomID].forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(data);
                    }
                });
            }
        } catch (e) {
            console.error('[오류]', e);
        }
    });

    ws.on('close', () => {
        if (ws.roomID && rooms[ws.roomID]) {
            rooms[ws.roomID].delete(ws);
            if (rooms[ws.roomID].size === 0) {
                delete rooms[ws.roomID];
                console.log(`[방 삭제] ${ws.roomID}`);
            } else {
                console.log(`[퇴장] 방: ${ws.roomID} / 현재 인원: ${rooms[ws.roomID].size}`);
            }
        }
    });
});

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(port, '0.0.0.0', () => {
    console.log(`Listening on port ${port}`);
});