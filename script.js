/* =============================================================
   GRANDMASTER'S HALL — Client-Side Chess Application
   =============================================================
   Features:
   - Lobby with AI / Matchmaking / Private Room / Join Room modes
   - Interactive board with Drag & Drop + Click-to-move
   - Stockfish AI via Web Worker (Easy / Medium / Grandmaster)
   - Chess Timer with server sync
   - PGN Move History
   - Multiplayer via Socket.io (matchmaking, private rooms, chat)
   - Disconnection handling (30s reconnect window)
   - Sound effects via Web Audio API
   ============================================================= */

// ===================== CONSTANTS =====================
const PIECE_IMAGES = {
    w: {
        p: 'https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg',
        n: 'https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg',
        b: 'https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg',
        r: 'https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg',
        q: 'https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg',
        k: 'https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg'
    },
    b: {
        p: 'https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg',
        n: 'https://upload.wikimedia.org/wikipedia/commons/e/ed/Chess_ndt45.svg',
        b: 'https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg',
        r: 'https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg',
        q: 'https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg',
        k: 'https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg'
    }
};

const PIECE_UNICODE = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };

const AI_SETTINGS = {
    easy:   { skill: 3,  depth: 4,  moveTime: 300  },
    medium: { skill: 10, depth: 8,  moveTime: 600  },
    hard:   { skill: 20, depth: 14, moveTime: 1500 }
};

// ===================== STATE =====================
const state = {
    mode: null,           // 'ai' | 'matchmaking' | 'private'
    game: new Chess(),
    playerColor: 'w',
    selectedSquare: null,
    lastMove: null,
    roomId: null,
    roomCode: null,
    sessionId: sessionStorage.getItem('chessSessionId') || generateSessionId(),

    // AI
    aiDifficulty: 'medium',
    stockfish: null,
    aiThinking: false,

    // Timer
    timers: { w: 300000, b: 300000 },
    timeControl: 300000,
    timerInterval: null,
    activeTimer: null,
    lastTickTime: null,

    // Multiplayer
    socket: null,
    isConnected: false,
    disconnectCountdown: null,

    // Promotion
    pendingPromotion: null,

    // Game state
    gameOver: false,
    moveHistory: []
};

function generateSessionId() {
    const id = 'sess_' + Math.random().toString(36).substring(2, 15);
    sessionStorage.setItem('chessSessionId', id);
    return id;
}

