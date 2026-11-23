const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ให้ Server เปิดไฟล์หน้าเว็บเกมในโฟลเดอร์ public
app.use(express.static(path.join(__dirname, "public")));

const players = {};

io.on("connection", (socket) => {
  // สร้างข้อมูลผู้เล่นเมื่อเข้าเกม
  players[socket.id] = { x: 100, y: 100 };
  io.emit("updatePlayers", players);

  // รับตำแหน่งใหม่เมื่อผู้เล่นขยับ แล้วส่งต่อให้ทุกคน
  socket.on("move", (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      io.emit("updatePlayers", players);
    }
  });

  // ลบตัวละครเมื่อผู้เล่นปิดหน้าเว็บ
  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("updatePlayers", players);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server is running on port " + PORT);
});
