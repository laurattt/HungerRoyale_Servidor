const http = require('http');
const WebSocket = require('ws');
const winston = require('winston');
const { handleWeb } = require('./endpointWeb');
require('dotenv').config();

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console(), new winston.transports.File({ filename: './data/logs/server.log' })],
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
const HEART_HEAL = 1;
const MIN_PLAYERS_TO_START = 2;
const LOBBY_COUNTDOWN_MS = 10000;
const GAME_OVER_HOLD_MS = 5000;

const colors = ['yellow', 'white', 'orange', 'grey', 'green'];
const spawnPoints = [
  { x: 151, y: 349 }, { x: 111, y: 157 }, { x: 923, y: 157 }, { x: 950, y: 349 }, { x: 558, y: 132 },
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
  { x: 72, y: 455, w: 960, h: 25 },
];

const players = new Map();
let swords = new Map();
let hearts = new Map();
let nextColorIndex = 0;
let phase = 'waiting'; // waiting | countdown | playing | ended
let countdownEndsAt = null;
let gameOverEndsAt = null;
let winner = null;
let lastGameOverBroadcastAt = 0;

function cloneItems(items) { return new Map(items.map(i => [i.id, { ...i }])); }
function resetItems() { swords = cloneItems(initialSwords); hearts = cloneItems(initialHearts); }
resetItems();