// ===================== SOUND ENGINE =====================
class SoundEngine {
    constructor() {
        this.ctx = null;
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    play(type) {
        try {
            this.init();
        } catch(e) { return; }
        switch (type) {
            case 'move':    this._knock(500, 0.05, 0.25); break;
            case 'capture': this._knock(350, 0.08, 0.35); this._knock(220, 0.06, 0.2, 0.04); break;
            case 'check':   this._tone(700, 0.08, 0.25); this._tone(900, 0.08, 0.2, 0.08); break;
            case 'castle':  this._knock(500, 0.04, 0.2); this._knock(600, 0.04, 0.2, 0.06); break;
            case 'promote': this._tone(523, 0.1, 0.2); this._tone(659, 0.1, 0.2, 0.1); this._tone(784, 0.15, 0.25, 0.2); break;
            case 'gameEnd': this._tone(440, 0.15, 0.2); this._tone(523, 0.15, 0.2, 0.18); this._tone(659, 0.25, 0.25, 0.36); break;
            case 'error':   this._tone(200, 0.15, 0.15); break;
        }
    }

    _knock(freq, dur, vol, delay = 0) {
        const t = this.ctx.currentTime + delay;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass'; filter.frequency.value = freq; filter.Q.value = 3;
        osc.type = 'sawtooth'; osc.frequency.value = freq;
        osc.connect(filter); filter.connect(gain); gain.connect(this.ctx.destination);
        gain.gain.setValueAtTime(vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.start(t); osc.stop(t + dur);
    }

    _tone(freq, dur, vol, delay = 0) {
        const t = this.ctx.currentTime + delay;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        osc.connect(gain); gain.connect(this.ctx.destination);
        gain.gain.setValueAtTime(vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.start(t); osc.stop(t + dur);
    }
}

const sound = new SoundEngine();

// ===================== DOM ELEMENTS =====================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {
    lobbyScreen: $('#lobby-screen'),
    gameScreen: $('#game-screen'),
    board: $('#chessboard'),
    status: $('#game-status'),
    coordsCol: $('#coords-col'),
    coordsRow: $('#coords-row'),
    movesList: $('#moves-list'),
    chatPanel: $('#chat-panel'),
    chatMessages: $('#chat-messages'),
    chatForm: $('#chat-form'),
    chatInput: $('#chat-input'),
    playerName: $('#player-name'),
    opponentName: $('#opponent-name'),
    playerTimer: $('#player-timer'),
    opponentTimer: $('#opponent-timer'),
    playerCaptured: $('#player-captured'),
    opponentCaptured: $('#opponent-captured'),
    modeBadge: $('#game-mode-badge'),
    roomCodeDisplay: $('#room-code-display'),
    roomCodeText: $('#room-code-text'),
    modalOverlay: $('#modal-overlay'),
    // Modals
    waitingModal: $('#waiting-modal'),
    roomCreatedModal: $('#room-created-modal'),
    disconnectModal: $('#disconnect-modal'),
    gameoverModal: $('#gameover-modal'),
    drawOfferModal: $('#draw-offer-modal'),
    promotionModal: $('#promotion-modal'),
    promotionPieces: $('#promotion-pieces'),
    // Modal content
    roomCodeBig: $('#room-code-big'),
    gameoverTitle: $('#gameover-title'),
    gameoverMessage: $('#gameover-message'),
    gameoverIcon: $('#gameover-icon'),
    countdownText: $('#countdown-text'),
    countdownProgress: $('#countdown-progress'),
};

// ===================== SCREEN MANAGEMENT =====================
function showScreen(screenId) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $(`#${screenId}`).classList.add('active');
}

function showModal(modalId) {
    $$('.modal').forEach(m => m.classList.remove('active'));
    DOM.modalOverlay.classList.add('active');
    $(`#${modalId}`).classList.add('active');
}

function hideModals() {
    DOM.modalOverlay.classList.remove('active');
    $$('.modal').forEach(m => m.classList.remove('active'));
}

// ===================== LOBBY ACTIONS =====================
function initLobbyEvents() {
    // Play vs AI
    $('#play-ai-btn').addEventListener('click', () => {
        const difficulty = $('#ai-difficulty').value;
        const timeVal = parseInt($('#ai-time').value);
        let color = $('#ai-color').value;
        if (color === 'random') color = Math.random() < 0.5 ? 'w' : 'b';

        state.mode = 'ai';
        state.aiDifficulty = difficulty;
        state.playerColor = color;
        state.timeControl = timeVal * 1000;
        state.timers = { w: state.timeControl, b: state.timeControl };

        startGame();
    });

    // Quick Match
    $('#find-match-btn').addEventListener('click', () => {
        const timeVal = parseInt($('#match-time').value);
        state.mode = 'matchmaking';
        state.timeControl = timeVal * 1000;
        connectSocket();
        state.socket.emit('findMatch', {
            timeControl: timeVal * 1000,
            sessionId: state.sessionId
        });
        showModal('waiting-modal');
    });

    $('#cancel-match-btn').addEventListener('click', () => {
        if (state.socket) state.socket.emit('cancelMatch');
        hideModals();
    });

    // Create Room
    $('#create-room-btn').addEventListener('click', () => {
        const timeVal = parseInt($('#room-time').value);
        state.mode = 'private';
        state.timeControl = timeVal * 1000;
        connectSocket();
        state.socket.emit('createRoom', {
            timeControl: timeVal * 1000,
            sessionId: state.sessionId
        });
        showModal('room-created-modal');
    });

    $('#copy-code-btn').addEventListener('click', () => {
        if (state.roomCode) {
            navigator.clipboard.writeText(state.roomCode).catch(() => {});
            $('#copy-code-btn').textContent = '✅ Copied!';
            setTimeout(() => { $('#copy-code-btn').textContent = '📋 Copy Code'; }, 2000);
        }
    });

    $('#cancel-room-btn').addEventListener('click', () => {
        if (state.socket) state.socket.emit('leaveRoom', state.roomId);
        hideModals();
    });

    // Join Room
    $('#join-room-btn').addEventListener('click', () => {
        const code = $('#room-code-input').value.trim().toUpperCase();
        if (code.length < 4) { sound.play('error'); return; }
        state.mode = 'private';
        connectSocket();
        state.socket.emit('joinRoom', {
            roomCode: code,
            sessionId: state.sessionId
        });
    });

    // Back to Lobby
    $('#back-to-lobby').addEventListener('click', () => {
        if (!state.gameOver && state.mode !== 'ai') {
            if (!confirm('Leave the game? You will forfeit.')) return;
            if (state.socket) state.socket.emit('resign', state.roomId);
        }
        cleanupGame();
        showScreen('lobby-screen');
    });

    // Game controls
    $('#resign-btn').addEventListener('click', () => {
        if (state.gameOver) return;
        if (!confirm('Are you sure you want to resign?')) return;
        if (state.mode === 'ai') {
            endGame('resign', state.playerColor === 'w' ? 'Black' : 'White');
        } else {
            state.socket.emit('resign', state.roomId);
        }
    });

    $('#draw-btn').addEventListener('click', () => {
        if (state.gameOver) return;
        if (state.mode === 'ai') {
            endGame('draw');
        } else {
            state.socket.emit('offerDraw', state.roomId);
            $('#draw-btn').textContent = '⏳ Offered...';
            $('#draw-btn').disabled = true;
        }
    });

    $('#new-game-btn').addEventListener('click', () => {
        cleanupGame();
        showScreen('lobby-screen');
    });

    // Game Over modal buttons
    $('#rematch-btn').addEventListener('click', () => {
        hideModals();
        cleanupGame();
        // Re-enter same mode
        if (state.mode === 'ai') {
            $('#play-ai-btn').click();
        } else {
            showScreen('lobby-screen');
        }
    });

    $('#lobby-btn').addEventListener('click', () => {
        hideModals();
        cleanupGame();
        showScreen('lobby-screen');
    });

    // Draw offer response
    $('#accept-draw-btn').addEventListener('click', () => {
        if (state.socket) state.socket.emit('drawResponse', { roomId: state.roomId, accept: true });
        hideModals();
    });

    $('#decline-draw-btn').addEventListener('click', () => {
        if (state.socket) state.socket.emit('drawResponse', { roomId: state.roomId, accept: false });
        hideModals();
    });

    // Copy room code in game header
    $('#copy-room-code').addEventListener('click', () => {
        if (state.roomCode) navigator.clipboard.writeText(state.roomCode).catch(() => {});
    });
}

// ===================== GAME INITIALIZATION =====================
function startGame() {
    state.game = new Chess();
    state.gameOver = false;
    state.selectedSquare = null;
    state.lastMove = null;
    state.moveHistory = [];
    state.aiThinking = false;

    // Reset timers
    if (state.timeControl > 0) {
        state.timers = { w: state.timeControl, b: state.timeControl };
    } else {
        state.timers = { w: 0, b: 0 };
    }

    // UI setup
    hideModals();
    showScreen('game-screen');

    if (state.mode === 'ai') {
        DOM.modeBadge.textContent = `vs AI (${state.aiDifficulty})`;
        DOM.chatPanel.classList.remove('visible');
        DOM.opponentName.textContent = `Stockfish (${capitalize(state.aiDifficulty)})`;
        DOM.playerName.textContent = 'You';
        DOM.roomCodeDisplay.classList.remove('visible');
        $('#draw-btn').style.display = '';
        $('#resign-btn').style.display = '';
        $('#new-game-btn').style.display = 'none';
        initStockfish();
    } else {
        DOM.chatPanel.classList.add('visible');
        DOM.opponentName.textContent = 'Opponent';
        DOM.playerName.textContent = 'You';
        if (state.roomCode) {
            DOM.roomCodeDisplay.classList.add('visible');
            DOM.roomCodeText.textContent = state.roomCode;
        }
        DOM.modeBadge.textContent = state.mode === 'matchmaking' ? 'Quick Match' : 'Private Room';
        $('#draw-btn').style.display = '';
        $('#resign-btn').style.display = '';
        $('#new-game-btn').style.display = 'none';
    }

    // Timer display
    if (state.timeControl <= 0) {
        DOM.playerTimer.classList.add('no-timer');
        DOM.opponentTimer.classList.add('no-timer');
    } else {
        DOM.playerTimer.classList.remove('no-timer');
        DOM.opponentTimer.classList.remove('no-timer');
    }

    renderBoard();
    renderMoveHistory();
    updateTimerDisplay();
    updateStatus();

    // Start timer for white
    if (state.timeControl > 0 && state.mode === 'ai') {
        startTimer();
    }

    // If AI plays white, make AI move
    if (state.mode === 'ai' && state.playerColor === 'b') {
        setTimeout(() => makeAIMove(), 500);
    }
}

function cleanupGame() {
    stopTimer();
    if (state.disconnectCountdown) {
        clearInterval(state.disconnectCountdown);
        state.disconnectCountdown = null;
    }
    state.gameOver = true;
    state.pendingPromotion = null;
    DOM.chatMessages.innerHTML = '';
    DOM.movesList.innerHTML = '<div class="moves-placeholder">Game moves will appear here...</div>';
}

// ===================== BOARD RENDERING =====================
function renderBoard() {
    DOM.board.innerHTML = '';
    const board = state.game.board();
    const isFlipped = state.playerColor === 'b';

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const vr = isFlipped ? 7 - r : r;
            const vc = isFlipped ? 7 - c : c;

            const file = String.fromCharCode(97 + vc);
            const rank = 8 - vr;
            const squareId = file + rank;
            const isDark = (vr + vc) % 2 !== 0;

            const sq = document.createElement('div');
            sq.className = `square ${isDark ? 'dark' : 'light'}`;
            sq.dataset.square = squareId;

            // Last move highlight
            if (state.lastMove) {
                if (squareId === state.lastMove.from || squareId === state.lastMove.to) {
                    sq.classList.add('last-move');
                }
            }

            // Selected highlight
            if (squareId === state.selectedSquare) {
                sq.classList.add('selected');
            }

            // Check highlight
            if (state.game.in_check()) {
                const turn = state.game.turn();
                const piece = board[vr][vc];
                if (piece && piece.type === 'k' && piece.color === turn) {
                    sq.classList.add('check');
                }
            }

            // Piece
            const piece = board[vr][vc];
            if (piece) {
                const pieceEl = document.createElement('div');
                pieceEl.className = 'piece';
                pieceEl.style.backgroundImage = `url(${PIECE_IMAGES[piece.color][piece.type]})`;
                pieceEl.draggable = true;
                pieceEl.dataset.square = squareId;
                pieceEl.dataset.color = piece.color;
                pieceEl.dataset.type = piece.type;

                // Drag events on piece
                pieceEl.addEventListener('dragstart', onDragStart);
                pieceEl.addEventListener('dragend', onDragEnd);

                sq.appendChild(pieceEl);
            }

            // Square events
            sq.addEventListener('click', () => onSquareClick(squareId));
            sq.addEventListener('dragover', onDragOver);
            sq.addEventListener('dragleave', onDragLeave);
            sq.addEventListener('drop', onDrop);

            DOM.board.appendChild(sq);
        }
    }

    // Show valid moves for selected square
    if (state.selectedSquare) {
        showValidMoves(state.selectedSquare);
    }

    // Render coordinates
    renderCoords();
    updateCapturedPieces();
}

