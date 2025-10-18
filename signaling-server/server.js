require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server }); 
const clients = new Map();
const activeRooms = new Map();

function sanitizeParticipants(room) {
    if (!room) {
        return [];
    }
    return room.clients.map(client => ({
        id: client.id,
        username: client.username,
        isHost: room.hostId === client.id
    }));
}

function setRoomHost(room, newHostId) {
    if (!room) return;
    room.hostId = newHostId || null;
    room.clients.forEach(client => {
        client.isHost = client.id === room.hostId;
    });
}

function broadcastRoomState(roomCode) {
    const room = activeRooms.get(roomCode);
    if (!room) return;
    const payload = {
        type: 'room-update',
        participants: sanitizeParticipants(room),
        hostId: room.hostId
    };

    room.clients.forEach(client => {
        const clientWs = clients.get(client.id);
        if (clientWs) {
            clientWs.send(JSON.stringify(payload));
        }
    });
}

app.use(cors()); 

app.use(express.static(path.join(__dirname, '../public')));

const timesyncServer = require('timesync/server');
app.use('/timesync', timesyncServer.requestHandler);

app.get('/api/ping', (req, res) => {
    res.send('pong');
});

app.get('/api/get-turn-credentials', async (req, res) => {
    try {
        const turnApiLink = process.env.TURN_API_LINK;
        if (!turnApiLink) {
            throw new Error("TURN_API_LINK not found in .env file!");
        }
        const response = await fetch(turnApiLink);
        if (!response.ok) {
            throw new Error(`Failed to fetch from provider: ${response.statusText}`);
        }
        const credentials = await response.json();
        res.json(credentials);
    } catch (error) {
        console.error("Server: Error fetching TURN credentials:", error.message);
        res.status(500).json({ error: "Failed to get TURN credentials." });
    }
});

wss.on('connection', (ws) => {
    // new client assigned id
    const clientId = uuidv4();
    ws.clientId = clientId;
    clients.set(clientId, ws);
    console.log(`Client ${clientId} connected. Total clients: ${clients.size}`);

    ws.send(JSON.stringify({ type: 'init', clientId: clientId }));

    ws.on('message', (message) => handleClientMessage(ws, message));
    ws.on('close', () => handleClientDisconnect(ws));
});

function sendHostPromoted(roomCode, newHostId, newHostUsername) {
    const room = activeRooms.get(roomCode);
    if (!room) return;
    room.clients.forEach(client => {
        const clientWs = clients.get(client.id);
        if (clientWs) {
            clientWs.send(JSON.stringify({
                type: 'host-promoted',
                newHostId,
                newHostUsername,
                isYou: client.id === newHostId
            }));
        }
    });
}

