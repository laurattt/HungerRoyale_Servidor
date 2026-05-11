const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(
            ({ timestamp, level, message }) =>
                `${timestamp} ${level}: ${message}`
        )
    ),
    transports: [
        new winston.transports.Console(),
    ],
});

const SERVER_PORT = process.env.SERVER_PORT || 3000;

const TICK_RATE = 1000 / 30;

const PLAYER_SPEED = 4;
const JUMP_FORCE = -11;
const GRAVITY = 0.6;

const MAX_HEALTH = 3;

const HEART_RESPAWN_MS = 10000;

const MATCH_START_COUNTDOWN = 5;
const ROUND_RESET_DELAY = 5000;

const DUCK_COLORS = [
    'yellow',
    'white',
    'orange',
    'grey',
    'green',
];

const SPAWN_POINTS = [
    { x: 151, y: 349 },
    { x: 111, y: 157 },
    { x: 923, y: 157 },
    { x: 950, y: 349 },
    { x: 558, y: 132 },
];

const swordsInitial = [
    { id: 's1', x: 440, y: 211, available: true },
    { id: 's2', x: 696, y: 211, available: true },
    { id: 's3', x: 848, y: 259, available: true },
    { id: 's4', x: 568, y: 357, available: true },
    { id: 's5', x: 285, y: 259, available: true },
];

const heartsInitial = [
    { id: 'h1', x: 564, y: 232, available: true, respawnAt: null },
    { id: 'h2', x: 563, y: 449, available: true, respawnAt: null },
    { id: 'h3', x: 852, y: 418, available: true, respawnAt: null },
    { id: 'h4', x: 276, y: 418, available: true, respawnAt: null },
];

let swords = JSON.parse(JSON.stringify(swordsInitial));
let hearts = JSON.parse(JSON.stringify(heartsInitial));

const players = new Map();

let lobbyCountdown = null;
let gameStarted = false;
let roundEnded = false;

function broadcast(payload) {
    const data = JSON.stringify(payload);

    for (const ws of players.keys()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    }
}