function renderCoords() {
    const isFlipped = state.playerColor === 'b';
    DOM.coordsCol.innerHTML = '';
    DOM.coordsRow.innerHTML = '';
    for (let i = 0; i < 8; i++) {
        const rank = isFlipped ? (i + 1) : (8 - i);
        const span = document.createElement('span');
        span.textContent = rank;
        DOM.coordsCol.appendChild(span);
    }
    for (let i = 0; i < 8; i++) {
        const file = isFlipped ? String.fromCharCode(104 - i) : String.fromCharCode(97 + i);
        const span = document.createElement('span');
        span.textContent = file;
        DOM.coordsRow.appendChild(span);
    }
}

function showValidMoves(fromSquare) {
    const moves = state.game.moves({ square: fromSquare, verbose: true });
    moves.forEach(move => {
        const sq = DOM.board.querySelector(`[data-square="${move.to}"]`);
        if (!sq) return;
        const targetPiece = state.game.get(move.to);
        if (targetPiece || move.flags.includes('e')) {
            sq.classList.add('valid-capture');
        } else {
            sq.classList.add('valid-move');
        }
    });
}

// ===================== CLICK-TO-MOVE =====================
function onSquareClick(square) {
    if (state.gameOver || state.aiThinking) return;
    if (state.pendingPromotion) return;

    // In multiplayer, check turn
    if (state.mode !== 'ai' && state.game.turn() !== state.playerColor) return;
    if (state.mode === 'ai' && state.game.turn() !== state.playerColor) return;

    if (!state.selectedSquare) {
        // Select a piece
        const piece = state.game.get(square);
        if (piece && piece.color === state.playerColor) {
            state.selectedSquare = square;
            sound.play('move');
            renderBoard();
        }
    } else {
        if (square === state.selectedSquare) {
            // Deselect
            state.selectedSquare = null;
            renderBoard();
            return;
        }

        // Try to move
        const validMoves = state.game.moves({ square: state.selectedSquare, verbose: true });
        const targetMove = validMoves.find(m => m.to === square);

        if (targetMove) {
            // Check for promotion
            if (targetMove.flags.includes('p')) {
                showPromotionModal(state.selectedSquare, square);
                return;
            }
            executeMove(state.selectedSquare, square, 'q');
        } else {
            // Try selecting a new piece
            const piece = state.game.get(square);
            if (piece && piece.color === state.playerColor) {
                state.selectedSquare = square;
                renderBoard();
            } else {
                state.selectedSquare = null;
                renderBoard();
            }
        }
    }
}

