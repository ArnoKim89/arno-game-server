const http = require('http'); // Render Health Check용 모듈
const WebSocket = require('ws');

const port = process.env.PORT || 3000;

// Render가 서버 죽었나 살았나 찔러볼 때 응답해주는 HTTP 서버
const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Game Server is Running...');
    }
});

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

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        // 유효성 검사
        if (!Buffer.isBuffer(data) || data.length === 0) return;

        try {
            const msgId = data.readUInt8(0);

            // ▼▼▼ [수정 2] 패킷 ID를 읽자마자 차단 목록에 있으면 바로 버림 (중계 X) ▼▼▼
            if (BLOCKED_PACKETS.includes(msgId)) {
                return; 
            }
            // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

            // [200] 방 만들기 / 참가
            if (msgId === 200) {
                let rawString = data.toString('utf8', 1);
                const roomCode = rawString.replace(/\0/g, '').trim();
                
                ws.roomID = roomCode;
                
                if (!rooms[roomCode]) {
                    rooms[roomCode] = new Set();
                    console.log(`[방 생성] 코드: ${roomCode}`);
                }
                rooms[roomCode].add(ws);
                console.log(`[입장] 방: ${roomCode} / 현재 인원: ${rooms[roomCode].size}`);
                return;
            }

            // [중계] 방이 설정된 경우에만 브로드캐스트
            if (ws.roomID && rooms[ws.roomID]) {
                rooms[ws.roomID].forEach((client) => {
                    // 나(보낸 사람)를 제외하고 전송
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
            }
        }
    });
});

// Ping/Pong Interval
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// 서버 리스닝 시작
server.listen(port, () => {
    console.log(`Listening on port ${port}`);
});