
document.addEventListener('DOMContentLoaded', () => {
    let clientId = null;
    let roomCode = null;
    let validity = false;
    
    console.log(`Attempting to join room: ${roomCode}`);

    const ws = new WebSocket("wss://jamsesh-8wui.onrender.com"); 
        ws.onopen = () => {
            console.log("Websocket connected");
        };
        ws.onmessage = (message) => {
            const data = JSON.parse(message.data);

            if (data.type === 'init') {
                clientId = data.clientId;
                console.log(`Connected to server. My client ID is: ${clientId}`);
            }

            if (data.type === 'room_created') {
                roomCode = data.code; 
                console.log(`Server created room with code: ${roomCode}`);
                document.getElementById('jamCodeDisplay').textContent = `Your Jam Code: ${roomCode}`;
                document.getElementById('enterRoomHostBtn').style.display = 'inline-block';
            }
            if (data.type === 'validation') {
                if (data.status === 'valid') {
                    console.log("Room code is valid!");
                    validity = true;
                    document.getElementById('enterRoomJoinBtn').style.display = 'inline-block';
                } else {
                    validity = false;
                    alert("That room code is not valid.");
                    }
            }
        };

    const hostBtn = document.getElementById('hostBtn');
    if (hostBtn) {
        hostBtn.addEventListener('click', () => {
            window.location.href = 'host.html';
        });
    }

    // index.html
    const joinBtn = document.getElementById('joinBtn');
    if (joinBtn) {
        joinBtn.addEventListener('click', () => {
            window.location.href = 'join.html';
        });
    }

    // host.html
    const generateCodeBtn = document.getElementById('generateCodeBtn');
    if (generateCodeBtn) {
        generateCodeBtn.addEventListener('click', () => {
            ws.send(JSON.stringify({ type: 'create_room' }));
        });
    }

    // host.html
    const enterRoomHostBtn = document.getElementById('enterRoomHostBtn');
    if(enterRoomHostBtn) {
        enterRoomHostBtn.addEventListener('click', () => {
            if (roomCode !== null) {
                window.location.href = `page2.html?role=host&code=${roomCode}`;
            }
        });
    }

    // join.html
    const jamCodeInput = document.getElementById('jamCode');
    if (jamCodeInput) {
        jamCodeInput.addEventListener('input', () => {
            const jamCode = jamCodeInput.value;
            if (jamCode.length === 6) {
                ws.send(JSON.stringify({
                    type: 'validation',
                    code: jamCode
                }));
            } else {
                // Reset validity if user changes the code
                validity = false;
                document.getElementById('enterRoomJoinBtn').style.display = 'none';
            }

        });
    }

    const enterRoomJoinBtn = document.getElementById('enterRoomJoinBtn');
    if (enterRoomJoinBtn) {
        enterRoomJoinBtn.addEventListener('click', () => {
            if (validity === true) {
                const jamCode = jamCodeInput.value;
                window.location.href = `page2.html?role=join&code=${jamCode}`;
            }
            else {
                alert("Please enter a valid jam code.")
            }
        });
    }

});