// ===================== DRAG & DROP =====================
let dragSourceSquare = null;

function onDragStart(e) {
    if (state.gameOver || state.aiThinking) { e.preventDefault(); return; }

    const piece = e.target;
    const square = piece.dataset.square;
    const color = piece.dataset.color;

    if (color !== state.playerColor) { e.preventDefault(); return; }
    if (state.game.turn() !== state.playerColor) { e.preventDefault(); return; }

    dragSourceSquare = square;
    state.selectedSquare = square;

    // Ghost image
    const ghost = piece.cloneNode(true);
    ghost.style.width = '60px';
    ghost.style.height = '60px';
    ghost.style.position = 'absolute';
    ghost.style.top = '-1000px';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 30, 30);
    setTimeout(() => document.body.removeChild(ghost), 0);

    e.dataTransfer.effectAllowed = 'move';
    piece.classList.add('dragging');

    // Show valid moves
    renderBoard();
}

function onDragEnd(e) {
    dragSourceSquare = null;
    $$('.piece.dragging').forEach(p => p.classList.remove('dragging'));
    $$('.square.drag-over').forEach(s => s.classList.remove('drag-over'));
}

function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const sq = e.currentTarget;
    if (!sq.classList.contains('drag-over')) {
        $$('.square.drag-over').forEach(s => s.classList.remove('drag-over'));
        sq.classList.add('drag-over');
    }
}

function onDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

function onDrop(e) {
    e.preventDefault();
    const targetSquare = e.currentTarget.dataset.square;
    $$('.square.drag-over').forEach(s => s.classList.remove('drag-over'));

    if (!dragSourceSquare || dragSourceSquare === targetSquare) return;

    const validMoves = state.game.moves({ square: dragSourceSquare, verbose: true });
    const targetMove = validMoves.find(m => m.to === targetSquare);

    if (targetMove) {
        if (targetMove.flags.includes('p')) {
            showPromotionModal(dragSourceSquare, targetSquare);
        } else {
            executeMove(dragSourceSquare, targetSquare, 'q');
        }
    } else {
        state.selectedSquare = null;
        renderBoard();
        sound.play('error');
    }

    dragSourceSquare = null;
}

// ===================== PROMOTION =====================
function showPromotionModal(from, to) {
    state.pendingPromotion = { from, to };
    const color = state.playerColor;
    DOM.promotionPieces.innerHTML = '';

    ['q', 'r', 'b', 'n'].forEach(type => {
        const div = document.createElement('div');
        div.className = 'promotion-piece';
        div.style.backgroundImage = `url(${PIECE_IMAGES[color][type]})`;
        div.addEventListener('click', () => {
            hideModals();
            executeMove(from, to, type);
            state.pendingPromotion = null;
        });
        DOM.promotionPieces.appendChild(div);
    });

    showModal('promotion-modal');
}

// ===================== EXECUTE MOVE =====================
function executeMove(from, to, promotion) {
    const move = state.game.move({ from, to, promotion });
    if (!move) {
        state.selectedSquare = null;
        renderBoard();
        return;
    }

    state.selectedSquare = null;
    state.lastMove = { from, to };
    state.moveHistory.push(move);

    // Play sound
    if (move.flags.includes('k') || move.flags.includes('q')) {
        sound.play('castle');
    } else if (move.flags.includes('c') || move.flags.includes('e')) {
        sound.play('capture');
    } else if (move.flags.includes('p')) {
        sound.play('promote');
    } else {
        sound.play('move');
    }

    renderBoard();
    renderMoveHistory();
    updateStatus();

    // Timer switch
    if (state.timeControl > 0) {
        switchTimer();
    }

    // Check game end
    if (checkGameEnd()) return;

    if (state.mode === 'ai') {
        // AI's turn
        if (state.game.turn() !== state.playerColor) {
            setTimeout(() => makeAIMove(), 200);
        }
    } else {
        // Send move to server
        state.socket.emit('makeMove', {
            roomId: state.roomId,
            move: { from, to, promotion }
        });
    }
}

// ===================== AI ENGINE (STOCKFISH) =====================
function initStockfish() {
    if (state.stockfish) {
        state.stockfish.terminate();
    }

    try {
        state.stockfish = new Worker('stockfish-worker.js');
        state.stockfish.onmessage = onStockfishMessage;
        state.stockfish.postMessage('uci');
    } catch (e) {
        console.error('Failed to init Stockfish:', e);
        // Fallback: random moves
        state.stockfish = null;
    }
}

function onStockfishMessage(e) {
    const line = typeof e.data === 'string' ? e.data : (e.data ? e.data.toString() : '');

    if (line.startsWith('bestmove')) {
        const parts = line.split(' ');
        const bestMove = parts[1];
        if (bestMove && bestMove !== '(none)') {
            applyAIMove(bestMove);
        }
        state.aiThinking = false;
    }
}

function makeAIMove() {
    if (state.gameOver) return;
    state.aiThinking = true;

    const settings = AI_SETTINGS[state.aiDifficulty];
    const fen = state.game.fen();

    if (state.stockfish) {
        state.stockfish.postMessage('ucinewgame');
        state.stockfish.postMessage(`setoption name Skill Level value ${settings.skill}`);
        state.stockfish.postMessage(`position fen ${fen}`);
        state.stockfish.postMessage(`go depth ${settings.depth} movetime ${settings.moveTime}`);
    } else {
        // Fallback: random legal move
        setTimeout(() => {
            const moves = state.game.moves({ verbose: true });
            if (moves.length > 0) {
                const randomMove = moves[Math.floor(Math.random() * moves.length)];
                applyAIMove(randomMove.from + randomMove.to + (randomMove.promotion || ''));
            }
            state.aiThinking = false;
        }, 500);
    }
}

