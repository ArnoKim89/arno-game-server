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
const HEALTH_CHECK_INTERVAL = 10 * 60 * 1000; // 10분마다 (15분 전에 체크)

if (RENDER_URL) {
    // HTTP 또는 HTTPS URL인지 확인
    const baseUrl = RENDER_URL.startsWith('http') ? RENDER_URL : `https://${RENDER_URL}`;
    const isHttps = baseUrl.startsWith('https');
    const httpModule = isHttps ? https : http;
    
    console.log(`[Health Check] 자동 ping 시작: ${baseUrl} (${HEALTH_CHECK_INTERVAL / 1000}초마다)`);
    
    // Health check 함수
    const performHealthCheck = () => {
        httpModule.get(baseUrl, (res) => {
            console.log(`[Health Check] 성공: ${res.statusCode} (${new Date().toLocaleTimeString()})`);
        }).on('error', (err) => {
            console.log(`[Health Check] 오류: ${err.message} (${new Date().toLocaleTimeString()})`);
        });
    };
    
    // 서버 시작 후 즉시 한 번 실행
    setTimeout(performHealthCheck, 5000); // 서버 시작 후 5초 대기
    
    // 주기적으로 health check 실행
    setInterval(performHealthCheck, HEALTH_CHECK_INTERVAL);
} else {
    console.log('[Health Check] RENDER_EXTERNAL_URL 환경 변수가 설정되지 않았습니다.');
    console.log('[Health Check] Render 대시보드에서 환경 변수를 설정하거나, 외부 서비스(UptimeRobot 등)를 사용하세요.');
}

// HTTP 서버 위에 웹소켓 올리기
const wss = new WebSocket.Server({ server });

console.log(`서버가 ${port} 포트에서 시작되었습니다.`);

const rooms = {};
const BLOCKED_PACKETS = [12];

wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[연결됨] IP: ${ip}`);

    ws.isAlive = true;
    ws.roomID = null;
    ws.isHost = false;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        // 유효성 검사
        if (!Buffer.isBuffer(data) || data.length === 0) return;

        try {
            const msgId = data.readUInt8(0);

            if (BLOCKED_PACKETS.includes(msgId)) {
                return; 
            }

            // 방 코드 등록 (200)
            if (msgId === 200) {
                let rawString = data.toString('utf8', 1);
                const roomCode = rawString.replace(/\0/g, '').trim();
                
                ws.roomID = roomCode;
                
                if (!rooms[roomCode]) {
                    rooms[roomCode] = new Set();
                    ws.isHost = true; // 첫 번째 클라이언트가 호스트
                    console.log(`[방 생성] 코드: ${roomCode} (호스트)`);
                } else {
                    ws.isHost = false;
                    console.log(`[입장] 방: ${roomCode} (클라이언트)`);
                }
                rooms[roomCode].add(ws);
                console.log(`[현재 인원] 방: ${roomCode} / ${rooms[roomCode].size}명`);
                return;
            }

            // 모든 게임 패킷을 같은 방의 다른 클라이언트들에게 중계
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