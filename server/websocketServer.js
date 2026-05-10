const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: './data/logs/server.log' })
  ],
});

const SERVER_PORT = process.env.SERVER_PORT || 3000;

const WORLD_W = 1128;
const WORLD_H = 552;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const PLAYER_W = 30;
const PLAYER_H = 32;
const SPEED = 185;
const JUMP_SPEED = 405;
const GRAVITY = 960;
const MAX_FALL = 620;
const MAX_HP = 3;
const ATTACK_DAMAGE = 1;
const ATTACK_COOLDOWN_MS = 520;
const ATTACK_ACTIVE_MS = 180;
const HIT_INVULN_MS = 650;
const RESPAWN_MS = 1800;
const HEART_HEAL = 1;
const MIN_PLAYERS_TO_START = 2;
const LOBBY_COUNTDOWN_SECONDS = 15;

const colors = ['yellow', 'white', 'orange', 'grey', 'green'];
const spawnPoints = [
  { x: 151, y: 349 },
  { x: 111, y: 157 },
  { x: 923, y: 157 },
  { x: 950, y: 349 },
  { x: 558, y: 132 },
];

const initialSwords = [
  { id: 'sword_0', x: 440, y: 211, w: 50, h: 71, active: true },
  { id: 'sword_1', x: 696, y: 211, w: 50, h: 71, active: true },
  { id: 'sword_2', x: 848, y: 259, w: 50, h: 71, active: true },
  { id: 'sword_3', x: 568, y: 357, w: 50, h: 71, active: true },
  { id: 'sword_4', x: 285, y: 259, w: 50, h: 71, active: true },
];

const initialHearts = [
  { id: 'heart_0', x: 564, y: 232, w: 20, h: 21, active: true },
  { id: 'heart_1', x: 563, y: 449, w: 20, h: 21, active: true },
  { id: 'heart_2', x: 852, y: 418, w: 20, h: 21, active: true },
  { id: 'heart_3', x: 276, y: 418, w: 20, h: 21, active: true },
];

// Zonas exportadas desde vuestro level_000_zones.json. Las uso como plataformas/colisiones.
const platforms = [
  { x: 69, y: 74, w: 27, h: 397 }, { x: 1032, y: 80, w: 27, h: 397 },
  { x: 77, y: 74, w: 976, h: 21 }, { x: 73, y: 455, w: 141, h: 25 },
  { x: 336, y: 456, w: 453, h: 22 }, { x: 912, y: 457, w: 121, h: 19 },
  { x: 408, y: 240, w: 312, h: 22 }, { x: 480, y: 144, w: 168, h: 22 },
  { x: 480, y: 384, w: 168, h: 22 }, { x: 96, y: 432, w: 119, h: 25 },
  { x: 913, y: 432, w: 119, h: 25 }, { x: 90, y: 168, w: 126, h: 22 },
  { x: 213, y: 288, w: 126, h: 22 }, { x: 337, y: 432, w: 47, h: 23 },
  { x: 743, y: 432, w: 49, h: 24 }, { x: 912, y: 168, w: 126, h: 22 },
  { x: 791, y: 288, w: 120, h: 22 }, { x: 72, y: 360, w: 120, h: 22 },
  { x: 936, y: 360, w: 120, h: 22 },
];

const players = new Map(); // ws -> player
const swords = new Map(initialSwords.map(s => [s.id, { ...s }]));
const hearts = new Map(initialHearts.map(h => [h.id, { ...h }]));
let nextColorIndex = 0;
let lobbyPhase = 'waiting'; // waiting | countdown | playing
let lobbyCountdownStartedAt = null;

