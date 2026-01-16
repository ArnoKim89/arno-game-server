const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const port = process.env.PORT || 3000;

// ------------------------------------------------------------
// Simple HTTP signaling API (room code -> host IP/port)
// ------------------------------------------------------------
function _getClientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    return req.socket?.remoteAddress || '127.0.0.1';
}
function _sendJson(res, statusCode, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
}
function _makeRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
    let out = '';
    for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
}
function _cleanRooms(rooms) {
    const now = Date.now();
    const ttlMs = 6 * 60 * 60 * 1000; // 6h
    for (const [code, r] of Object.entries(rooms)) {
        if (!r || !r.createdAt || (now - r.createdAt) > ttlMs) delete rooms[code];
    }
}

const server = http.createServer((req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const path = url.pathname || '/';

        // CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            return res.end();
        }

        // Health check
        if (req.method === 'GET' && (path === '/' || path === '/health')) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('FOURVIVE Signaling Server is Running...');
        }

        // API: create room (host calls this after opening TCP server)
        // GET /api/room/create?port=6510
        if (req.method === 'GET' && path === '/api/room/create') {
            _cleanRooms(rooms_http);
            const portStr = url.searchParams.get('port') || '';
            const portNum = Number(portStr);
            if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
                return _sendJson(res, 400, { ok: false, error: 'invalid_port' });
            }

            let code = _makeRoomCode();
            let tries = 0;
            while (rooms_http[code] && tries < 10) { code = _makeRoomCode(); tries++; }

            const hostIp = _getClientIp(req);
            rooms_http[code] = { hostIp, port: portNum, createdAt: Date.now() };
            return _sendJson(res, 200, { ok: true, code, hostIp, port: portNum });
        }

        // API: join room (client calls this with room code)
        // GET /api/room/join?code=ABC123
        if (req.method === 'GET' && path === '/api/room/join') {
            _cleanRooms(rooms_http);
            const codeRaw = (url.searchParams.get('code') || '').toUpperCase().trim();
            if (!codeRaw) return _sendJson(res, 400, { ok: false, error: 'missing_code' });

            const room = rooms_http[codeRaw];
            if (!room) return _sendJson(res, 404, { ok: false, error: 'room_not_found' });

            return _sendJson(res, 200, { ok: true, code: codeRaw, hostIp: room.hostIp, port: room.port });
        }

        // Fallback
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server Error');
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

// Rooms for HTTP signaling API
const rooms_http = {}; // roomCode -> { hostIp, port, createdAt }

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