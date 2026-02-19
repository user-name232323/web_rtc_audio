const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

// Добавляем Firebase Admin SDK
const admin = require("firebase-admin");

// Инициализация Firebase Admin
const serviceAccount = require("./path/to/your-firebase-adminsdk.json"); // Скачаете из консоли Firebase
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

app.use(express.static("public"));
app.use(express.json()); // Для приема JSON

let users = [];
// Хранилище FCM токенов (в реальности используйте базу данных)
let userTokens = {};

// Эндпоинт для сохранения FCM токена с телефона
app.post("/save-token", (req, res) => {
    const { username, token } = req.body;
    userTokens[username] = token;
    console.log(`✅ Токен сохранен для ${username}`);
    res.json({ success: true });
});

io.on("connection", (socket) => {
    console.log("Подключен:", socket.id);

    socket.on("login", (username) => {
        users.push({id: socket.id, name: username});
        socket.username = username;
        io.emit("users", users);
        console.log(username, "вошел");
    });

    socket.on("call", (data) => {
        const target = users.find(u => u.id === data.to);
        if (target) {
            console.log(`📞 Звонок от ${socket.username} к ${target.name}`);
            
            // 1. Отправляем через WebSocket (если онлайн)
            io.to(data.to).emit("incoming-call", {
                from: socket.id,
                fromName: socket.username,
                offer: data.offer,
                trustedByName: data.trustedByName || null
            });
            
            // 2. ОТПРАВЛЯЕМ PUSH УВЕДОМЛЕНИЕ (даже если офлайн)
            sendPushNotification(target.name, {
                caller: socket.username,
                call_id: Date.now().toString()
            });
        }
    });

    // Функция отправки push
    async function sendPushNotification(username, callData) {
        const token = userTokens[username];
        if (!token) {
            console.log(`❌ Нет FCM токена для ${username}`);
            return;
        }
        
        const message = {
            token: token,
            data: {  // ВАЖНО: именно data, не notification!
                caller: callData.caller,
                call_id: callData.call_id,
                timestamp: Date.now().toString()
            },
            android: {
                priority: "high",
                ttl: 60 * 60 * 24 * 1000 // 24 часа
            }
        };
        
        try {
            const response = await admin.messaging().send(message);
            console.log(`✅ Push отправлен ${username}:`, response);
        } catch (error) {
            console.error(`❌ Ошибка push для ${username}:`, error);
        }
    }

    socket.on("answer", (data) => {
        console.log(`✅ Ответ от ${socket.username} на звонок`);
        io.to(data.to).emit("call-answered", {
            from: socket.id,
            answer: data.answer
        });
    });

    socket.on("ice-candidate", (data) => {
        io.to(data.to).emit("ice-candidate", {
            from: socket.id,
            candidate: data.candidate
        });
    });

    socket.on("hangup", (data) => {
        console.log(`📞 Завершение звонка от ${socket.username}`);
        io.to(data.to).emit("call-ended", {
            from: socket.id
        });
    });

    // ПЕРЕАДРЕСАЦИЯ
    socket.on("forward-call", (data) => {
        const trusted = users.find(u => u.id === data.trustedId);
        const target = users.find(u => u.id === data.targetId);
        
        if (trusted && target) {
            console.log(`🔄 Запрос переадресации от ${socket.username} к ${target.name} через ${trusted.name}`);
            
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
            console.log(`✅ Доверитель ${trusted.name} одобрил звонок от ${caller.name} к ${target.name}`);
            
            io.to(data.callerId).emit("forward-approved", {
                targetId: data.targetId,
                targetName: data.targetName,
                trustedName: trusted.name
            });
        }
    });

    socket.on("forward-reject", (data) => {
        const caller = users.find(u => u.id === data.callerId);
        if (caller) {
            console.log(`❌ Доверитель отклонил запрос`);
            io.to(data.callerId).emit("forward-rejected");
        }
    });

    socket.on("disconnect", () => {
        if (socket.username) {
            console.log(socket.username, "вышел");
            users = users.filter(u => u.id !== socket.id);
            io.emit("users", users);
        }
    });
});

const PORT = 8081;
http.listen(PORT, "0.0.0.0", () => {
    console.log("\n" + "=".repeat(50));
    console.log("🚀 СЕРВЕР AUDIAL ЗАПУЩЕН!");
    console.log("=".repeat(50));
    console.log(`📡 Порт: ${PORT}`);
    console.log("=".repeat(50) + "\n");
});