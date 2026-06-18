/* =============================================================
   GRANDMASTER'S HALL — Server
   =============================================================
   Features:
   - Room management (create, join, leave)
   - Random matchmaking pool (by time control)
   - Private rooms with shareable codes
   - Server-side move validation via Chess.js
   - Server-authoritative chess timer
   - Disconnection handling (30s reconnect window)
   - Live chat within game rooms
   - Draw offers
   ============================================================= */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingInterval: 10000,
    pingTimeout: 5000
});

app.use(express.static('public'));

// ===================== DATA STORES =====================

// Active games: roomId -> GameRoom
const games = new Map();

// Matchmaking queues: timeControl -> [{ socketId, sessionId }]
const matchmakingQueues = new Map();

// Session to room mapping: sessionId -> { roomId, color }
const sessionMap = new Map();

// Socket to session mapping: socketId -> sessionId
const socketToSession = new Map();

// ===================== ROOM CODE GENERATOR =====================
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I, O, 0, 1 for clarity
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    // Ensure uniqueness
    for (const [, game] of games) {
        if (game.roomCode === code) return generateRoomCode();
    }
    return code;
}

// ===================== GAME ROOM CLASS =====================
class GameRoom {
    constructor(id, timeControl, type, roomCode = null) {
        this.id = id;
        this.chess = new Chess();
        this.type = type;           // 'matchmaking' | 'private'
        this.roomCode = roomCode;
        this.status = 'waiting';    // 'waiting' | 'playing' | 'ended'
        this.timeControl = timeControl; // ms
        this.timers = {
            w: timeControl,
            b: timeControl
        };
        this.lastMoveTime = null;
        this.timerInterval = null;

        this.players = {
            w: null, // { socketId, sessionId }
            b: null
        };

        this.disconnectTimers = {};  // sessionId -> timeout
        this.moveHistory = [];
        this.lastMove = null;
    }

    addPlayer(socketId, sessionId, color) {
        this.players[color] = { socketId, sessionId };
        sessionMap.set(sessionId, { roomId: this.id, color });
        socketToSession.set(socketId, sessionId);
    }

    getPlayerColor(socketId) {
        if (this.players.w && this.players.w.socketId === socketId) return 'w';
        if (this.players.b && this.players.b.socketId === socketId) return 'b';
        return null;
    }

    getPlayerColorBySession(sessionId) {
        if (this.players.w && this.players.w.sessionId === sessionId) return 'w';
        if (this.players.b && this.players.b.sessionId === sessionId) return 'b';
        return null;
    }

    getOpponentSocketId(color) {
        const oppColor = color === 'w' ? 'b' : 'w';
        return this.players[oppColor] ? this.players[oppColor].socketId : null;
    }

    isFull() {
        return this.players.w !== null && this.players.b !== null;
    }

    startGame() {
        this.status = 'playing';
        this.lastMoveTime = Date.now();
        this.startServerTimer();
    }

    // Server-side timer
    startServerTimer() {
        if (this.timeControl <= 0) return;
        this.stopServerTimer();

        this.timerInterval = setInterval(() => {
            if (this.status !== 'playing') {
                this.stopServerTimer();
                return;
            }

            const now = Date.now();
            const elapsed = now - this.lastMoveTime;
            const activeColor = this.chess.turn();
            const currentTime = this.timers[activeColor] - elapsed;

            if (currentTime <= 0) {
                this.timers[activeColor] = 0;
                this.stopServerTimer();
                this.status = 'ended';

                const winner = activeColor === 'w' ? 'Black' : 'White';
                io.to(this.id).emit('timeOut', { winner });
                this.cleanup();
            }
        }, 500);
    }

    stopServerTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    // Called after a valid move
    switchTimer() {
        if (this.timeControl <= 0) return;

        const now = Date.now();
        const elapsed = now - this.lastMoveTime;
        const prevColor = this.chess.turn() === 'w' ? 'b' : 'w'; // The color that just moved
        this.timers[prevColor] = Math.max(0, this.timers[prevColor] - elapsed);
        this.lastMoveTime = now;
    }

    getTimerState() {
        if (this.timeControl <= 0) return null;

        // Calculate current timer with elapsed time
        const now = Date.now();
        const elapsed = this.lastMoveTime ? (now - this.lastMoveTime) : 0;
        const activeColor = this.chess.turn();
        const result = { ...this.timers };
        result[activeColor] = Math.max(0, result[activeColor] - elapsed);
        return result;
    }

