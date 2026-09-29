const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

// Game State Storage
const rooms = new Map();

// Helper to generate unique 5-character alphanumeric room codes
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluded confusing chars like O/0, I/1
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

// Map configuration templates
const MAP_CONFIGS = [
  { id: 'warehouse', name: 'Industrial Warehouse' },
  { id: 'workshop', name: 'Craft Workshop' },
  { id: 'storage', name: 'Storage Yard' }
];

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerId = socket.id;

  // Create Private Room
  socket.on('create_room', ({ nickname }) => {
    const roomCode = generateRoomCode();
    const player = {
      id: playerId,
      nickname: nickname || 'Player_' + playerId.substring(0, 4),
      isHost: true,
      role: 'hider', // default
      x: 0, y: 1, z: 0,
      rotationY: 0,
      color: '#' + Math.floor(Math.random()*16777215).toString(16),
      isEliminated: false,
      paintTextureId: 0
    };

    const room = {
      code: roomCode,
      hostId: playerId,
      state: 'WAITING', // WAITING, HIDING, PLAYING, ROUND_END
      players: new Map([[playerId, player]]),
      timer: 0,
      timerInterval: null,
      maxPlayers: 16,
      mapId: MAP_CONFIGS[Math.floor(Math.random() * MAP_CONFIGS.length)].id,
      hidingDuration: 20,
      playingDuration: 120
    };

    rooms.set(roomCode, room);
    currentRoom = roomCode;
    socket.join(roomCode);

    socket.emit('room_created', {
      roomCode,
      player,
      players: Array.from(room.players.values()),
      state: room.state,
      isHost: true
    });
  });

  // Join Existing Room
  socket.on('join_room', ({ roomCode, nickname }) => {
    const cleanCode = roomCode.toUpperCase().trim();
    const room = rooms.get(cleanCode);

    if (!room) {
      socket.emit('error_msg', 'Room not found! Please check the code.');
      return;
    }

    if (room.players.size >= room.maxPlayers) {
      socket.emit('error_msg', 'Room is full!');
      return;
    }

    if (room.state !== 'WAITING') {
      socket.emit('error_msg', 'Game is already in progress. Try again later.');
      return;
    }

    const player = {
      id: playerId,
      nickname: nickname || 'Player_' + playerId.substring(0, 4),
      isHost: false,
      role: 'hider',
      x: 0, y: 1, z: 0,
      rotationY: 0,
      color: '#' + Math.floor(Math.random()*16777215).toString(16),
      isEliminated: false,
      paintTextureId: 0
    };

    room.players.set(playerId, player);
    currentRoom = cleanCode;
    socket.join(cleanCode);

    socket.emit('room_joined', {
      roomCode: cleanCode,
      player,
      players: Array.from(room.players.values()),
      state: room.state,
      isHost: false,
      mapId: room.mapId
    });

    io.to(cleanCode).emit('player_joined', {
      player,
      players: Array.from(room.players.values())
    });
  });

  // Start Match (Host Only)
  socket.on('start_game', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== playerId) return;
    if (room.players.size < 2) {
      socket.emit('error_msg', 'Need at least 2 players to start!');
      return;
    }

    startNewRound(room);
  });

  // Player Position Sync
  socket.on('player_move', (data) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player || player.isEliminated) return;

    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.rotationY = data.rotationY;

    socket.to(currentRoom).emit('player_moved', {
      id: playerId,
      x: player.x,
      y: player.y,
      z: player.z,
      rotationY: player.rotationY
    });
  });

  // Hider Paint Blend Action
  socket.on('apply_paint', (data) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player || player.role !== 'hider' || player.isEliminated) return;

    player.paintTextureId = data.textureId;
    io.to(currentRoom).emit('player_painted', {
      id: playerId,
      textureId: data.textureId
    });
  });

  // Seeker Shoot Action & Authoritative Hit Detection
  socket.on('shoot_water', (data) => {
    const room = rooms.get(currentRoom);
    if (!room || room.state !== 'PLAYING') return;
    const seeker = room.players.get(playerId);
    if (!seeker || seeker.role !== 'seeker') return;

    // Broadcast shoot visual effect to others
    socket.to(currentRoom).emit('water_shot', {
      origin: data.origin,
      direction: data.direction,
      shooterId: playerId
    });

    // Hit validation ray-sphere check
    const rayOrigin = data.origin;
    const rayDir = data.direction;

    room.players.forEach((target, targetId) => {
      if (target.role === 'hider' && !target.isEliminated) {
        // Distance check between ray and target cylinder/sphere
        const dx = target.x - rayOrigin.x;
        const dy = target.y - rayOrigin.y;
        const dz = target.z - rayOrigin.z;

        // Project target vector onto ray direction
        const dot = dx * rayDir.x + dy * rayDir.y + dz * rayDir.z;

        if (dot > 0 && dot < 40) { // Max weapon range 40 units
          const projX = rayOrigin.x + rayDir.x * dot;
          const projY = rayOrigin.y + rayDir.y * dot;
          const projZ = rayOrigin.z + rayDir.z * dot;

          const distSq = Math.pow(target.x - projX, 2) + Math.pow(target.y - projY, 2) + Math.pow(target.z - projZ, 2);

          // Hit threshold radius
          if (distSq < 2.25) { // 1.5 meter hit box
            target.isEliminated = true;
            io.to(currentRoom).emit('hider_eliminated', {
              hiderId: targetId,
              hiderName: target.nickname,
              seekerName: seeker.nickname
            });

            checkWinCondition(room);
          }
        }
      }
    });
  });

  // Handle Disconnection
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.players.delete(playerId);

    if (room.players.size === 0) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      rooms.delete(currentRoom);
    } else {
      // Host Migration
      if (room.hostId === playerId) {
        const nextHostId = room.players.keys().next().value;
        room.hostId = nextHostId;
        const nextHost = room.players.get(nextHostId);
        nextHost.isHost = true;
        io.to(nextHostId).emit('promoted_to_host');
      }

      io.to(currentRoom).emit('player_left', {
        id: playerId,
        players: Array.from(room.players.values())
      });

      if (room.state === 'PLAYING' || room.state === 'HIDING') {
        checkWinCondition(room);
      }
    }
  });
});

