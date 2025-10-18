function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// Load timesync before running anything else
loadScript("https://unpkg.com/timesync/dist/timesync.min.js").then(() => {
    console.log("✅ timesync loaded");

    // === Time sync setup ===
    var ts = timesync.create({
        server: '/timesync',
        interval: 5000
    });

    // tells how far off device's clock is from server's clock
    let timeOffset = 0; 
    ts.on('change', function (offset) {
        timeOffset = offset;
        console.log('Clock offset from server:', offset, 'ms');
    });

    
    const FIXED_DELAY_MS = 400; 

let ws;
let clientId = null;
let roomCode = null; // Store room code for when joiner becomes host
const peerConnections = {};
let isCallInProgress = false;
let startCall = false;
let localStream; // For when a joiner becomes the host
const iceServers = [];
let allParticipants = [];
let currentHostId = null;
let isCurrentHost = false;

const BITRATE_LEVELS = {
    HIGH: 192000,   // 192 kbps 
    MEDIUM: 96000, 
    LOW: 48000,     
};
const ADAPTATION_INTERVAL_MS = 5000; // check network every 5 seconds

//html references
const remoteAudio = document.getElementById('remoteAudio');
const localAudio = document.getElementById('localAudio');
let startBtn = document.getElementById('startBtn');
let endBtn = document.getElementById('endBtn');
let exitBtn = document.getElementById('exitBtn');
const localAudioWrapper = document.querySelector('.audio-wrapper:first-child');
const remoteAudioWrapper = document.querySelector('.audio-wrapper:last-child');
const participantsListEl = document.getElementById('participants-list');

function cacheRoomState(participants, hostId) {
    try {
        localStorage.setItem('jamsesh.roomState', JSON.stringify({
            participants: participants || [],
            hostId: hostId || null
        }));
    } catch (e) {
        console.debug('Unable to cache room state', e);
    }
}

function updateParticipantsList(participants, hostId) {
    currentHostId = hostId ?? currentHostId;
    console.log('👥 Updating participants list:', { participants, hostId: currentHostId, clientId });
    if (typeof window.updateParticipantList === 'function') {
        window.updateParticipantList(participants, currentHostId);
    } else if (participantsListEl) {
        participantsListEl.innerHTML = '';
        (participants || []).forEach(p => {
            const item = document.createElement('li');
            let label = p.username;
            if (p.id === currentHostId) {
                label += ' 👑';
                console.log(`Adding crown to ${p.username} (${p.id})`);
            }
            if (p.id === clientId) {
                label += ' (You)';
                item.classList.add('you');
            }
            item.textContent = label;
            participantsListEl.appendChild(item);
        });
    }
}

function enableHostControls() {
    if (typeof window.enableHostUI === 'function') {
        window.enableHostUI();
        return;
    }
    if (localAudioWrapper) localAudioWrapper.style.display = '';
    if (remoteAudioWrapper) remoteAudioWrapper.style.display = 'none';
    if (startBtn) {
        startBtn.style.display = '';
        startBtn.disabled = false;
        startBtn.textContent = 'Start Jam (You are Host)';
    }
    if (endBtn) {
        endBtn.style.display = '';
        endBtn.disabled = true;
    }
    if (exitBtn) exitBtn.style.display = 'none';
}

function enableListenerControls() {
    if (typeof window.enableListenerUI === 'function') {
        window.enableListenerUI();
        return;
    }
    if (localAudioWrapper) localAudioWrapper.style.display = 'none';
    if (remoteAudioWrapper) remoteAudioWrapper.style.display = '';
    if (startBtn) {
        startBtn.style.display = 'none';
        startBtn.disabled = true;
    }
    if (endBtn) {
        endBtn.style.display = 'none';
        endBtn.disabled = true;
    }
    if (exitBtn) exitBtn.style.display = '';
}

async function handleHostStart() {
    if (!isCurrentHost) {
        console.log('Ignoring start request because this client is not the host.');
        return;
    }
    if (isCallInProgress) {
        console.log('Call is already in progress.');
        return;
    }
    if (!startBtn) return;

    try {
        startBtn.disabled = true;
        startBtn.textContent = 'Acquiring audio...';

        const audioConstraints = {
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false
        };

        localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: audioConstraints });
        localStream.getVideoTracks().forEach(track => track.stop());

        if (localAudio) {
            localAudio.srcObject = localStream;
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'start-call',
                code: roomCode,
                role: 'host'
            }));
        }

        for (const participant of allParticipants) {
            if (participant.id !== clientId) {
                await createAndSendOfferAsNewHost(participant.id);
            }
        }

        startBtn.textContent = 'Streaming...';
        if (endBtn) endBtn.disabled = false;
        isCallInProgress = true;
        console.log('✅ Now streaming as host');
    } catch (error) {
        console.error('Failed to start host stream:', error);
        alert('Failed to start audio streaming. Please check permissions and try again.');
        startBtn.disabled = false;
        startBtn.textContent = 'Start Jam (You are Host)';
    }
}

