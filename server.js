// server.js
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

// ------------------------
// 🔥 Firebase Admin SDK (через ENV)
// ------------------------
let admin;
if (process.env.FIREBASE_KEY_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
    admin = require("firebase-admin");
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin инициализирован");
} else {
    console.log("⚠️ Firebase отключен (нет ENV.FIREBASE_KEY_JSON)");
}

// ------------------------
// Middleware
// ------------------------
app.use(express.static("public"));
app.use(express.json()); // Для приема JSON

// ------------------------
// Users и токены
// ------------------------
let users = [];
let userTokens = {};

// ------------------------
// Эндпоинт сохранения FCM токена
// ------------------------
app.post("/save-token", (req, res) => {
    const { username, token } = req.body;
    if (!username || !token) return res.status(400).json({ success: false, msg: "Нет username или token" });
    userTokens[username] = token;
    console.log(`✅ Токен сохранен для ${username}`);
    res.json({ success: true });
});

// ------------------------
// Socket.IO события
// ------------------------
io.on("connection", (socket) => {
    console.log("Подключен:", socket.id);

    socket.on("login", (username) => {
        users.push({ id: socket.id, name: username });
        socket.username = username;
        io.emit("users", users);
        console.log(username, "вошел");
    });

    socket.on("call", (data) => {
        const target = users.find(u => u.id === data.to);
        if (!target) return;

        console.log(`📞 Звонок от ${socket.username} к ${target.name}`);

        // WebSocket
        io.to(data.to).emit("incoming-call", {
            from: socket.id,
            fromName: socket.username,
            offer: data.offer,
            trustedByName: data.trustedByName || null
        });

        // Push (если Firebase есть)
        if (admin) sendPushNotification(target.name, {
            caller: socket.username,
            call_id: Date.now().toString()
        });
    });

    async function sendPushNotification(username, callData) {
        const token = userTokens[username];
        if (!token) return console.log(`❌ Нет FCM токена для ${username}`);

        const message = {
            token: token,
            data: {
                caller: callData.caller,
                call_id: callData.call_id,
                timestamp: Date.now().toString()
            },
            android: { priority: "high", ttl: 24*60*60*1000 }
        };

        try {
            const response = await admin.messaging().send(message);
            console.log(`✅ Push отправлен ${username}:`, response);
        } catch (err) {
            console.error(`❌ Ошибка push для ${username}:`, err);
        }
    }

    socket.on("answer", (data) => {
        io.to(data.to).emit("call-answered", { from: socket.id, answer: data.answer });
    });

    socket.on("ice-candidate", (data) => {
        io.to(data.to).emit("ice-candidate", { from: socket.id, candidate: data.candidate });
    });

    socket.on("hangup", (data) => {
        io.to(data.to).emit("call-ended", { from: socket.id });
    });

    socket.on("forward-call", (data) => {
        const trusted = users.find(u => u.id === data.trustedId);
        const target = users.find(u => u.id === data.targetId);
        if (trusted && target) {
            io.to(data.trustedId).emit("forward-request", {
                callerId: socket.id,
                callerName: socket.username,
                targetId: data.targetId,
                targetName: data.targetName,
                trustedName: trusted.name
            });
        }
    });

    socket.on("forward-accept", (data) => {
        const target = users.find(u => u.id === data.targetId);
        const caller = users.find(u => u.id === data.callerId);
        const trusted = users.find(u => u.id === socket.id);
        if (target && caller && trusted) {
            io.to(data.callerId).emit("forward-approved", {
                targetId: data.targetId,
                targetName: data.targetName,
                trustedName: trusted.name
            });
        }
    });

    socket.on("forward-reject", (data) => {
        const caller = users.find(u => u.id === data.callerId);
        if (caller) io.to(data.callerId).emit("forward-rejected");
    });

    socket.on("disconnect", () => {
        if (socket.username) {
            users = users.filter(u => u.id !== socket.id);
            io.emit("users", users);
            console.log(socket.username, "вышел");
        }
    });
});

// ------------------------
// Порт
// ------------------------
const PORT = process.env.PORT || 8081;
http.listen(PORT, "0.0.0.0", () => {
    console.log("\n" + "=".repeat(50));
    console.log("🚀 СЕРВЕР AUDIAL ЗАПУЩЕН!");
    console.log("📡 Порт:", PORT);
    console.log("=".repeat(50) + "\n");
});
