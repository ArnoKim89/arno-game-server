const WebSocket = require('ws');

const port = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: port });

console.log(`서버가 ${port} 포트에서 시작되었습니다.`);

const rooms = {};

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.roomID = null;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        if (!Buffer.isBuffer(data)) return;

        const msgId = data.readUInt8(0);

        if (msgId === 200) {
            const roomCode = data.toString('utf8', 1);
            
            ws.roomID = roomCode;

            if (!rooms[roomCode]) {
                rooms[roomCode] = new Set();
                console.log(`방 생성됨: ${roomCode}`);
            }

            rooms[roomCode].add(ws);
            console.log(`클라이언트가 ${roomCode} 방에 입장. 현재 인원: ${rooms[roomCode].size}`);
            return;
        }
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
            console.log(`플레이어 퇴장. ${ws.roomID} 방 인원: ${rooms[ws.roomID].size}`);
            if (rooms[ws.roomID].size === 0) {
                delete rooms[ws.roomID];
                console.log(`방 삭제됨: ${ws.roomID}`);
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