function attachHostStartHandler() {
    if (!startBtn) return;
    const cloned = startBtn.cloneNode(true);
    startBtn.parentNode.replaceChild(cloned, startBtn);
    startBtn = cloned;
    startBtn.textContent = 'Start Jam (You are Host)';
    startBtn.disabled = false;
    startBtn.style.display = '';
    startBtn.addEventListener('click', handleHostStart);
}

function attachHostEndHandler() {
    if (!endBtn) return;
    const cloned = endBtn.cloneNode(true);
    endBtn.parentNode.replaceChild(cloned, endBtn);
    endBtn = cloned;
    endBtn.disabled = true;
    endBtn.style.display = '';
    endBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'end-call',
                code: roomCode,
                role: 'host'
            }));
        }
        endCall();
    });
}

function promoteToHost(previousHostName) {
    if (isCurrentHost) return;
    isCurrentHost = true;
    currentHostId = clientId;
    console.log('🎉 Promoted to host', previousHostName ? `after ${previousHostName} left` : '');
    enableHostControls();
    attachHostStartHandler();
    attachHostEndHandler();
    if (startBtn) startBtn.disabled = false;
    if (endBtn) endBtn.disabled = true;
    alert('You are now the host! Start the jam when you are ready.');
}

function demoteToListener() {
    if (!isCurrentHost) return;
    isCurrentHost = false;
    enableListenerControls();
    if (isCallInProgress) {
        endCall();
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
}

function syncHostState(hostId, participants = allParticipants) {
    const previousHostId = currentHostId;
    currentHostId = hostId ?? null;
    const currentHostEntry = (participants || []).find(p => p.id === currentHostId) || null;
    if (typeof window.setHostIdentity === 'function') {
        window.setHostIdentity(currentHostId);
    }

    if (currentHostId === clientId) {
        if (!isCurrentHost) {
            const previousHostEntry = (participants || []).find(p => p.id === previousHostId);
            promoteToHost(previousHostEntry ? previousHostEntry.username : null);
        }
    } else if (isCurrentHost) {
        demoteToListener();
        alert('You are no longer the host of this jam session.');
    } else {
        enableListenerControls();
    }
}

function applyRoomSnapshot(participants, hostId) {
    console.log('📸 Applying room snapshot:', { participants, hostId });
    if (Array.isArray(participants)) {
        allParticipants = participants;
    }
    cacheRoomState(allParticipants, hostId);
    updateParticipantsList(allParticipants, hostId);
    syncHostState(hostId, allParticipants);
}

enableListenerControls();

const init = () => {
    ws = new WebSocket("wss://jamsesh-8wui.onrender.com");
    window.ws = ws;
    ws.onopen = () => {
        console.log("Websocket connected");
    };

    ws.onmessage = handleSignalingMessage;

    ws.onclose = () => {
        // Closing the connection
        console.log('WebSocket disconnected.');
        endCall();
    };

    ws.onerror = (err) => {
        // Error occured
        console.error('WebSocket error:', err);
        endCall();
    };

    if (startBtn) {
        startBtn.addEventListener('click', handleHostStart);
    }

    if (endBtn) {
        endBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'end-call',
                code: roomCode,
                role: 'join'
            })); // end call mesg to signalling server
        }
        endCall();
    });
    }
}

