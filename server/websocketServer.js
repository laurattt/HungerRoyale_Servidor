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

// players: Map<ws, { id, name }>
const players = new Map();

function broadcast(senderWs, payload, includeSender = false) {
    const data = JSON.stringify(payload);
    for (const [ws] of players) {
        if (ws.readyState === WebSocket.OPEN && (includeSender || ws !== senderWs)) {
            ws.send(data);
        }
    }
}

function sendTo(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

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

            logger.debug(`MSG: ${data}`);

            switch (msg.type) {

                // Cliente quiere unirse: { type: 'JOIN', name: 'PlayerName' }
                case 'JOIN': {
                    if (!msg.name || typeof msg.name !== 'string') {
                        sendTo(ws, { type: 'ERROR', message: 'Missing name' });
                        return;
                    }
                    const id = `${msg.name}_${Date.now()}`;
                    players.set(ws, { id, name: msg.name });

                    // Confirmar al jugador su propio id
                    sendTo(ws, { type: 'JOINED', id, name: msg.name });

                    // Notificar al resto
                    broadcast(ws, { type: 'PLAYER_JOINED', id, name: msg.name });

                    // Enviar lista de jugadores actuales al nuevo
                    const currentPlayers = [...players.entries()]
                        .filter(([w]) => w !== ws)
                        .map(([, p]) => ({ id: p.id, name: p.name }));
                    sendTo(ws, { type: 'PLAYER_LIST', players: currentPlayers });

                    logger.info(`JOIN: ${msg.name} (${id})`);
                    break;
                }

                // Cliente envía movimiento: { type: 'MOVE', direction: 'UP'|'LEFT'|'RIGHT' }
                case 'MOVE': {
                    const player = players.get(ws);
                    if (!player) { sendTo(ws, { type: 'ERROR', message: 'Not joined' }); return; }

                    const valid = ['UP', 'LEFT', 'RIGHT'];
                    if (!valid.includes(msg.direction)) {
                        sendTo(ws, { type: 'ERROR', message: 'Invalid direction' });
                        return;
                    }

                    broadcast(ws, {
                        type: 'PLAYER_MOVED',
                        id: player.id,
                        direction: msg.direction,
                        timestamp: Date.now(),
                    }, true);
                    break;
                }

                default:
                    sendTo(ws, { type: 'ERROR', message: `Unknown type: ${msg.type}` });
            }
        });

        ws.on('close', () => {
            const player = players.get(ws);
            if (player) {
                broadcast(ws, { type: 'PLAYER_LEFT', id: player.id, name: player.name });
                players.delete(ws);
                logger.info(`LEFT: ${player.name} (${player.id})`);
            }
        });

        ws.on('error', (err) => logger.error(`WS error: ${err}`));
    });
}

iniciarServidor();
