const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

// ------------------------
// 🔥 Firebase Admin SDK (через Secret File)
// ------------------------
let admin;
try {
    admin = require("firebase-admin");
    const fs = require('fs');
    
    // Путь к секретному файлу на Render
    const secretFilePath = '/etc/secrets/serviceAccountKey.json';
    
    if (fs.existsSync(secretFilePath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(secretFilePath, 'utf8'));
        
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase успешно инициализирован из секретного файла!");
        console.log("📁 Файл загружен:", secretFilePath);
    } else {
        console.log("⚠️ Firebase отключен - файл не найден по пути:", secretFilePath);
        console.log("📁 Текущая директория:", process.cwd());
        console.log("📁 Содержимое /etc/secrets:", fs.readdirSync('/etc/secrets').join(', '));
    }
} catch (error) {
    console.error("❌ Ошибка инициализации Firebase:", error.message);
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
// Функция отправки push для обычного звонка (СО ЗВУКОМ)
// ------------------------
async function sendPushNotification(username, callData) {
    const token = userTokens[username];
    if (!token) {
        console.log(`❌ Нет FCM токена для ${username}`);
        return;
    }

    console.log(`📤 Данные для push (звонок):`, callData);

    const message = {
        token: token,
        data: {
            type: "call",
            caller: callData.caller || "Неизвестный",
            call_id: callData.call_id || Date.now().toString(),
            timestamp: Date.now().toString()
        },
        android: { 
            priority: "high", 
            ttl: 24 * 60 * 60 * 1000,
            notification: {  // 🔥 ДОБАВЛЕН ЗВУК
                title: "📞 Входящий звонок",
                body: `Звонит ${callData.caller || "Неизвестный"}`,
                sound: "default",
                channelId: "incoming_calls",
                priority: "high",
                vibrate: [1000, 500, 1000, 500],
                color: "#764ba2",
                icon: "ic_notification",
                clickAction: "OPEN_ACTIVITY",
                tag: "call_notification"
            }
        }
    };

    try {
        const response = await admin.messaging().send(message);
        console.log(`✅ Push отправлен ${username}:`, response);
    } catch (err) {
        console.error(`❌ Ошибка push для ${username}:`, err.message);
    }
}

// ------------------------
// Функция отправки push для переадресации (СО ЗВУКОМ)
// ------------------------
async function sendForwardPushNotification(username, forwardData) {
    const token = userTokens[username];
    if (!token) {
        console.log(`❌ Нет FCM токена для ${username} (переадресация)`);
        return;
    }

    console.log(`📤 Данные для push (переадресация):`, forwardData);

    const message = {
        token: token,
        data: {
            type: "forward_request",
            callerName: forwardData.callerName,
            targetName: forwardData.targetName,
            callerId: forwardData.callerId,
            targetId: forwardData.targetId,
            requestId: forwardData.requestId || Date.now().toString(),
            timestamp: Date.now().toString()
        },
        android: { 
            priority: "high",
            ttl: 24 * 60 * 60 * 1000,
            notification: {  // 🔥 ДОБАВЛЕН ЗВУК
                title: "🔄 Запрос переадресации",
                body: `${forwardData.callerName} хочет позвонить ${forwardData.targetName} через вас`,
                sound: "default",
                channelId: "incoming_calls",
                priority: "high",
                vibrate: [1000, 500, 1000, 500],
                color: "#9c27b0",
                icon: "ic_forward",
                clickAction: "OPEN_ACTIVITY",
                tag: "forward_notification"
            }
        }
    };

    try {
        const response = await admin.messaging().send(message);
        console.log(`✅ Push переадресации отправлен ${username}:`, response);
    } catch (err) {
        console.error(`❌ Ошибка push переадресации для ${username}:`, err.message);
    }
}

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
        console.log(`📞 socket.username = ${socket.username}`);

        // WebSocket (всегда)
        io.to(data.to).emit("incoming-call", {
            from: socket.id,
            fromName: socket.username,
            offer: data.offer,
            trustedByName: data.trustedByName || null
        });

        // Push уведомление (если Firebase есть)
        if (admin) {
            sendPushNotification(target.name, {
                caller: socket.username,
                call_id: Date.now().toString()
            });
        } else {
            console.log("⚠️ Firebase не инициализирован, push не отправлен");
        }
    });

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

    // Переадресация
    socket.on("forward-call", (data) => {
        const trusted = users.find(u => u.id === data.trustedId);
        const target = users.find(u => u.id === data.targetId);
        
        if (trusted && target) {
            console.log(`🔄 Запрос переадресации от ${socket.username} к ${target.name} через ${trusted.name}`);
            
            // Отправляем через WebSocket
            io.to(data.trustedId).emit("forward-request", {
                callerId: socket.id,
                callerName: socket.username,
                targetId: data.targetId,
                targetName: data.targetName,
                trustedName: trusted.name
            });

            // Push для доверителя
            if (admin) {
                sendForwardPushNotification(trusted.name, {
                    callerName: socket.username,
                    targetName: target.name,
                    callerId: socket.id,
                    targetId: data.targetId,
                    requestId: Date.now().toString()
                });
            }
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