async function handleSignalingMessage(event) {

    const data = JSON.parse(event.data);
    switch (data.type) {
        case 'init': {
            clientId = data.clientId;
            window.currentClientId = clientId; 
            const urlParams = new URLSearchParams(window.location.search);
            roomCode = urlParams.get('code'); // Store in global variable
            const username = urlParams.get('username');
            ws.send(JSON.stringify({ type: 'joinroom', code: roomCode, from: clientId, username: username }));
            break;
        }
        case 'join_success': {
            console.log(`Joiner successfully joined room ${data.code}.`);
            console.log('Join success data:', { participants: data.participants, hostId: data.hostId, isHost: data.isHost });
            applyRoomSnapshot(data.participants, data.hostId);
            break;
        }

        case 'user-joined': {
            const newParticipant = data.newParticipant;
            if (!newParticipant) break;

            console.log(`New user ${newParticipant.username} joined.`);
            allParticipants.push(newParticipant);
            updateParticipantsList(allParticipants, currentHostId);
            cacheRoomState(allParticipants, currentHostId);
            break;
        }

        case 'client-left': {
            const leavingParticipant = data.participant;
            if (!leavingParticipant) break;

            console.log(`Client ${leavingParticipant.username} left.`);
            allParticipants = allParticipants.filter(p => p.id !== leavingParticipant.id);
            updateParticipantsList(allParticipants, currentHostId);
            cacheRoomState(allParticipants, currentHostId);
            if (peerConnections[leavingParticipant.id]) {
                peerConnections[leavingParticipant.id].close();
                delete peerConnections[leavingParticipant.id];
            }
            break;
        }

        case 'start-call': {
            startCall = true;
            if (startBtn) startBtn.disabled = false;
            return;
        }

        case 'offer': {
            const offererId = data.from;
            // get the pc instance from our stored object
            let pc = peerConnections[offererId]?.pc;

            if (!pc) {
                pc = await createPeerConnection(offererId);
                peerConnections[offererId] = { pc: pc };
            }
            
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            ws.send(JSON.stringify({
                type: 'answer',
                sdp: pc.localDescription,
                to: data.from,
                from: clientId}));
            
            isCallInProgress = true;
            if (endBtn) endBtn.disabled = false; 
            if (startBtn) startBtn.disabled = true;
            console.log("Received and answered an offer from the master.");
            break;
        }

        case 'answer': {
            // When we're promoted to host and send offers, we'll receive answers
            const answererId = data.from;
            const peer = peerConnections[answererId];
            if (!peer || !peer.pc) {
                console.error("Answer received but peerConnection not initialized for:", answererId);
                return;
            }
            await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            console.log(`Received answer from ${answererId} as new host. Call established.`);

            // Start monitoring network quality for this peer
            if (peer && !peer.monitorInterval) {
                peer.monitorInterval = setInterval(() => {
                    monitorAndAdaptBitrate(answererId);
                }, ADAPTATION_INTERVAL_MS);
                console.log(`Started network quality monitoring for ${answererId}.`);
            }
            break;
        }

        case 'ice-candidate': {
            const peerId = data.from;
            const pc = peerConnections[peerId]?.pc; 
            if (pc && data.candidate) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                } catch (e) {
                    console.warn('ICE candidate error:', e);
                }
            } else {
                console.warn(`ICE candidate received for unknown peer ${peerId} or no candidate data.`);
            }
            break;
        }

        case 'host-promoted': {
            cacheRoomState(allParticipants, data.newHostId);
            updateParticipantsList(allParticipants, data.newHostId);
            syncHostState(data.newHostId, allParticipants);
            if (!data.isYou) {
                console.log(`${data.newHostUsername} is now the host.`);
            }
            break;
        }

        case 'room-update': {
            console.log('📢 Room update received:', { participants: data.participants, hostId: data.hostId });
            applyRoomSnapshot(data.participants, data.hostId);
            break;
        }

        case 'end-call':
            endCall();
            startCall = false;
            break;
    }
}

