const WebSocket = require('ws');

const port = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: port });

console.log(`서버가 ${port} 포트에서 시작되었습니다.`);

const rooms = {};

wss.on('connection', (ws, req) => {
    // 접속 시도 로그 (IP 등 확인)
    const ip = req.socket.remoteAddress;
    console.log(`[연결 시도] 새로운 클라이언트 접속: ${ip}`);

    ws.isAlive = true;
    ws.roomID = null;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        // 데이터 수신 로그
        console.log(`[데이터 수신] 길이: ${data.length}`);

        if (!Buffer.isBuffer(data)) return;

        const msgId = data.readUInt8(0);

        // [200] 방 만들기 / 참가
        if (msgId === 200) {
            const roomCode = data.toString('utf8', 1);
            ws.roomID = roomCode;
            
            if (!rooms[roomCode]) {
                rooms[roomCode] = new Set();
                console.log(`[방 생성] 코드: ${roomCode}`);
            }
            rooms[roomCode].add(ws);
            console.log(`[입장] ${roomCode} 방 인원: ${rooms[roomCode].size}`);
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
    });

    ws.on('close', () => {
        console.log('[연결 종료] 클라이언트 퇴장');
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