function applyAIMove(uciMove) {
    if (state.gameOver) return;

    const from = uciMove.substring(0, 2);
    const to = uciMove.substring(2, 4);
    const promotion = uciMove.length > 4 ? uciMove[4] : undefined;

    const move = state.game.move({ from, to, promotion });
    if (!move) return;

    state.lastMove = { from, to };
    state.moveHistory.push(move);

    // Sound
    if (move.flags.includes('k') || move.flags.includes('q')) sound.play('castle');
    else if (move.flags.includes('c') || move.flags.includes('e')) sound.play('capture');
    else sound.play('move');

    if (state.game.in_check()) sound.play('check');

    renderBoard();
    renderMoveHistory();
    updateStatus();

    if (state.timeControl > 0) switchTimer();
    checkGameEnd();
}

// ===================== TIMER =====================
function startTimer() {
    if (state.timeControl <= 0) return;
    stopTimer();
    state.activeTimer = state.game.turn();
    state.lastTickTime = Date.now();

    state.timerInterval = setInterval(() => {
        const now = Date.now();
        const elapsed = now - state.lastTickTime;
        state.lastTickTime = now;

        const color = state.activeTimer;
        if (color && state.timers[color] > 0) {
            state.timers[color] = Math.max(0, state.timers[color] - elapsed);
            updateTimerDisplay();

            if (state.timers[color] <= 0) {
                // Time's up
                stopTimer();
                const loser = color === 'w' ? 'White' : 'Black';
                const winner = color === 'w' ? 'Black' : 'White';
                endGame('timeout', winner);
            }
        }
    }, 100);
}

function stopTimer() {
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }
}

function switchTimer() {
    state.activeTimer = state.game.turn();
    if (state.mode === 'ai' && state.timeControl > 0) {
        startTimer();
    }
}

function updateTimerDisplay() {
    if (state.timeControl <= 0) return;

    const playerColor = state.playerColor;
    const opponentColor = playerColor === 'w' ? 'b' : 'w';

    setTimerEl(DOM.playerTimer, state.timers[playerColor], state.activeTimer === playerColor);
    setTimerEl(DOM.opponentTimer, state.timers[opponentColor], state.activeTimer === opponentColor);
}