async function createPeerConnection(peerId) {

    const sessionIceServers = [...iceServers];
    try {
        const response = await fetch("/api/get-turn-credentials");
        if (response.ok) {
            const turnServers = await response.json();
            if (Array.isArray(turnServers) && turnServers.length > 0) {
                sessionIceServers.push(...turnServers); // Add fetched TURN to the session array
                console.log("Fetched TURN credentials and added to iceServers.");
            } else {
                console.warn("No TURN credentials fetched, proceeding with just STUN servers.");
            }
        } else {
            console.warn(`Failed to fetch TURN credentials: ${response.status} ${response.statusText}`);
        }
    } catch (e) {
        console.error("Error fetching TURN credentials:", e);
    }

    const pc = new RTCPeerConnection({ iceServers: sessionIceServers });
    console.log('PeerConnection initialized.');

    pc.ontrack = event => {
        // plays audio
        console.log('Remote track received', event.streams[0]);

        if (remoteAudio) { 
            remoteAudio.srcObject = event.streams[0];
            remoteAudio.play()
                .catch(e => {
                    console.warn("Autoplay was blocked. User must interact with the page first.", e.name);
                });
        }else {
            console.warn("Remote audio element not found");
        }

        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(event.streams[0]);
        source.connect(audioCtx.destination);

        // when to start playback wrt server time
        //tlocal->local time;  tserver-> local time; wrtserver-> time it should start playback wrt server
        syncPlayback(audioCtx);
        const intervalId = setInterval(() => syncPlayback(audioCtx), 5000);
        function syncPlayback(audioCtx)
        {
        const tlocal = Date.now();
        const tserver = tlocal + timeOffset; // adjust local clock to server clock
        const wrtserver = tserver + FIXED_DELAY_MS;

        // convert server time back to local time
        const delayMs = wrtserver - (Date.now() + timeOffset);

        console.log(`audio start in ${delayMs} ms`);   //debug log
        audioCtx.suspend().then(() => {
            setTimeout(() => {
                audioCtx.resume();
                console.log("resumed in sync!");
            }, Math.max(0, delayMs));
        });
    };
}

    pc.onconnectionstatechange = () => {
        console.log(`Peer Connection State for ${peerId}:`, pc.connectionState);
    }; // simplified

    pc.onicecandidate = event => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                to: peerId,
                from: clientId,
                candidate: event.candidate
            }));
        }
    };

    return pc;
}

// set a new bitrate for a specific peer
async function setBitrateForPeer(peerId, newLevel) {
    const peer = peerConnections[peerId];
    if (!peer || !peer.audioSender || peer.currentBitrate === newLevel) {
        return; // no change needed/sender not ready
    }

    console.log(`adapting bitrate for ${peerId} from ${peer.currentBitrate} to ${newLevel}`);
    const params = peer.audioSender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = BITRATE_LEVELS[newLevel];

    try {
        await peer.audioSender.setParameters(params);
        peer.currentBitrate = newLevel; 
        console.log(`successfully set bitrate for ${peerId} to ${newLevel} (${BITRATE_LEVELS[newLevel]} bps)`);
    } catch (e) {
        console.error(`failed to set bitrate for ${peerId}:`, e);
    }
}