function sendTo(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of players.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastExcept(excludedWs, payload) {
  const data = JSON.stringify(payload);
  for (const ws of players.keys()) {
    if (ws !== excludedWs && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function playerRect(p, x = p.x, y = p.y) {
  return { x: x - PLAYER_W / 2, y: y - PLAYER_H, w: PLAYER_W, h: PLAYER_H };
}

function itemRect(item) {
  return { x: item.x - item.w / 2, y: item.y - item.h / 2, w: item.w, h: item.h };
}

function sanitizeName(name) {
  return String(name).trim().slice(0, 18) || 'Duck';
}

function createPlayer(ws, name) {
  const taken = new Set([...players.values()].map(p => p.color));
  let color = colors[nextColorIndex % colors.length];
  for (const c of colors) {
    if (!taken.has(c)) { color = c; break; }
  }
  nextColorIndex++;
  const spawn = spawnPoints[colors.indexOf(color)] || spawnPoints[0];
  const id = `${name}_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
  return {
    id,
    name,
    color,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    facing: 'right',
    hp: MAX_HP,
    maxHp: MAX_HP,
    hasSword: false,
    alive: true,
    onGround: false,
    score: 0,
    input: { left: false, right: false, jump: false, attack: false },
    lastAttackAt: 0,
    attackUntil: 0,
    invulnerableUntil: 0,
    respawnAt: 0,
    ws,
  };
}


function updateLobby(now = Date.now()) {
  if (lobbyPhase === 'playing') return;

  if (players.size < MIN_PLAYERS_TO_START) {
    lobbyPhase = 'waiting';
    lobbyCountdownStartedAt = null;
    return;
  }

  if (lobbyCountdownStartedAt == null) {
    lobbyPhase = 'countdown';
    lobbyCountdownStartedAt = now;
    return;
  }

  const elapsed = now - lobbyCountdownStartedAt;
  if (elapsed >= LOBBY_COUNTDOWN_SECONDS * 1000) {
    lobbyPhase = 'playing';
  } else {
    lobbyPhase = 'countdown';
  }
}

function serializeLobby(now = Date.now()) {
  updateLobby(now);
  const startsAt = lobbyCountdownStartedAt == null
    ? null
    : lobbyCountdownStartedAt + LOBBY_COUNTDOWN_SECONDS * 1000;
  const countdown = startsAt == null
    ? null
    : Math.max(0, Math.ceil((startsAt - now) / 1000));

  return {
    phase: lobbyPhase,
    minPlayers: MIN_PLAYERS_TO_START,
    countdown,
    countdownStartedAt: lobbyCountdownStartedAt,
    startsAt,
  };
}

function serializeState() {
  const now = Date.now();
  return {
    type: 'STATE',
    serverTime: now,
    lobby: serializeLobby(now),
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, x: p.x, y: p.y,
      vx: p.vx, vy: p.vy, facing: p.facing, hp: p.hp, maxHp: p.maxHp,
      hasSword: p.hasSword, alive: p.alive, score: p.score,
      attacking: now < p.attackUntil,
      invulnerable: now < p.invulnerableUntil,
    })),
    swords: [...swords.values()].map(s => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, active: s.active })),
    hearts: [...hearts.values()].map(h => ({ id: h.id, x: h.x, y: h.y, w: h.w, h: h.h, active: h.active })),
  };
}

function applyHorizontal(p) {
  const input = p.input;
  p.vx = 0;
  if (input.left && !input.right) { p.vx = -SPEED; p.facing = 'left'; }
  if (input.right && !input.left) { p.vx = SPEED; p.facing = 'right'; }
  const nextX = Math.max(PLAYER_W / 2, Math.min(WORLD_W - PLAYER_W / 2, p.x + p.vx * DT));
  const r = playerRect(p, nextX, p.y);
  if (!platforms.some(z => rectsOverlap(r, z))) p.x = nextX;
}

function applyVertical(p) {
  if (p.input.jump && p.onGround) {
    p.vy = -JUMP_SPEED;
    p.onGround = false;
  }
  p.vy = Math.min(MAX_FALL, p.vy + GRAVITY * DT);
  let nextY = Math.max(PLAYER_H, Math.min(WORLD_H, p.y + p.vy * DT));
  let r = playerRect(p, p.x, nextY);
  p.onGround = false;
  for (const z of platforms) {
    if (!rectsOverlap(r, z)) continue;
    const oldBottom = p.y;
    const oldTop = p.y - PLAYER_H;
    if (p.vy >= 0 && oldBottom <= z.y + 6) {
      nextY = z.y;
      p.vy = 0;
      p.onGround = true;
    } else if (p.vy < 0 && oldTop >= z.y + z.h - 6) {
      nextY = z.y + z.h + PLAYER_H;
      p.vy = 0;
    }
    r = playerRect(p, p.x, nextY);
  }
  p.y = nextY;
  if (p.y >= WORLD_H - 2) p.onGround = true;
}

function tryPickupItems(p) {
  const pr = playerRect(p);
  if (!p.hasSword) {
    for (const s of swords.values()) {
      if (s.active && rectsOverlap(pr, itemRect(s))) {
        s.active = false;
        p.hasSword = true;
        break;
      }
    }
  }
  if (p.hp < p.maxHp) {
    for (const h of hearts.values()) {
      if (h.active && rectsOverlap(pr, itemRect(h))) {
        h.active = false;
        p.hp = Math.min(p.maxHp, p.hp + HEART_HEAL);
        setTimeout(() => { h.active = true; }, 10000);
        break;
      }
    }
  }
}

function tryAttack(attacker, now) {
  if (!attacker.input.attack || !attacker.hasSword || !attacker.alive) return;
  if (now - attacker.lastAttackAt < ATTACK_COOLDOWN_MS) return;
  attacker.lastAttackAt = now;
  attacker.attackUntil = now + ATTACK_ACTIVE_MS;

  const range = 42;
  const arc = {
    x: attacker.facing === 'right' ? attacker.x : attacker.x - range,
    y: attacker.y - PLAYER_H + 5,
    w: range,
    h: PLAYER_H - 6,
  };

  for (const target of players.values()) {
    if (target.id === attacker.id || !target.alive) continue;
    if (now < target.invulnerableUntil) continue;
    if (!rectsOverlap(arc, playerRect(target))) continue;
    target.hp -= ATTACK_DAMAGE;
    target.invulnerableUntil = now + HIT_INVULN_MS;
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.hasSword = false;
      target.respawnAt = now + RESPAWN_MS;
      attacker.score += 1;
    }
  }
}

function respawnIfNeeded(p, now) {
  if (p.alive || now < p.respawnAt) return;
  const spawn = spawnPoints[colors.indexOf(p.color)] || spawnPoints[0];
  p.x = spawn.x; p.y = spawn.y; p.vx = 0; p.vy = 0;
  p.hp = MAX_HP; p.alive = true; p.invulnerableUntil = now + 1200;
}

function tick() {
  const now = Date.now();
  for (const p of players.values()) {
    respawnIfNeeded(p, now);
    if (!p.alive) continue;
    applyHorizontal(p);
    applyVertical(p);
    tryPickupItems(p);
  }
  for (const p of players.values()) tryAttack(p, now);
  broadcast(serializeState());
}

setInterval(tick, 1000 / TICK_RATE);

async function iniciarServidor() {
  const wss = new WebSocket.Server({ port: SERVER_PORT });
  logger.info(`Servidor arrancado en puerto ${SERVER_PORT}`);

  wss.on('connection', (ws) => {
    logger.info('Nuevo cliente conectado');

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch {
        sendTo(ws, { type: 'ERROR', message: 'Invalid JSON' });
        return;
      }

      switch (msg.type) {
        case 'JOIN': {
          if (players.has(ws)) {
            const current = players.get(ws);
            sendTo(ws, { type: 'JOINED', id: current.id, name: current.name, color: current.color });
            sendTo(ws, serializeState());
            return;
          }

          if (players.size >= colors.length) {
            sendTo(ws, { type: 'ERROR', message: 'Game is full' });
            return;
          }

          const name = sanitizeName(msg.name);
          const p = createPlayer(ws, name);
          players.set(ws, p);

          // Igual que en el servidor original: JOINED solo al que entra.
          sendTo(ws, { type: 'JOINED', id: p.id, name: p.name, color: p.color });

          // Igual que en el servidor original: PLAYER_JOINED solo al resto, nunca al propio jugador.
          broadcastExcept(ws, { type: 'PLAYER_JOINED', id: p.id, name: p.name, color: p.color });

          // Compatibilidad con el lobby antiguo: al nuevo le mandamos los jugadores que ya estaban.
          const currentPlayers = [...players.entries()]
            .filter(([otherWs]) => otherWs !== ws)
            .map(([, other]) => ({ id: other.id, name: other.name, color: other.color }));
          sendTo(ws, { type: 'PLAYER_LIST', players: currentPlayers });

          // Fuente de verdad para el lobby nuevo y el juego: foto completa sincronizada.
          broadcast(serializeState());
          logger.info(`JOIN: ${p.name} (${p.id})`);
          break;
        }
        case 'INPUT': {
          const p = players.get(ws);
          if (!p) { sendTo(ws, { type: 'ERROR', message: 'Not joined' }); return; }
          p.input = {
            left: Boolean(msg.left),
            right: Boolean(msg.right),
            jump: Boolean(msg.jump),
            attack: Boolean(msg.attack),
          };
          break;
        }
        // Compatibilidad con vuestro MOVE antiguo.
        case 'MOVE': {
          const p = players.get(ws);
          if (!p) { sendTo(ws, { type: 'ERROR', message: 'Not joined' }); return; }
          p.input.left = msg.direction === 'LEFT';
          p.input.right = msg.direction === 'RIGHT';
          p.input.jump = msg.direction === 'UP';
          break;
        }
        default:
          sendTo(ws, { type: 'ERROR', message: `Unknown type: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      const p = players.get(ws);
      if (p) {
        players.delete(ws);
        broadcast({ type: 'PLAYER_LEFT', id: p.id, name: p.name });
        broadcast(serializeState());
        logger.info(`LEFT: ${p.name} (${p.id})`);
      }
    });

    ws.on('error', (err) => logger.error(`WS error: ${err}`));
  });
}

iniciarServidor();
