const WebSocket = require('ws');

const port = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: port });

console.log(`서버가 ${port} 포트에서 시작되었습니다.`);

const rooms = {};

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[연결 시도] IP: ${ip}`);

    ws.isAlive = true;
    ws.roomID = null;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        // 데이터가 버퍼인지 확인
        if (!Buffer.isBuffer(data)) return;

        // [디버깅용] 들어온 데이터 길이와 내용 확인
        // console.log(`[데이터 수신] 길이: ${data.length}, 내용:`, data);

        const msgId = data.readUInt8(0);

        // [200] 방 만들기 / 참가
        if (msgId === 200) {
            // 1. 문자열로 변환 (1번째 바이트부터 끝까지)
            let rawString = data.toString('utf8', 1);
            
            // 2. ★핵심 수정★: 널 문자(\0) 및 공백 제거
            // GameMaker는 문자열 끝에 \0을 붙여서 보내는데, 이게 방 코드 불일치의 원인입니다.
            const roomCode = rawString.replace(/\0/g, '').trim();
            
            ws.roomID = roomCode;
            
            // 방 생성 또는 입장 처리
            if (!rooms[roomCode]) {
                rooms[roomCode] = new Set();
                console.log(`[방 생성] 코드: [${roomCode}] (원본길이: ${data.length})`);
            }
            rooms[roomCode].add(ws);
            console.log(`[입장] [${roomCode}] 방 인원: ${rooms[roomCode].size}`);
            return;
        }

        // 브로드캐스팅 (같은 방 사람들에게만)
        if (ws.roomID && rooms[ws.roomID]) {
            rooms[ws.roomID].forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(data);
                }
            });
        }
    });

    ws.on('close', () => {
        if (ws.roomID && rooms[ws.roomID]) {
            rooms[ws.roomID].delete(ws);
            if (rooms[ws.roomID].size === 0) {
                delete rooms[ws.roomID];
                console.log(`[방 삭제] ${ws.roomID}`);
            } else {
                console.log(`[퇴장] ${ws.roomID} 방 남은 인원: ${rooms[ws.roomID].size}`);
            }
        } else {
            console.log('[연결 종료] 방에 없는 클라이언트 퇴장');
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