function sendTo(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of players.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function broadcastExcept(exceptWs, payload) {
  const data = JSON.stringify(payload);
  for (const ws of players.keys()) if (ws !== exceptWs && ws.readyState === WebSocket.OPEN) ws.send(data);
}

function rectsOverlap(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
function playerRect(p, x = p.x, y = p.y) { return { x: x - PLAYER_W / 2, y: y - PLAYER_H, w: PLAYER_W, h: PLAYER_H }; }
function itemRect(item) { return { x: item.x - item.w / 2, y: item.y - item.h / 2, w: item.w, h: item.h }; }
function sanitizeName(name) { return String(name || '').trim().slice(0, 18) || 'Duck'; }

function availableColor() {
  const taken = new Set([...players.values()].map(p => p.color));
  for (const c of colors) if (!taken.has(c)) return c;
  return null;
}

function resetPlayerForLobby(p, resetScore = true) {
  const spawn = spawnPoints[colors.indexOf(p.color)] || spawnPoints[0];
  p.x = spawn.x; p.y = spawn.y; p.vx = 0; p.vy = 0; p.facing = 'right';
  p.hp = MAX_HP; p.maxHp = MAX_HP; p.hasSword = false; p.alive = true; p.eliminated = false; p.inGame = false;
  p.onGround = false; p.input = { left: false, right: false, jump: false, attack: false };
  p.lastAttackAt = 0; p.attackUntil = 0; p.invulnerableUntil = 0;
  if (resetScore) p.score = 0;
}

function createPlayer(ws, name) {
  const color = availableColor();
  if (!color) return null;
  nextColorIndex++;
  const id = `${name}_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
  const p = { id, name, color, ws };
  resetPlayerForLobby(p, false);
  p.score = 0;
  return p;
}

function connectedCount() { return players.size; }
function playingParticipants() { return [...players.values()].filter(p => p.inGame); }
function aliveParticipants() { return playingParticipants().filter(p => p.alive && !p.eliminated); }

function maybeStartCountdown(now) {
  if (phase !== 'waiting') return;
  if (connectedCount() >= MIN_PLAYERS_TO_START) {
    phase = 'countdown';
    countdownEndsAt = now + LOBBY_COUNTDOWN_MS;
    winner = null;
    logger.info('LOBBY: countdown started');
  }
}

function maybeCancelCountdown() {
  if (phase === 'countdown' && connectedCount() < MIN_PLAYERS_TO_START) {
    phase = 'waiting';
    countdownEndsAt = null;
    logger.info('LOBBY: countdown cancelled');
  }
}

function startGame(now) {
  phase = 'playing';
  countdownEndsAt = null;
  gameOverEndsAt = null;
  winner = null;
  resetItems();
  for (const p of players.values()) {
    resetPlayerForLobby(p, true);
    p.inGame = true;
    p.invulnerableUntil = now + 1000;
  }
  logger.info('GAME: started');
}

function finishGame(winnerPlayer, now) {
  if (phase !== 'playing') return;
  phase = 'ended';
  gameOverEndsAt = now + GAME_OVER_HOLD_MS;
  winner = winnerPlayer ? { id: winnerPlayer.id, name: winnerPlayer.name, color: winnerPlayer.color } : null;
  lastGameOverBroadcastAt = 0;
  logger.info(`GAME: ended. Winner: ${winner ? winner.name : 'none'}`);
}

function resetToLobby(now) {
  phase = 'waiting';
  countdownEndsAt = null;
  gameOverEndsAt = null;
  winner = null;
  resetItems();
  for (const p of players.values()) resetPlayerForLobby(p, true);
  maybeStartCountdown(now);
  logger.info('GAME: reset to lobby');
}

function checkGameOver(now) {
  if (phase !== 'playing') return;
  const participants = playingParticipants();
  if (participants.length < MIN_PLAYERS_TO_START) return finishGame(aliveParticipants()[0] || null, now);
  const alive = aliveParticipants();
  if (alive.length <= 1) finishGame(alive[0] || null, now);
}

function serializeState() {
  const now = Date.now();
  return {
    type: 'STATE',
    serverTime: now,
    lobby: {
      phase,
      minPlayers: MIN_PLAYERS_TO_START,
      playerCount: connectedCount(),
      countdown: phase === 'countdown' && countdownEndsAt ? Math.max(0, Math.ceil((countdownEndsAt - now) / 1000)) : null,
      winner,
      resetIn: phase === 'ended' && gameOverEndsAt ? Math.max(0, Math.ceil((gameOverEndsAt - now) / 1000)) : null,
    },
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      facing: p.facing, hp: p.hp, maxHp: p.maxHp, hasSword: p.hasSword,
      alive: p.alive, eliminated: p.eliminated, inGame: p.inGame, score: p.score,
      attacking: now < p.attackUntil, invulnerable: now < p.invulnerableUntil,
    })),
    swords: [...swords.values()].map(s => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, active: s.active })),
    hearts: [...hearts.values()].map(h => ({ id: h.id, x: h.x, y: h.y, w: h.w, h: h.h, active: h.active })),
  };
}

function applyHorizontal(p) {
  p.vx = 0;
  if (p.input.left && !p.input.right) { p.vx = -SPEED; p.facing = 'left'; }
  if (p.input.right && !p.input.left) { p.vx = SPEED; p.facing = 'right'; }
  const nextX = Math.max(PLAYER_W / 2, Math.min(WORLD_W - PLAYER_W / 2, p.x + p.vx * DT));
  const r = playerRect(p, nextX, p.y);
  if (!platforms.some(z => rectsOverlap(r, z))) p.x = nextX;
}

function applyVertical(p) {
  if (p.input.jump && p.onGround) { p.vy = -JUMP_SPEED; p.onGround = false; }
  p.vy = Math.min(MAX_FALL, p.vy + GRAVITY * DT);
  let nextY = Math.max(PLAYER_H, Math.min(WORLD_H, p.y + p.vy * DT));
  let r = playerRect(p, p.x, nextY);
  p.onGround = false;
  for (const z of platforms) {
    if (!rectsOverlap(r, z)) continue;
    const oldBottom = p.y;
    const oldTop = p.y - PLAYER_H;
    if (p.vy >= 0 && oldBottom <= z.y + 6) { nextY = z.y; p.vy = 0; p.onGround = true; }
    else if (p.vy < 0 && oldTop >= z.y + z.h - 6) { nextY = z.y + z.h + PLAYER_H; p.vy = 0; }
    r = playerRect(p, p.x, nextY);
  }
  p.y = nextY;
}

function tryPickupItems(p) {
  const pr = playerRect(p);
  if (!p.hasSword) {
    for (const s of swords.values()) if (s.active && rectsOverlap(pr, itemRect(s))) { s.active = false; p.hasSword = true; break; }
  }
  if (p.hp < p.maxHp) {
    for (const h of hearts.values()) if (h.active && rectsOverlap(pr, itemRect(h))) { h.active = false; p.hp = Math.min(p.maxHp, p.hp + HEART_HEAL); break; }
  }
}

function tryAttack(attacker, now) {
  if (!attacker.input.attack || !attacker.hasSword || !attacker.alive || attacker.eliminated) return;
  if (now - attacker.lastAttackAt < ATTACK_COOLDOWN_MS) return;
  attacker.lastAttackAt = now;
  attacker.attackUntil = now + ATTACK_ACTIVE_MS;
  const range = 42;
  const arc = { x: attacker.facing === 'right' ? attacker.x : attacker.x - range, y: attacker.y - PLAYER_H + 5, w: range, h: PLAYER_H - 6 };
  for (const target of players.values()) {
    if (target.id === attacker.id || !target.inGame || !target.alive || target.eliminated) continue;
    if (now < target.invulnerableUntil) continue;
    if (!rectsOverlap(arc, playerRect(target))) continue;
    target.hp -= ATTACK_DAMAGE;
    target.invulnerableUntil = now + HIT_INVULN_MS;
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.eliminated = true;
      target.hasSword = false;
      target.input = { left: false, right: false, jump: false, attack: false };
      attacker.score += 1;
    }
  }
}

function tick() {
  const now = Date.now();
  maybeCancelCountdown();
  maybeStartCountdown(now);
  if (phase === 'countdown' && countdownEndsAt && now >= countdownEndsAt) startGame(now);

  if (phase === 'playing') {
    for (const p of players.values()) {
      if (!p.inGame || !p.alive || p.eliminated) continue;
      applyHorizontal(p);
      applyVertical(p);
      tryPickupItems(p);
    }
    for (const p of players.values()) tryAttack(p, now);
    checkGameOver(now);
  }

  if (phase === 'ended') {
    if (now - lastGameOverBroadcastAt > 1000) {
      broadcast({ type: 'GAME_OVER', winner, resetIn: gameOverEndsAt ? Math.max(0, Math.ceil((gameOverEndsAt - now) / 1000)) : 0 });
      lastGameOverBroadcastAt = now;
    }
    if (gameOverEndsAt && now >= gameOverEndsAt) resetToLobby(now);
  }

  broadcast(serializeState());
}
setInterval(tick, 1000 / TICK_RATE);

async function iniciarServidor() {
  const server = http.createServer(handleWeb);
  const wss = new WebSocket.Server({ server });
  server.listen(SERVER_PORT, () => logger.info(`Servidor arrancado en puerto ${SERVER_PORT}`));

  wss.on('connection', (ws) => {
    logger.info('Nuevo cliente conectado');
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { sendTo(ws, { type: 'ERROR', message: 'Invalid JSON' }); return; }
      switch (msg.type) {
        case 'JOIN': {
          if (players.has(ws)) return;
          if (phase === 'playing') { sendTo(ws, { type: 'ERROR', message: 'Game already in progress. Wait for next round.' }); return; }
          const p = createPlayer(ws, sanitizeName(msg.name));
          if (!p) { sendTo(ws, { type: 'ERROR', message: 'Server full: no duck colors available' }); return; }
          players.set(ws, p);
          sendTo(ws, { type: 'JOINED', id: p.id, name: p.name, color: p.color });
          broadcastExcept(ws, { type: 'PLAYER_JOINED', id: p.id, name: p.name, color: p.color });
          logger.info(`JOIN: ${p.name} (${p.id})`);
          break;
        }
        case 'INPUT': {
          const p = players.get(ws);
          if (!p) { sendTo(ws, { type: 'ERROR', message: 'Not joined' }); return; }
          p.input = { left: Boolean(msg.left), right: Boolean(msg.right), jump: Boolean(msg.jump), attack: Boolean(msg.attack) };
          break;
        }
        case 'MOVE': {
          const p = players.get(ws);
          if (!p) { sendTo(ws, { type: 'ERROR', message: 'Not joined' }); return; }
          p.input.left = msg.direction === 'LEFT'; p.input.right = msg.direction === 'RIGHT'; p.input.jump = msg.direction === 'UP';
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
        maybeCancelCountdown();
        checkGameOver(Date.now());
        logger.info(`LEFT: ${p.name} (${p.id})`);
      }
    });
    ws.on('error', (err) => logger.error(`WS error: ${err}`));
  });
}
iniciarServidor();