function handleClientMessage(ws, message) {
    const data = JSON.parse(message.toString());
    const clientId = ws.clientId;
    const roomCode = ws.roomCode; 

    switch (data.type) {
        case 'create_room':
            const newCode = generateUniqueCode();
            activeRooms.set(newCode, { clients: [], hostId: null });
            ws.send(JSON.stringify({ type: 'room_created', code: newCode }));
            console.log(`Room ${newCode} created.`);
            break;

        case 'validation':
            ws.send(JSON.stringify({
                type: 'validation',
                status: activeRooms.has(data.code) ? 'valid' : 'invalid'
            }));
            break;

        case 'joinroom': {
            const codeToJoin = data.code;
            if (!activeRooms.has(codeToJoin)) {
                console.warn(`Client ${clientId} attempted to join non-existent room ${codeToJoin}`);
                break;
            }

            const room = activeRooms.get(codeToJoin);
            console.log(`[JOINROOM] Before adding ${clientId}: room.hostId = ${room.hostId}, room.clients.length = ${room.clients.length}`);
            
            const newParticipant = {
                id: clientId,
                username: data.username,
                role: data.role || 'join',
                isHost: false
            };

            // Notify existing participants before updating room state
            room.clients.forEach(p => {
                const clientWs = clients.get(p.id);
                if (clientWs) {
                    clientWs.send(JSON.stringify({ type: 'user-joined', newParticipant }));
                }
            });

            room.clients.push(newParticipant);
            ws.roomCode = codeToJoin;

            if (!room.hostId) {
                setRoomHost(room, clientId);
                console.log(`[JOINROOM] First to join: ${clientId} (${data.username}) is now the host of room ${codeToJoin}`);
            } else {
                setRoomHost(room, room.hostId);
                console.log(`[JOINROOM] Not first: Keeping existing host ${room.hostId}`);
            }

            const snapshot = sanitizeParticipants(room);
            console.log(`[JOIN_SUCCESS] Sending to ${clientId}:`, {
                hostId: room.hostId,
                isHost: clientId === room.hostId,
                participantCount: snapshot.length
            });
            ws.send(JSON.stringify({
                type: 'join_success',
                code: codeToJoin,
                participants: snapshot,
                hostId: room.hostId,
                isHost: clientId === room.hostId
            }));

            broadcastRoomState(codeToJoin);
            break;
        }

        case 'start-call':
            if (roomCode && activeRooms.has(roomCode)) {
                const room = activeRooms.get(roomCode);
                // Only allow the host to start calls
                if (room.hostId === clientId) {
                    room.clients.forEach(p => {
                        if (p.id !== clientId) { 
                            const clientWs = clients.get(p.id);
                            if (clientWs) clientWs.send(JSON.stringify({ type: data.type }));
                        }
                    });
                } else {
                    console.log(`Non-host ${clientId} attempted to ${data.type}`);
                }
            }
            break;

        case 'end-call':
            if (roomCode && activeRooms.has(roomCode)) {
                const room = activeRooms.get(roomCode);
                // Only allow the host to end calls
                if (room.hostId === clientId) {
                    console.log(`Host ${clientId} ended the call in room ${roomCode}`);
                    
                    // Broadcast end-call to other participants first
                    room.clients.forEach(p => {
                        if (p.id !== clientId) { 
                            const clientWs = clients.get(p.id);
                            if (clientWs) clientWs.send(JSON.stringify({ type: 'end-call' }));
                        }
                    });
                    
                    // Remove the host from the room (they're ending their session)
                    const leavingHost = room.clients.find(p => p.id === clientId);
                    room.clients = room.clients.filter(p => p.id !== clientId);
                    
                    // Notify remaining participants that host left
                    room.clients.forEach(p => {
                        const clientWs = clients.get(p.id);
                        if (clientWs) clientWs.send(JSON.stringify({ 
                            type: 'client-left', 
                            participant: leavingHost 
                        }));
                    });
                    
                    // If there are still participants, promote the next one to host
                    if (room.clients.length > 0) {
                        const newHost = room.clients[0];
                        setRoomHost(room, newHost.id);
                        console.log(`Promoting ${newHost.id} (${newHost.username}) to host in room ${roomCode}`);
                        broadcastRoomState(roomCode);
                    } else {
                        // No one left, delete the room
                        activeRooms.delete(roomCode);
                        console.log(`Room ${roomCode} is now empty and has been deleted.`);
                    }
                } else {
                    console.log(`Non-host ${clientId} attempted to end call`);
                }
            }
            break;

            case 'offer':
        case 'answer':
        case 'ice-candidate':
            const targetClient = clients.get(data.to);
            // Security check: ensure target exists and is in the same room.
            if (targetClient && ws.roomCode === targetClient.roomCode) {
                targetClient.send(JSON.stringify({ ...data, from: clientId }));
            }
            break;
            
        default:
            console.log(`[Server] Received unhandled message type: ${data.type}`);
    }
}

function handleClientDisconnect(ws) {
    const clientId = ws.clientId;
    const roomCode = ws.roomCode;
    console.log(`Client ${clientId} disconnected.`);

    if (roomCode && activeRooms.has(roomCode)) {
        const room = activeRooms.get(roomCode);
        const leavingParticipant = room.clients.find(p => p.id === clientId);
        const wasHost = room.hostId === clientId;
        
        room.clients = room.clients.filter(p => p.id !== clientId);

        // Notify all clients that someone left
        room.clients.forEach(p => {
            const clientWs = clients.get(p.id);
            if (clientWs) clientWs.send(JSON.stringify({ type: 'client-left', participant: leavingParticipant }));
        });

        // If the host left and there are still participants, promote the next one
        if (wasHost && room.clients.length > 0) {
            const newHost = room.clients[0];
            setRoomHost(room, newHost.id);
            console.log(`Host left. Promoting ${newHost.id} (${newHost.username}) to host in room ${roomCode}`);
            broadcastRoomState(roomCode);
        }

        if (room.clients.length === 0) {
            activeRooms.delete(roomCode);
            console.log(`Room ${roomCode} is now empty and has been deleted.`);
        }
    }
    clients.delete(clientId); // remove from all list
}

function generateUniqueCode() {
    let newCode;
    do {
        newCode = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
    } while (activeRooms.has(newCode));
    return newCode;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});