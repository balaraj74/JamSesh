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

const BITRATE_LEVELS = {
    HIGH: 192000,   // 192 kbps 
    MEDIUM: 96000, 
    LOW: 48000,     
};
const ADAPTATION_INTERVAL_MS = 5000; // check network every 5 seconds

//html references
const remoteAudio = document.getElementById('remoteAudio');

startBtn.disabled = true;

const init = () => {
    ws = new WebSocket("wss://jamsesh-8wui.onrender.com");
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

    startBtn.addEventListener('click', async () => {
        // Only allow the button to be clicked once
        if (isCallInProgress) {
            console.log("Call is already in progress.");
            return;
        }

        // Disable the start button and enable the end button
        startBtn.disabled = true;
        endBtn.disabled = false;
        isCallInProgress = true;
    });

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
            allParticipants = data.participants;
            if (typeof window.updateParticipantList === 'function') {
                window.updateParticipantList(allParticipants);
            }
            break;
        }

        case 'user-joined': {
            const newParticipant = data.newParticipant;
            if (!newParticipant) break;

            console.log(`New user ${newParticipant.username} joined.`);
            allParticipants.push(newParticipant);
            if (typeof window.updateParticipantList === 'function') {
                window.updateParticipantList(allParticipants);
            }
            break;
        }

        case 'client-left': {
            const leavingParticipant = data.participant;
            if (!leavingParticipant) break;

            console.log(`Client ${leavingParticipant.username} left.`);
            allParticipants = allParticipants.filter(p => p.id !== leavingParticipant.id);
            if (typeof window.updateParticipantList === 'function') {
                window.updateParticipantList(allParticipants);
            }
            if (peerConnections[leavingParticipant.id]) {
                peerConnections[leavingParticipant.id].close();
                delete peerConnections[leavingParticipant.id];
            }
            break;
        }

        case 'start-call': {
            startCall = true;
            startBtn.disabled = false;
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
            endBtn.disabled = false; 
            startBtn.disabled = true;
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
            // This message is sent when the original host leaves
            if (data.isYou) {
                console.log('🎉 You have been promoted to host!');
                // Show notification to user that they are now the host
                alert('You are now the host! The previous host has left the session. You can now start the jam when ready.');
                
                // Enable start button so new host can control the session
                if (startBtn) {
                    startBtn.disabled = false;
                    startBtn.textContent = 'Start Jam (You are Host)';
                }
                
                // The new host needs to be able to share audio like the original host
                // We need to acquire media when they click start
                startBtn.addEventListener('click', async () => {
                    if (isCallInProgress) {
                        console.log("Call is already in progress.");
                        return;
                    }

                    // Acquire media like the host does
                    try {
                        const audioConstraints = {
                            autoGainControl: false,
                            echoCancellation: false,
                            noiseSuppression: false
                        };

                        localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: audioConstraints });
                        // Stop the video track
                        localStream.getVideoTracks().forEach(track => track.stop());
                        console.log("New host has acquired local audio stream.");
                        
                        // Notify server to start the call
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'start-call',
                                code: roomCode,
                                role: 'host'
                            }));
                        }
                        
                        // Create offers to all other participants
                        for (const participant of allParticipants) {
                            if (participant.id !== clientId) {
                                await createAndSendOfferAsNewHost(participant.id);
                            }
                        }
                        
                        startBtn.disabled = true;
                        endBtn.disabled = false;
                        isCallInProgress = true;
                    } catch (error) {
                        console.error("New host failed to acquire media:", error);
                        alert("Failed to start audio streaming. Please try again.");
                    }
                }, { once: true }); // Use once to prevent multiple listeners
            } else {
                console.log(`${data.newHostUsername} is now the host.`);
                // Update UI to show who the new host is
                if (typeof window.updateHostIndicator === 'function') {
                    window.updateHostIndicator(data.newHostUsername);
                }
            }
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
    
    startBtn.disabled = false;
    endBtn.disabled = true;
    console.log("Call ended and resources cleaned up.");
}

window.onload = init;
});