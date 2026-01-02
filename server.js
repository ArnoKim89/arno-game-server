const WebSocket = require('ws');

const port = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: port });

console.log(`서버가 ${port} 포트에서 시작되었습니다.`);

const rooms = {};

wss.on('connection', (ws, req) => {
    // 접속자 IP 확인 (실제 유저인지 헬스체크인지 구별)
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[연결 시도] IP: ${ip}`);

    ws.isAlive = true;
    ws.roomID = null;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        // [수정] 데이터 유효성 검사 (빈 패킷이면 무시)
        if (!Buffer.isBuffer(data) || data.length === 0) {
            console.log('[경고] 빈 패킷 수신됨 (무시함)');
            return;
        }

        console.log(`[데이터 수신] 길이: ${data.length}`);

        try {
            const msgId = data.readUInt8(0);

            // [200] 방 만들기 / 참가
            if (msgId === 200) {
                // 문자열 깨끗하게 처리 (널문자 제거)
                let rawString = data.toString('utf8', 1);
                const roomCode = rawString.replace(/\0/g, '').trim();
                
                ws.roomID = roomCode;
                
                if (!rooms[roomCode]) {
                    rooms[roomCode] = new Set();
                    console.log(`[방 생성] 코드: [${roomCode}]`);
                }
                rooms[roomCode].add(ws);
                console.log(`[입장] [${roomCode}] 방 인원: ${rooms[roomCode].size}`);
                return;
            }

            // 브로드캐스팅
            if (ws.roomID && rooms[ws.roomID]) {
                rooms[ws.roomID].forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(data);
                    }
                });
            }
        } catch (e) {
            console.error('[오류] 패킷 처리 중 에러:', e);
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

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);