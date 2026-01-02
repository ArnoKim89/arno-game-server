const WebSocket = require('ws');

const port = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: port });

console.log(`서버가 ${port} 포트에서 시작되었습니다.`);

const rooms = {};

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
                // 방에 입장하지 않은 상태로 패킷을 보내면 무시됨 (이게 현재 문제의 원인일 수 있음)
                // console.log(`[무시됨] 방 미입장 상태에서 패킷 수신: ${msgId}`);
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

// (Ping/Pong Interval 코드는 기존과 동일하게 유지)
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);