    cleanup() {
        this.stopServerTimer();
        // Clear disconnect timers
        for (const sid in this.disconnectTimers) {
            clearTimeout(this.disconnectTimers[sid]);
        }
        // Don't remove immediately to allow reconnection viewing
        setTimeout(() => {
            games.delete(this.id);
            // Clean session maps
            for (const color of ['w', 'b']) {
                if (this.players[color]) {
                    sessionMap.delete(this.players[color].sessionId);
                }
            }
        }, 60000); // Clean up after 1 minute
    }
}

// ===================== SOCKET.IO HANDLERS =====================
io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id}`);

    // ---- Matchmaking ----
    socket.on('findMatch', ({ timeControl, sessionId }) => {
        socketToSession.set(socket.id, sessionId);

        // Check if already in a game
        const existing = sessionMap.get(sessionId);
        if (existing && games.has(existing.roomId)) {
            const game = games.get(existing.roomId);
            if (game.status === 'playing') {
                socket.emit('matchError', 'You are already in an active game.');
                return;
            }
        }

        const queueKey = timeControl;
        if (!matchmakingQueues.has(queueKey)) {
            matchmakingQueues.set(queueKey, []);
        }

        const queue = matchmakingQueues.get(queueKey);

        // Remove any existing entry for this session
        const existingIdx = queue.findIndex(e => e.sessionId === sessionId);
        if (existingIdx !== -1) queue.splice(existingIdx, 1);

        // Check if there's an opponent waiting
        if (queue.length > 0) {
            const opponent = queue.shift();

            // Create game room
            const roomId = 'match_' + uuidv4().substring(0, 8);
            const game = new GameRoom(roomId, timeControl, 'matchmaking');

            // Randomly assign colors
            const rand = Math.random();
            const whiteSessionId = rand < 0.5 ? sessionId : opponent.sessionId;
            const blackSessionId = rand < 0.5 ? opponent.sessionId : sessionId;
            const whiteSocketId = whiteSessionId === sessionId ? socket.id : opponent.socketId;
            const blackSocketId = whiteSessionId === sessionId ? opponent.socketId : socket.id;

            game.addPlayer(whiteSocketId, whiteSessionId, 'w');
            game.addPlayer(blackSocketId, blackSessionId, 'b');

            games.set(roomId, game);

            // Join socket room
            const whiteSocket = io.sockets.sockets.get(whiteSocketId);
            const blackSocket = io.sockets.sockets.get(blackSocketId);

            if (whiteSocket) whiteSocket.join(roomId);
            if (blackSocket) blackSocket.join(roomId);

            game.startGame();

            // Notify both players
            if (whiteSocket) {
                whiteSocket.emit('matchFound', {
                    roomId, color: 'w', timeControl
                });
            }
            if (blackSocket) {
                blackSocket.emit('matchFound', {
                    roomId, color: 'b', timeControl
                });
            }

            console.log(`[Match] ${roomId}: White=${whiteSessionId}, Black=${blackSessionId}`);
        } else {
            // Add to queue
            queue.push({ socketId: socket.id, sessionId });
            console.log(`[Queue] ${sessionId} waiting for match (tc=${timeControl})`);
        }
    });

    socket.on('cancelMatch', () => {
        const sessionId = socketToSession.get(socket.id);
        if (!sessionId) return;

        for (const [, queue] of matchmakingQueues) {
            const idx = queue.findIndex(e => e.sessionId === sessionId);
            if (idx !== -1) {
                queue.splice(idx, 1);
                console.log(`[Queue] ${sessionId} cancelled matchmaking`);
                break;
            }
        }
    });

    // ---- Private Rooms ----
    socket.on('createRoom', ({ timeControl, sessionId }) => {
        socketToSession.set(socket.id, sessionId);

        const roomId = 'room_' + uuidv4().substring(0, 8);
        const roomCode = generateRoomCode();
        const game = new GameRoom(roomId, timeControl, 'private', roomCode);

        game.addPlayer(socket.id, sessionId, 'w');
        games.set(roomId, game);
        socket.join(roomId);

        socket.emit('roomCreated', { roomId, roomCode });
        console.log(`[Room] Created ${roomCode} (${roomId}) by ${sessionId}`);
    });

    socket.on('joinRoom', ({ roomCode, sessionId }) => {
        socketToSession.set(socket.id, sessionId);

        // Find room by code
        let targetGame = null;
        for (const [, game] of games) {
            if (game.roomCode === roomCode.toUpperCase() && game.status === 'waiting') {
                targetGame = game;
                break;
            }
        }

        if (!targetGame) {
            socket.emit('roomError', 'Room not found or already full.');
            return;
        }

        if (targetGame.players.w && targetGame.players.w.sessionId === sessionId) {
            socket.emit('roomError', 'You cannot join your own room.');
            return;
        }

        targetGame.addPlayer(socket.id, sessionId, 'b');
        socket.join(targetGame.id);

        targetGame.startGame();

        // Notify both players
        socket.emit('roomJoined', {
            roomId: targetGame.id,
            roomCode: targetGame.roomCode,
            color: 'b',
            timeControl: targetGame.timeControl
        });

        const whiteSocket = io.sockets.sockets.get(targetGame.players.w.socketId);
        if (whiteSocket) {
            whiteSocket.emit('opponentJoined', {
                timeControl: targetGame.timeControl
            });
        }

        console.log(`[Room] ${sessionId} joined ${roomCode}`);
    });

    socket.on('leaveRoom', (roomId) => {
        const game = games.get(roomId);
        if (!game) return;

        const color = game.getPlayerColor(socket.id);
        if (color) {
            game.players[color] = null;
        }
        socket.leave(roomId);

        if (!game.players.w && !game.players.b) {
            game.cleanup();
            games.delete(roomId);
        }
    });

    // ---- Moves ----
    socket.on('makeMove', ({ roomId, move }) => {
        const game = games.get(roomId);
        if (!game || game.status !== 'playing') return;

        // Verify it's this player's turn
        const color = game.getPlayerColor(socket.id);
        if (!color || game.chess.turn() !== color) return;

        try {
            const result = game.chess.move(move);
            if (result) {
                game.switchTimer();
                game.lastMove = { from: result.from, to: result.to };
                game.moveHistory.push(result);

                const timerState = game.getTimerState();

                io.to(roomId).emit('moveMade', {
                    fen: game.chess.fen(),
                    move: result,
                    timers: timerState
                });

                // Check game end
                if (game.chess.isCheckmate()) {
                    const winner = game.chess.turn() === 'w' ? 'Black' : 'White';
                    game.status = 'ended';
                    game.stopServerTimer();
                    io.to(roomId).emit('gameOver', {
                        reason: 'checkmate',
                        winner
                    });
                    game.cleanup();
                } else if (game.chess.isDraw() || game.chess.isStalemate()) {
                    game.status = 'ended';
                    game.stopServerTimer();
                    io.to(roomId).emit('gameOver', {
                        reason: game.chess.isStalemate() ? 'stalemate' : 'draw',
                        winner: null
                    });
                    game.cleanup();
                }
            }
        } catch (e) {
            socket.emit('invalidMove', move);
        }
    });

    // ---- Resign ----
    socket.on('resign', (roomId) => {
        const game = games.get(roomId);
        if (!game || game.status !== 'playing') return;

        const color = game.getPlayerColor(socket.id);
        if (!color) return;

        game.status = 'ended';
        game.stopServerTimer();
        const winner = color === 'w' ? 'Black' : 'White';

        io.to(roomId).emit('gameOver', { reason: 'resign', winner });
        game.cleanup();
    });

    // ---- Draw ----
    socket.on('offerDraw', (roomId) => {
        const game = games.get(roomId);
        if (!game || game.status !== 'playing') return;

        const color = game.getPlayerColor(socket.id);
        if (!color) return;

        const oppSocketId = game.getOpponentSocketId(color);
        if (oppSocketId) {
            const oppSocket = io.sockets.sockets.get(oppSocketId);
            if (oppSocket) oppSocket.emit('drawOffered');
        }
    });

    socket.on('drawResponse', ({ roomId, accept }) => {
        const game = games.get(roomId);
        if (!game || game.status !== 'playing') return;

        const color = game.getPlayerColor(socket.id);
        if (!color) return;

        const oppSocketId = game.getOpponentSocketId(color);

        if (accept) {
            game.status = 'ended';
            game.stopServerTimer();
            io.to(roomId).emit('drawAccepted');
            io.to(roomId).emit('gameOver', { reason: 'draw', winner: null });
            game.cleanup();
        } else {
            if (oppSocketId) {
                const oppSocket = io.sockets.sockets.get(oppSocketId);
                if (oppSocket) oppSocket.emit('drawDeclined');
            }
        }
    });

    // ---- Chat ----
    socket.on('sendChat', ({ roomId, message }) => {
        const game = games.get(roomId);
        if (!game) return;

        const color = game.getPlayerColor(socket.id);
        const senderName = color === 'w' ? 'White' : (color === 'b' ? 'Black' : 'Spectator');

        // Sanitize message
        const cleanMsg = message.substring(0, 500).trim();
        if (!cleanMsg) return;

        io.to(roomId).emit('chatMessage', {
            sender: senderName,
            text: cleanMsg,
            type: 'normal'
        });
    });

    // ---- Reconnection ----
    socket.on('reconnect', ({ roomId, sessionId }) => {
        const game = games.get(roomId);
        if (!game) return;

        const color = game.getPlayerColorBySession(sessionId);
        if (!color) return;

        // Update socket ID
        game.players[color].socketId = socket.id;
        socketToSession.set(socket.id, sessionId);
        socket.join(roomId);

        // Clear disconnect timer
        if (game.disconnectTimers[sessionId]) {
            clearTimeout(game.disconnectTimers[sessionId]);
            delete game.disconnectTimers[sessionId];
        }

        // Notify opponent
        const oppSocketId = game.getOpponentSocketId(color);
        if (oppSocketId) {
            const oppSocket = io.sockets.sockets.get(oppSocketId);
            if (oppSocket) oppSocket.emit('opponentReconnected');
        }

        // Send current state
        socket.emit('reconnected', {
            roomId,
            color,
            fen: game.chess.fen(),
            timers: game.getTimerState(),
            lastMove: game.lastMove,
            history: game.chess.history({ verbose: true })
        });

        console.log(`[Reconnect] ${sessionId} rejoined ${roomId}`);
    });

    // ---- Disconnect ----
    socket.on('disconnect', () => {
        const sessionId = socketToSession.get(socket.id);
        console.log(`[-] Disconnected: ${socket.id} (session: ${sessionId})`);

        // Remove from matchmaking queues
        if (sessionId) {
            for (const [, queue] of matchmakingQueues) {
                const idx = queue.findIndex(e => e.sessionId === sessionId);
                if (idx !== -1) {
                    queue.splice(idx, 1);
                    break;
                }
            }
        }

        // Handle active game disconnection
        if (sessionId) {
            const sessionInfo = sessionMap.get(sessionId);
            if (sessionInfo) {
                const game = games.get(sessionInfo.roomId);
                if (game && game.status === 'playing') {
                    const color = sessionInfo.color;
                    const oppSocketId = game.getOpponentSocketId(color);

                    // Notify opponent
                    if (oppSocketId) {
                        const oppSocket = io.sockets.sockets.get(oppSocketId);
                        if (oppSocket) {
                            oppSocket.emit('opponentDisconnected');
                            oppSocket.emit('chatMessage', {
                                sender: 'System',
                                text: `${color === 'w' ? 'White' : 'Black'} disconnected. Waiting 30 seconds...`,
                                type: 'system'
                            });
                        }
                    }

                    // Start 30-second timer
                    game.disconnectTimers[sessionId] = setTimeout(() => {
                        if (game.status !== 'playing') return;

                        game.status = 'ended';
                        game.stopServerTimer();
                        const winner = color === 'w' ? 'Black' : 'White';

                        io.to(game.id).emit('gameOver', {
                            reason: 'disconnect',
                            winner
                        });

                        game.cleanup();
                        console.log(`[Disconnect] ${sessionId} timed out. ${winner} wins.`);
                    }, 30000);
                }
            }
        }

        socketToSession.delete(socket.id);
    });
});

// ===================== SERVER START =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n  ♚ Grandmaster's Hall Server ♚`);
    console.log(`  Listening on http://localhost:${PORT}`);
    console.log(`  Press Ctrl+C to stop\n`);
});