function sendTo(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function resetRound() {
    swords = JSON.parse(JSON.stringify(swordsInitial));
    hearts = JSON.parse(JSON.stringify(heartsInitial));

    let i = 0;

    for (const player of players.values()) {
        const spawn = SPAWN_POINTS[i % SPAWN_POINTS.length];

        player.x = spawn.x;
        player.y = spawn.y;

        player.vx = 0;
        player.vy = 0;

        player.health = MAX_HEALTH;
        player.alive = true;

        player.hasSword = false;

        i++;
    }

    gameStarted = false;
    roundEnded = false;

    startLobbyCountdown();
}

function startLobbyCountdown() {
    if (lobbyCountdown !== null) return;

    if (players.size < 2) return;

    lobbyCountdown = MATCH_START_COUNTDOWN;

    const interval = setInterval(() => {
        if (players.size < 2) {
            clearInterval(interval);
            lobbyCountdown = null;
            return;
        }

        lobbyCountdown--;

        if (lobbyCountdown <= 0) {
            clearInterval(interval);
            lobbyCountdown = null;
            gameStarted = true;
        }
    }, 1000);
}

function getAvailableDuckColor() {
    const used = new Set(
        [...players.values()].map((p) => p.duckColor)
    );

    return DUCK_COLORS.find((c) => !used.has(c));
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function handleCombat(player) {
    if (!player.attack) return;
    if (!player.hasSword) return;
    if (!player.alive) return;

    for (const enemy of players.values()) {
        if (enemy.id === player.id) continue;
        if (!enemy.alive) continue;

        const d = distance(player, enemy);

        if (d < 50) {
            enemy.health--;

            if (enemy.health <= 0) {
                enemy.alive = false;
                enemy.hasSword = false;
            }
        }
    }

    const alivePlayers = [...players.values()].filter(
        (p) => p.alive
    );

    if (
        alivePlayers.length === 1 &&
        gameStarted &&
        !roundEnded
    ) {
        roundEnded = true;

        broadcast({
            type: 'ROUND_FINISHED',
            winner: alivePlayers[0].name,
        });

        setTimeout(() => {
            resetRound();
        }, ROUND_RESET_DELAY);
    }
}

function handleSwordPickup(player) {
    if (player.hasSword) return;

    for (const sword of swords) {
        if (!sword.available) continue;

        const d = distance(player, sword);

        if (d < 40) {
            sword.available = false;
            player.hasSword = true;
        }
    }
}

function handleHeartPickup(player) {
    for (const heart of hearts) {
        if (!heart.available) continue;

        const d = distance(player, heart);

        if (d < 40 && player.health < MAX_HEALTH) {
            player.health++;

            heart.available = false;
            heart.respawnAt = Date.now() + HEART_RESPAWN_MS;
        }
    }
}

function updateHeartRespawns() {
    const now = Date.now();

    for (const heart of hearts) {
        if (
            !heart.available &&
            heart.respawnAt &&
            now >= heart.respawnAt
        ) {
            heart.available = true;
            heart.respawnAt = null;
        }
    }
}

function updatePlayer(player) {
    if (!player.alive) return;

    player.vx = 0;

    if (player.input.left) {
        player.vx = -PLAYER_SPEED;
        player.direction = 'left';
        player.moving = true;
    } else if (player.input.right) {
        player.vx = PLAYER_SPEED;
        player.direction = 'right';
        player.moving = true;
    } else {
        player.moving = false;
    }

    player.vy += GRAVITY;

    player.x += player.vx;
    player.y += player.vy;

    if (player.y > 455) {
        player.y = 455;
        player.vy = 0;
        player.onGround = true;
    }

    if (player.input.jump && player.onGround) {
        player.vy = JUMP_FORCE;
        player.onGround = false;
    }

    handleSwordPickup(player);
    handleHeartPickup(player);
    handleCombat(player);
}

function buildState() {
    return {
        type: 'STATE',

        lobby: {
            countdown: lobbyCountdown,
            started: gameStarted,
        },

        players: [...players.values()].map((p) => ({
            id: p.id,
            name: p.name,

            x: p.x,
            y: p.y,

            direction: p.direction,
            moving: p.moving,

            duckColor: p.duckColor,

            health: p.health,

            alive: p.alive,

            hasSword: p.hasSword,
        })),

        swords,

        hearts,
    };
}

function gameLoop() {
    updateHeartRespawns();

    if (gameStarted) {
        for (const player of players.values()) {
            updatePlayer(player);
        }
    }

    broadcast(buildState());
}

const wss = new WebSocket.Server({
    port: SERVER_PORT,
});

logger.info(`Servidor iniciado en puerto ${SERVER_PORT}`);

wss.on('connection', (ws) => {
    logger.info('Cliente conectado');

    ws.on('message', (raw) => {
        let msg;

        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        switch (msg.type) {
            case 'JOIN': {
                const duckColor = getAvailableDuckColor();

                if (!duckColor) {
                    sendTo(ws, {
                        type: 'ERROR',
                        message: 'Lobby lleno',
                    });

                    return;
                }

                const index =
                    DUCK_COLORS.indexOf(duckColor);

                const spawn =
                    SPAWN_POINTS[index];

                const player = {
                    id: `${msg.name}_${Date.now()}`,

                    name: msg.name,

                    duckColor,

                    x: spawn.x,
                    y: spawn.y,

                    vx: 0,
                    vy: 0,

                    direction: 'right',
                    moving: false,

                    health: MAX_HEALTH,

                    alive: true,

                    hasSword: false,

                    onGround: false,

                    attack: false,

                    input: {
                        left: false,
                        right: false,
                        jump: false,
                    },
                };

                players.set(ws, player);

                sendTo(ws, {
                    type: 'JOINED',
                    id: player.id,
                    duckColor,
                });

                startLobbyCountdown();

                break;
            }

            case 'INPUT': {
                const player = players.get(ws);

                if (!player) return;

                player.input.left =
                    !!msg.left;

                player.input.right =
                    !!msg.right;

                player.input.jump =
                    !!msg.jump;

                player.attack =
                    !!msg.attack;

                break;
            }

            case 'LEAVE': {
                players.delete(ws);

                if (players.size < 2) {
                    lobbyCountdown = null;
                    gameStarted = false;
                }

                break;
            }
        }
    });

    ws.on('close', () => {
        players.delete(ws);

        if (players.size < 2) {
            lobbyCountdown = null;
            gameStarted = false;
        }
    });
});

setInterval(gameLoop, TICK_RATE);