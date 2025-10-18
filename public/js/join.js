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
const localAudio = document.getElementById('localAudio');
const startBtn = document.getElementById('startBtn');
const endBtn = document.getElementById('endBtn');
const exitBtn = document.getElementById('exitBtn');

if (startBtn) startBtn.disabled = true;

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
                console.log('Promotion data:', data);
                
                // Show notification to user that they are now the host
                alert('You are now the host! The previous host has left the session. You can now start the jam when ready.');
                
                // Get fresh references to UI elements
                const localAudioWrapper = document.querySelector('.audio-wrapper:first-child');
                const remoteAudioWrapper = document.querySelector('.audio-wrapper:last-child');
                const startButton = document.getElementById('startBtn');
                const endButton = document.getElementById('endBtn');
                const exitButton = document.getElementById('exitBtn');
                
                console.log('UI Elements found:', {
                    localAudioWrapper: !!localAudioWrapper,
                    remoteAudioWrapper: !!remoteAudioWrapper,
                    startButton: !!startButton,
                    endButton: !!endButton,
                    exitButton: !!exitButton
                });
                
                // Show local audio controls (previously hidden for join role)
                if (localAudioWrapper) {
                    localAudioWrapper.style.display = 'block';
                    console.log('✅ Showed local audio wrapper');
                }
                
                // Hide remote audio controls (now we're streaming, not receiving)
                if (remoteAudioWrapper) {
                    remoteAudioWrapper.style.display = 'none';
                    console.log('✅ Hid remote audio wrapper');
                }
                
                // Show and enable start button
                if (startButton) {
                    startButton.style.display = 'inline-block';
                    startButton.disabled = false;
                    startButton.textContent = 'Start Jam (You are Host)';
                    console.log('✅ Enabled start button');
                }
                
                // Show end button (disabled until start)
                if (endButton) {
                    endButton.style.display = 'inline-block';
                    endButton.disabled = true;
                    console.log('✅ Showed end button');
                }
                
                // Hide exit button (hosts don't have exit, they have end)
                if (exitButton) {
                    exitButton.style.display = 'none';
                    console.log('✅ Hid exit button');
                }
                
                // Remove old event listener and add new one
                if (startButton) {
                    const newStartBtn = startButton.cloneNode(true);
                    startButton.parentNode.replaceChild(newStartBtn, startButton);
                    
                    newStartBtn.addEventListener('click', async () => {
                        if (isCallInProgress) {
                            console.log("Call is already in progress.");
                            return;
                        }

                        // Acquire media like the host does
                        try {
                            console.log('New host starting to acquire audio...');
                            newStartBtn.disabled = true;
                            newStartBtn.textContent = 'Acquiring audio...';
                            
                            const audioConstraints = {
                                autoGainControl: false,
                                echoCancellation: false,
                                noiseSuppression: false
                            };

                            localStream = await navigator.mediaDevices.getDisplayMedia({ 
                                video: true, 
                                audio: audioConstraints 
                            });
                            
                            // Stop the video track
                            localStream.getVideoTracks().forEach(track => track.stop());
                            console.log("✅ New host acquired local audio stream");
                            
                            // Play local audio
                            const localAudio = document.getElementById('localAudio');
                            if (localAudio) {
                                localAudio.srcObject = localStream;
                                console.log('✅ Set local audio srcObject');
                            }
                            
                            // Notify server to start the call
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'start-call',
                                    code: roomCode,
                                    role: 'host'
                                }));
                                console.log('✅ Sent start-call to server');
                            }
                            
                            // Create offers to all other participants
                            console.log('Creating offers to participants:', allParticipants);
                            for (const participant of allParticipants) {
                                if (participant.id !== clientId) {
                                    console.log(`Creating offer for ${participant.username}`);
                                    await createAndSendOfferAsNewHost(participant.id);
                                }
                            }
                            
                            newStartBtn.textContent = 'Streaming...';
                            newStartBtn.disabled = true;
                            
                            const newEndBtn = document.getElementById('endBtn');
                            if (newEndBtn) {
                                newEndBtn.disabled = false;
                                console.log('✅ Enabled end button');
                            }
                            
                            isCallInProgress = true;
                            console.log('✅ New host is now streaming to all participants!');
                            
                        } catch (error) {
                            console.error("❌ New host failed to acquire media:", error);
                            alert("Failed to start audio streaming. Please check your audio permissions and try again.");
                            newStartBtn.disabled = false;
                            newStartBtn.textContent = 'Start Jam (You are Host)';
                        }
                    });
                    
                    console.log('✅ Added event listener to start button');
                }
                
            } else {
                console.log(`${data.newHostUsername} is now the host.`);
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