// Game Logic Routines
function startNewRound(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);

  room.state = 'HIDING';
  room.mapId = MAP_CONFIGS[Math.floor(Math.random() * MAP_CONFIGS.length)].id;

  // Calculate Seekers based on total player count rule
  const playerArray = Array.from(room.players.values());
  const totalPlayers = playerArray.length;
  const seekerCount = totalPlayers >= 6 ? 2 : 1;

  // Shuffle players randomly
  const shuffled = [...playerArray].sort(() => 0.5 - Math.random());
  
  shuffled.forEach((p, idx) => {
    p.role = idx < seekerCount ? 'seeker' : 'hider';
    p.isEliminated = false;
    p.paintTextureId = 0;
    // Spawn positions distribution
    if (p.role === 'seeker') {
      p.x = 0; p.y = 1; p.z = -20;
    } else {
      p.x = (Math.random() - 0.5) * 30;
      p.y = 1;
      p.z = Math.random() * 30;
    }
  });

  room.timer = room.hidingDuration;

  io.to(room.code).emit('round_started', {
    state: room.state,
    players: Array.from(room.players.values()),
    timer: room.timer,
    mapId: room.mapId
  });

  room.timerInterval = setInterval(() => {
    room.timer--;

    if (room.state === 'HIDING' && room.timer <= 0) {
      room.state = 'PLAYING';
      room.timer = room.playingDuration;
      io.to(room.code).emit('seekers_released', {
        state: room.state,
        timer: room.timer
      });
    } else if (room.state === 'PLAYING' && room.timer <= 0) {
      endRound(room, 'Hiders Win! Time ran out.');
    } else {
      io.to(room.code).emit('timer_update', { timer: room.timer, state: room.state });
    }
  }, 1000);
}

function checkWinCondition(room) {
  if (room.state !== 'PLAYING' && room.state !== 'HIDING') return;

  const activeHiders = Array.from(room.players.values()).filter(p => p.role === 'hider' && !p.isEliminated);

  if (activeHiders.length === 0) {
    endRound(room, 'Seekers Win! All hiders found.');
  }
}

function endRound(room, reason) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.state = 'ROUND_END';

  io.to(room.code).emit('round_ended', {
    winnerReason: reason,
    players: Array.from(room.players.values())
  });
}

server.listen(PORT, () => {
  console.log(`Chroma Hide server running on port ${PORT}`);
});
