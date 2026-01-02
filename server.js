const WebSocket = require('ws');

// Render가 제공하는 포트 또는 3000번 포트 사용
const port = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: port });

console.log(`서버가 ${port} 포트에서 시작되었습니다.`);

// 클라이언트들이 접속할 때마다 실행
wss.on('connection', (ws) => {
    console.log('새로운 플레이어가 접속했습니다.');

    // 클라이언트가 메시지(공격, 이동 등)를 보냈을 때
    ws.on('message', (message) => {
        // 접속한 모든 사람에게 반복문
        wss.clients.forEach((client) => {
            // "보낸 본인"이 아니고, "연결이 열려있는" 사람에게만 전송
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });

    // 접속이 끊겼을 때
    ws.on('close', () => {
        console.log('플레이어가 나갔습니다.');
    });
});

// [중요] Render 서버가 잠들지 않도록 30초마다 핑(Ping) 보내기 (옵션)
setInterval(() => {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.ping();
        }
    });
}, 30000);