const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Game Server is Running...');
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

const rooms = {};
// 게임 패킷은 P2P UDP로 직접 전송되므로 중계하지 않음
// Signaling 메시지만 중계: MSG_JOIN(1), MSG_HANDSHAKE(2), MSG_REJECT(65), MSG_HOST_IP(201), MSG_CLIENT_IP(202)

wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[연결됨] IP: ${ip}`);

    ws.isAlive = true;
    ws.roomID = null;
    ws.isHost = false;
    ws.clientIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

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
                    console.log(`[방 생성] 코드: ${roomCode} (호스트) 공인 IP: ${ws.clientIP}`);
                } else {
                    ws.isHost = false;
                    console.log(`[입장] 방: ${roomCode} (클라이언트) IP: ${ws.clientIP}`);
                    
                    // 클라이언트에게 호스트 공인 IP 전달 (IP 다이렉트 방식)
                    const host = Array.from(rooms[roomCode]).find(client => client.isHost);
                    if (host) {
                        // 클라이언트에게 호스트 공인 IP 전달
                        const hostIPBuff = Buffer.allocUnsafe(1 + 4 + host.clientIP.length);
                        hostIPBuff.writeUInt8(201, 0); // MSG_HOST_IP
                        hostIPBuff.writeUInt32BE(0, 1); // 호스트 ID (플레이스홀더)
                        hostIPBuff.write(host.clientIP, 5);
                        ws.send(hostIPBuff);
                        console.log(`[IP 전달] 호스트 공인 IP ${host.clientIP}를 클라이언트에게 전송 (IP 다이렉트 방식)`);
                    }
                }
                rooms[roomCode].add(ws);
                console.log(`[현재 인원] 방: ${roomCode} / ${rooms[roomCode].size}명`);
                return;
            }

            // Signaling 메시지만 중계 (MSG_JOIN, MSG_HANDSHAKE, MSG_REJECT)
            // 게임 패킷은 직접 TCP로 전송되므로 중계하지 않음
            if (msgId === 1 || msgId === 2 || msgId === 65) { // MSG_JOIN, MSG_HANDSHAKE, MSG_REJECT
                if (ws.roomID && rooms[ws.roomID]) {
                    rooms[ws.roomID].forEach((client) => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(data);
                        }
                    });
                }
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