// monitoring and adapting the bitrate
async function monitorAndAdaptBitrate(peerId) {
    const peer = peerConnections[peerId];
    if (!peer || !peer.pc || !peer.audioSender) {
        return;
    }

    const stats = await peer.pc.getStats();
    let packetLoss = 0;
    let rtt = 0;

    stats.forEach(report => {
        if (report.type === 'remote-inbound-rtp' && report.kind === 'audio') {
            // fractionLost: value b/w 0 and 1 representing packet loss 
            packetLoss = report.fractionLost;
            rtt = report.roundTripTime;
            console.log(`[stats for ${peerId}] Packet Loss: ${(packetLoss * 100).toFixed(2)}%, RTT: ${(rtt * 1000).toFixed(0)}ms`);
        }
    });

    if (packetLoss > 0.15 || rtt > 0.4) { // 15% packet loss or 400ms RTT, vansh change it if u want to
        if (peer.currentBitrate === 'HIGH') {
            setBitrateForPeer(peerId, 'MEDIUM');
        } else if (peer.currentBitrate === 'MEDIUM') {
            setBitrateForPeer(peerId, 'LOW');
        }
        return; 
    }

    // if network is excellent, try to go up a level
    if (packetLoss < 0.1 && rtt < 0.25) { 
        if (peer.currentBitrate === 'LOW') {
            setBitrateForPeer(peerId, 'MEDIUM');
        } else if (peer.currentBitrate === 'MEDIUM') {
            setBitrateForPeer(peerId, 'HIGH');
        }
    }
}

// Function for new host to create and send offers to other participants
async function createAndSendOfferAsNewHost(targetClientId) {
    if (peerConnections[targetClientId]) {
        console.warn(`Connection to ${targetClientId} already exists.`);
        return;
    }
    console.log(`New host initiating connection to ${targetClientId}`);
    const pc = await createPeerConnection(targetClientId);
    
    peerConnections[targetClientId] = {
        pc: pc,
        audioSender: null,
        currentBitrate: 'HIGH',
        monitorInterval: null
    };

    if (localStream) {
        const audioTracks = localStream.getAudioTracks();
        if (audioTracks.length > 0) {
            const audioSender = pc.addTrack(audioTracks[0], localStream);
            peerConnections[targetClientId].audioSender = audioSender;
            console.log("Added audio track for streaming as new host.");

            // Set initial bitrate
            const audioParameters = audioSender.getParameters();
            if (!audioParameters.encodings) {
                audioParameters.encodings = [{}];
            }
            audioParameters.encodings[0].maxBitrate = BITRATE_LEVELS.HIGH;
            audioParameters.encodings[0].priority = 'high';
            try {
                await audioSender.setParameters(audioParameters);
                console.log('Audio sender parameters set to high bitrate.');
            } catch (e) {
                console.warn('Failed to set audio sender parameters:', e);
            }
        }
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.send(JSON.stringify({
        type: 'offer',
        sdp: pc.localDescription,
        to: targetClientId,
        from: clientId
    }));
    console.log(`Offer sent to ${targetClientId} as new host.`);
}

function endCall() {
    if (!isCallInProgress) {
        return;
    }

    console.log("ending call");
    isCallInProgress = false;

    // loop and clear intervals before closing connections
    for (const id in peerConnections) {
        const peer = peerConnections[id];
        
        if (peer.monitorInterval) {
            clearInterval(peer.monitorInterval);
        }

        if(peer.syncInterval) {
            clearInterval(peer.syncInterval);
        }
        if (peer.pc) {
            peer.pc.close();
        }
        delete peerConnections[id];
    }

    if (remoteAudio) remoteAudio.srcObject = null;
    
    if (startBtn) {
        startBtn.disabled = isCurrentHost ? false : true;
        if (isCurrentHost) {
            startBtn.textContent = 'Start Jam (You are Host)';
        }
    }
    if (endBtn) {
        endBtn.disabled = true;
    }

    if (isCurrentHost) {
        enableHostControls();
    } else {
        enableListenerControls();
    }
    console.log("Call ended and resources cleaned up.");
}

window.onload = init;
});