function setTimerEl(el, ms, isActive) {
    const totalSec = Math.ceil(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const span = el.querySelector('.timer-value');

    if (ms <= 10000 && ms > 0) {
        // Show tenths of a second
        const tenths = Math.floor((ms % 1000) / 100);
        span.textContent = `${min}:${sec.toString().padStart(2, '0')}.${tenths}`;
    } else {
        span.textContent = `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }

    el.classList.toggle('active', isActive && !state.gameOver);
    el.classList.toggle('low-time', ms > 0 && ms <= 30000 && isActive);
}

// ===================== MOVE HISTORY =====================
function renderMoveHistory() {
    const history = state.game.history();
    if (history.length === 0) {
        DOM.movesList.innerHTML = '<div class="moves-placeholder">Game moves will appear here...</div>';
        return;
    }

    DOM.movesList.innerHTML = '';
    for (let i = 0; i < history.length; i += 2) {
        const moveNum = Math.floor(i / 2) + 1;
        const row = document.createElement('div');
        row.className = 'move-row';

        const numEl = document.createElement('span');
        numEl.className = 'move-number';
        numEl.textContent = `${moveNum}.`;

        const whiteEl = document.createElement('span');
        whiteEl.className = 'move-cell';
        whiteEl.textContent = history[i];
        if (i === history.length - 1) whiteEl.classList.add('current');

        row.appendChild(numEl);
        row.appendChild(whiteEl);

        if (history[i + 1]) {
            const blackEl = document.createElement('span');
            blackEl.className = 'move-cell';
            blackEl.textContent = history[i + 1];
            if (i + 1 === history.length - 1) blackEl.classList.add('current');
            row.appendChild(blackEl);
        }

        DOM.movesList.appendChild(row);
    }

    DOM.movesList.scrollTop = DOM.movesList.scrollHeight;
}

// ===================== CAPTURED PIECES =====================
function updateCapturedPieces() {
    const history = state.game.history({ verbose: true });
    const captured = { w: [], b: [] };

    history.forEach(move => {
        if (move.captured) {
            // The capturing piece's color determines which side captured
            const capturerColor = move.color;
            captured[capturerColor].push(move.captured);
        }
    });

    const pieceOrder = { q: 0, r: 1, b: 2, n: 3, p: 4 };
    const sortPieces = (arr) => arr.sort((a, b) => pieceOrder[a] - pieceOrder[b]);

    const playerColor = state.playerColor;
    const opponentColor = playerColor === 'w' ? 'b' : 'w';

    // Player captured = pieces the player has taken (opponent's pieces)
    DOM.playerCaptured.innerHTML = sortPieces(captured[playerColor])
        .map(p => `<span>${PIECE_UNICODE[p]}</span>`).join('');

    DOM.opponentCaptured.innerHTML = sortPieces(captured[opponentColor])
        .map(p => `<span>${PIECE_UNICODE[p]}</span>`).join('');
}

// ===================== GAME STATUS =====================
function updateStatus() {
    const turn = state.game.turn();
    const turnName = turn === 'w' ? 'White' : 'Black';

    if (state.game.in_checkmate()) {
        DOM.status.textContent = `Checkmate! ${turn === 'w' ? 'Black' : 'White'} wins.`;
    } else if (state.game.in_stalemate()) {
        DOM.status.textContent = 'Stalemate — Draw!';
    } else if (state.game.in_draw()) {
        DOM.status.textContent = 'Draw!';
    } else if (state.game.in_check()) {
        DOM.status.textContent = `${turnName} is in check!`;
    } else {
        DOM.status.textContent = `${turnName} to move`;
    }
}

function checkGameEnd() {
    if (state.game.game_over()) {
        if (state.game.in_checkmate()) {
            const winner = state.game.turn() === 'w' ? 'Black' : 'White';
            endGame('checkmate', winner);
        } else if (state.game.in_stalemate()) {
            endGame('stalemate');
        } else {
            endGame('draw');
        }
        return true;
    }
    return false;
}

function endGame(reason, winner) {
    state.gameOver = true;
    stopTimer();
    sound.play('gameEnd');

    let title = 'Game Over';
    let message = '';
    let icon = '♚';

    switch (reason) {
        case 'checkmate':
            title = 'Checkmate!';
            message = `${winner} wins the game.`;
            icon = winner === 'White' ? '♔' : '♚';
            break;
        case 'stalemate':
            title = 'Stalemate';
            message = 'The game is drawn by stalemate.';
            icon = '🤝';
            break;
        case 'draw':
            title = 'Draw';
            message = 'The game ended in a draw.';
            icon = '🤝';
            break;
        case 'timeout':
            title = 'Time\'s Up!';
            message = `${winner} wins on time.`;
            icon = '⏰';
            break;
        case 'resign':
            title = 'Resignation';
            message = `${winner} wins by resignation.`;
            icon = '🏳️';
            break;
        case 'disconnect':
            title = 'Opponent Left';
            message = `${winner} wins by disconnection.`;
            icon = '⚡';
            break;
    }

    DOM.gameoverTitle.textContent = title;
    DOM.gameoverMessage.textContent = message;
    DOM.gameoverIcon.textContent = icon;

    updateStatus();
    $('#resign-btn').style.display = 'none';
    $('#draw-btn').style.display = 'none';
    $('#new-game-btn').style.display = '';

    setTimeout(() => showModal('gameover-modal'), 600);
}

// ===================== SOCKET.IO — MULTIPLAYER =====================
function connectSocket() {
    if (state.socket && state.isConnected) return;

    state.socket = io({
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 10
    });

    const socket = state.socket;

    socket.on('connect', () => {
        state.isConnected = true;
        console.log('Connected to server');
        // Attempt reconnection to game
        if (state.roomId) {
            socket.emit('reconnect', {
                roomId: state.roomId,
                sessionId: state.sessionId
            });
        }
    });

    socket.on('disconnect', () => {
        state.isConnected = false;
        console.log('Disconnected from server');
    });

    // ---- Matchmaking Events ----
    socket.on('matchFound', (data) => {
        state.roomId = data.roomId;
        state.playerColor = data.color;
        state.timeControl = data.timeControl;
        state.timers = { w: data.timeControl, b: data.timeControl };
        hideModals();
        startGame();
    });

    socket.on('matchError', (msg) => {
        hideModals();
        alert(msg);
    });

    // ---- Room Events ----
    socket.on('roomCreated', (data) => {
        state.roomId = data.roomId;
        state.roomCode = data.roomCode;
        state.playerColor = 'w';
        DOM.roomCodeBig.textContent = data.roomCode;
    });

    socket.on('roomJoined', (data) => {
        state.roomId = data.roomId;
        state.roomCode = data.roomCode || state.roomCode;
        state.playerColor = data.color;
        state.timeControl = data.timeControl;
        state.timers = { w: data.timeControl, b: data.timeControl };
        hideModals();
        startGame();
    });

    socket.on('opponentJoined', (data) => {
        state.timeControl = data.timeControl;
        state.timers = { w: data.timeControl, b: data.timeControl };
        hideModals();
        startGame();
    });

    socket.on('roomError', (msg) => {
        hideModals();
        alert(msg);
    });

    // ---- Game Events ----
    socket.on('gameState', (data) => {
        state.game.load(data.fen);
        if (data.timers) {
            state.timers = data.timers;
        }
        if (data.lastMove) {
            state.lastMove = data.lastMove;
        }
        state.moveHistory = data.history || [];
        renderBoard();
        renderMoveHistory();
        updateTimerDisplay();
        updateStatus();
    });

    socket.on('moveMade', (data) => {
        state.game.load(data.fen);
        state.lastMove = { from: data.move.from, to: data.move.to };
        state.selectedSquare = null;

        // Sound
        const move = data.move;
        if (move.flags && (move.flags.includes('k') || move.flags.includes('q'))) sound.play('castle');
        else if (move.flags && (move.flags.includes('c') || move.flags.includes('e'))) sound.play('capture');
        else sound.play('move');

        if (state.game.in_check()) sound.play('check');

        // Update timers from server
        if (data.timers) {
            state.timers = data.timers;
        }

        renderBoard();
        renderMoveHistory();
        updateTimerDisplay();
        updateStatus();

        if (state.game.game_over()) {
            checkGameEnd();
        }
    });

    socket.on('timerUpdate', (data) => {
        state.timers = data.timers;
        state.activeTimer = data.activeColor;
        updateTimerDisplay();
    });

    socket.on('timeOut', (data) => {
        endGame('timeout', data.winner);
    });

    socket.on('gameOver', (data) => {
        endGame(data.reason, data.winner);
    });

    // ---- Disconnection Events ----
    socket.on('opponentDisconnected', () => {
        let seconds = 30;
        DOM.countdownText.textContent = seconds;
        DOM.countdownProgress.style.strokeDashoffset = 0;
        showModal('disconnect-modal');

        state.disconnectCountdown = setInterval(() => {
            seconds--;
            DOM.countdownText.textContent = seconds;
            DOM.countdownProgress.style.strokeDashoffset = 283 * (1 - seconds / 30);

            if (seconds <= 0) {
                clearInterval(state.disconnectCountdown);
                state.disconnectCountdown = null;
                hideModals();
            }
        }, 1000);
    });

    socket.on('opponentReconnected', () => {
        if (state.disconnectCountdown) {
            clearInterval(state.disconnectCountdown);
            state.disconnectCountdown = null;
        }
        hideModals();
        addChatMessage('System', 'Opponent reconnected.', 'system');
    });

    // ---- Draw Events ----
    socket.on('drawOffered', () => {
        showModal('draw-offer-modal');
    });

    socket.on('drawDeclined', () => {
        addChatMessage('System', 'Draw offer declined.', 'system');
        $('#draw-btn').textContent = '🤝 Draw';
        $('#draw-btn').disabled = false;
    });

    socket.on('drawAccepted', () => {
        endGame('draw');
    });

    // ---- Chat Events ----
    socket.on('chatMessage', (data) => {
        addChatMessage(data.sender, data.text, data.type || 'normal');
    });

    // ---- Reconnection Events ----
    socket.on('reconnected', (data) => {
        state.roomId = data.roomId;
        state.playerColor = data.color;
        state.game.load(data.fen);
        if (data.timers) state.timers = data.timers;
        if (data.lastMove) state.lastMove = data.lastMove;
        state.gameOver = false;
        hideModals();
        showScreen('game-screen');
        renderBoard();
        renderMoveHistory();
        updateTimerDisplay();
        updateStatus();
    });
}

// ===================== CHAT =====================
function initChat() {
    DOM.chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const msg = DOM.chatInput.value.trim();
        if (!msg || !state.socket || state.mode === 'ai') return;
        state.socket.emit('sendChat', { roomId: state.roomId, message: msg });
        DOM.chatInput.value = '';
    });
}

function addChatMessage(sender, text, type) {
    const el = document.createElement('div');
    el.className = `chat-msg ${type === 'system' ? 'system' : ''}`;

    if (type === 'system') {
        el.textContent = text;
    } else {
        el.innerHTML = `<span class="sender" style="color: ${sender === 'White' ? '#E8D3B9' : '#8B5A42'}">${sender}:</span> ${escapeHtml(text)}`;
    }

    DOM.chatMessages.appendChild(el);
    DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

// ===================== UTILITIES =====================
function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===================== INITIALIZATION =====================
document.addEventListener('DOMContentLoaded', () => {
    initLobbyEvents();
    initChat();
    showScreen('lobby-screen');

    // Preload piece images
    Object.values(PIECE_IMAGES).forEach(colorPieces => {
        Object.values(colorPieces).forEach(url => {
            const img = new Image();
            img.src = url;
        });
    });
});
