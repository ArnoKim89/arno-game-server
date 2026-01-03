const http = require('http');
const WebSocket = require('ws');

const port = process.env.PORT || 3000;

// [수정 1] HTTP 서버 생성 (Render Health Check용)
// Render가 포트로 접속했을 때 "나 살아있어"라고 응답해주는 역할입니다.
const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Game Server is Running...');
    }
});

// [수정 2] WebSocket 서버를 HTTP 서버 위에 얹기
const wss = new WebSocket.Server({ server });

console.log(`서버가 ${port} 포트에서 시작되었습니다.`);

const rooms = {};

// [설정] 차단할 패킷 ID 목록 (여기에 MSG_PLAYER_HIT 번호를 넣으면 서버가 아예 중계를 안 함)
// 예: GML에서 MSG_PLAYER_HIT가 30번이라면 [30] 이렇게 적으세요.
const BLOCKED_PACKETS = []; 

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

            // [추가] 서버 차원에서 특정 패킷 차단 (체력 동기화 문제 원천 봉쇄)
            if (BLOCKED_PACKETS.includes(msgId)) {
                return; // 아무것도 안 하고 함수 종료 (중계 안 함)
            }

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
            } else {
                // 방 미입장 상태 패킷 무시
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

// [수정 3] 서버 리스닝 시작
server.listen(port, () => {
    console.log(`Listening on port ${port}`);
});