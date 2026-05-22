/**
 * JUST-CHAT! - CORE APPLICATION LOGIC
 * Serverless chat system using public MQTT broker & tmpfiles.org api.
 */

// Retrieve or generate persistent Client ID and Avatar for the current session/tab to prevent duplicates on refresh/relog
const clientId = (() => {
  try {
    let id = sessionStorage.getItem('jc_client_id');
    if (!id) {
      id = 'jc_' + Math.random().toString(36).substring(2, 11);
      sessionStorage.setItem('jc_client_id', id);
    }
    return id;
  } catch (e) {
    return 'jc_' + Math.random().toString(36).substring(2, 11);
  }
})();

const avatars = ['🐱', '🐶', '🦊', '🦁', '🐸', '🐙', '🦄', '🐼', '🐨', '🦖', '🐝', '🐬', '🦥', '🦉', '🦩', '🦊'];
const myAvatar = (() => {
  try {
    let avatar = sessionStorage.getItem('jc_avatar');
    if (!avatar) {
      avatar = avatars[Math.floor(Math.random() * avatars.length)];
      sessionStorage.setItem('jc_avatar', avatar);
    }
    return avatar;
  } catch (e) {
    return avatars[Math.floor(Math.random() * avatars.length)];
  }
})();

// App State Variables
let currentRoom = null;
let client = null;
let currentTab = 'join'; // 'join' or 'create'
let isCodeVisible = false;
let activeUsers = new Map(); // id -> { avatar, lastSeen }
let presenceInterval = null;
let presenceCheckInterval = null;
let typingTimeout = null;
let isTyping = false;

// Audio Synthesizer (Web Audio API)
function playSynthesizedSound(type) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    const now = ctx.currentTime;
    
    if (type === 'connect') {
      // Ascending glass-like double chime
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.15); // G5
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
      gain.gain.linearRampToValueAtTime(0, now + 0.25);
      
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1046.50, now + 0.15); // C6
      gain2.gain.setValueAtTime(0, now + 0.15);
      gain2.gain.linearRampToValueAtTime(0.12, now + 0.2);
      gain2.gain.linearRampToValueAtTime(0, now + 0.4);
      
      osc.start(now);
      osc.stop(now + 0.25);
      osc2.start(now + 0.15);
      osc2.stop(now + 0.4);
    } else if (type === 'send') {
      // Swift frequency sweep up
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(500, now);
      osc.frequency.exponentialRampToValueAtTime(1100, now + 0.12);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === 'receive') {
      // Warm slide down (iOS drop sound)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(480, now);
      osc.frequency.exponentialRampToValueAtTime(320, now + 0.18);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      
      osc.start(now);
      osc.stop(now + 0.18);
    } else if (type === 'system') {
      // Light glass pop
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      
      osc.start(now);
      osc.stop(now + 0.1);
    }
  } catch (err) {
    console.warn('Web Audio synthesis failed or blocked by browser gesture policies:', err);
  }
}

// Switch between Join and Create Chat UI tabs
function switchTab(tab) {
  currentTab = tab;
  const tabJoin = document.getElementById('tab-join');
  const tabCreate = document.getElementById('tab-create');
  const inputLabel = document.getElementById('input-label');
  const inputTip = document.getElementById('input-tip');
  const submitBtn = document.getElementById('submit-btn');
  const roomInput = document.getElementById('room-code');
  
  // Clear any existing errors
  document.getElementById('lobby-error').style.display = 'none';

  if (tab === 'join') {
    tabJoin.classList.add('active');
    tabCreate.classList.remove('active');
    inputLabel.innerText = 'Masukkan Kode Chat untuk Bergabung';
    inputTip.innerText = 'Masukkan kode yang telah disepakati bersama teman Anda.';
    submitBtn.innerText = 'Gabung Chat';
    roomInput.placeholder = 'Contoh: rahasia123';
  } else {
    tabJoin.classList.remove('active');
    tabCreate.classList.add('active');
    inputLabel.innerText = 'Buat Kode Chat Baru';
    inputTip.innerText = 'Gunakan kode unik (contoh: kata/angka rumit) lalu bagikan ke teman Anda.';
    submitBtn.innerText = 'Buat & Masuk Chat';
    roomInput.placeholder = 'Contoh: x92-kunci-rahasia';
  }
}

// Password visibility toggler
function togglePasswordVisibility() {
  const roomInput = document.getElementById('room-code');
  const eyeIcon = document.getElementById('eye-icon');
  
  if (roomInput.type === 'password') {
    roomInput.type = 'text';
    eyeIcon.innerHTML = `
      <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
    `;
  } else {
    roomInput.type = 'password';
    eyeIcon.innerHTML = `
      <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    `;
  }
}

// Displayed room code masking/unmasking in chat room
function toggleDisplayCode() {
  const codeEl = document.getElementById('display-room-code');
  const eyeIcon = document.getElementById('eye-icon-chat');
  isCodeVisible = !isCodeVisible;
  
  if (isCodeVisible) {
    codeEl.innerText = currentRoom;
    codeEl.style.letterSpacing = 'normal';
    eyeIcon.innerHTML = `
      <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
    `;
  } else {
    codeEl.innerText = '••••••';
    codeEl.style.letterSpacing = '1px';
    eyeIcon.innerHTML = `
      <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    `;
  }
}

// Show validation or connection errors in Lobby Toast
function showLobbyError(msg) {
  const errorBox = document.getElementById('lobby-error');
  const errorText = document.getElementById('error-text');
  errorText.innerText = msg;
  errorBox.style.display = 'flex';
  
  // Re-enable submit button in case it was disabled
  document.getElementById('submit-btn').disabled = false;
  document.getElementById('submit-btn').innerText = currentTab === 'join' ? 'Gabung Chat' : 'Buat & Masuk Chat';
}

// Handle Lobby Form submission to connect and subscribe
function handleLobbySubmit(event) {
  event.preventDefault();
  
  const roomInput = document.getElementById('room-code').value.trim();
  if (!roomInput) {
    showLobbyError('Kode chat tidak boleh kosong.');
    return;
  }
  
  if (roomInput.length < 4) {
    showLobbyError('Kode chat minimal harus 4 karakter agar aman.');
    return;
  }
  
  // Disable button and show connecting state
  const submitBtn = document.getElementById('submit-btn');
  submitBtn.disabled = true;
  submitBtn.innerText = 'Menghubungkan...';
  
  currentRoom = roomInput;
  connectToMqttBroker();
}

// Connect to secure HiveMQ WebSockets public broker
function connectToMqttBroker() {
  const brokerUrl = 'wss://broker.hivemq.com:8884/mqtt';
  
  const options = {
    clientId: clientId,
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 4000
  };
  
  try {
    client = mqtt.connect(brokerUrl, options);
  } catch (err) {
    console.error(err);
    showLobbyError('Gagal melakukan inisialisasi jaringan MQTT.');
    return;
  }
  
  client.on('connect', () => {
    console.log('Connected to MQTT broker via WebSockets.');
    
    // Subscribe to Room Topics
    const baseTopic = `just_chat/rooms/${currentRoom}`;
    client.subscribe(`${baseTopic}/messages`, { qos: 1 });
    client.subscribe(`${baseTopic}/presence`, { qos: 0 });
    client.subscribe(`${baseTopic}/typing`, { qos: 0 });
    
    // Clear error
    document.getElementById('lobby-error').style.display = 'none';
    
    // Switch screens
    document.getElementById('lobby-screen').classList.remove('active');
    document.getElementById('chat-screen').classList.add('active');
    
    // Set static UI values
    updateUsersUI();
    document.getElementById('display-room-code').innerText = '••••••';
    isCodeVisible = false;
    
    // Play transition chime
    playSynthesizedSound('connect');
    
    // Start Decentralized Presence heartbeats
    startPresenceHeartbeat();
    
    // Send system join notice
    sendSystemJoinNotice();
  });
  
  client.on('message', (topic, payload) => {
    try {
      const data = JSON.parse(payload.toString());
      const baseTopic = `just_chat/rooms/${currentRoom}`;
      
      if (topic === `${baseTopic}/messages`) {
        handleIncomingMessage(data);
      } else if (topic === `${baseTopic}/presence`) {
        handleIncomingPresence(data);
      } else if (topic === `${baseTopic}/typing`) {
        handleIncomingTyping(data);
      }
    } catch (e) {
      console.warn("Non-JSON or corrupt payload received:", payload.toString());
    }
  });
  
  client.on('error', (err) => {
    console.error('MQTT Connection Error:', err);
    showLobbyError('Koneksi internet atau server terganggu. Silakan coba lagi.');
    leaveRoom();
  });
  
  client.on('offline', () => {
    document.getElementById('user-count').innerText = 'Jaringan terputus, mencoba menghubungkan kembali...';
  });
}

// Presence Management (Decentralized Network Heartbeat)
function startPresenceHeartbeat() {
  // Send first heartbeat immediately
  sendHeartbeat();
  
  // Send heartbeat every 5 seconds
  presenceInterval = setInterval(sendHeartbeat, 5000);
  
  // Check for expired users every 4 seconds
  presenceCheckInterval = setInterval(checkExpiredUsers, 4000);
}

function sendHeartbeat() {
  if (!client || !client.connected) return;
  
  const payload = {
    id: clientId,
    avatar: myAvatar,
    timestamp: Date.now()
  };
  
  client.publish(`just_chat/rooms/${currentRoom}/presence`, JSON.stringify(payload));
}

function handleIncomingPresence(data) {
  if (!data.id || data.id === clientId) return;
  
  if (data.action === 'leave') {
    activeUsers.delete(data.id);
    updateUsersUI();
    return;
  }
  
  // Register or update active user details
  activeUsers.set(data.id, {
    avatar: data.avatar || '👤',
    lastSeen: Date.now()
  });
  
  updateUsersUI();
}

function checkExpiredUsers() {
  const now = Date.now();
  let updated = false;
  
  for (const [id, user] of activeUsers.entries()) {
    // Evict users who missed heartbeats for over 12 seconds
    if (now - user.lastSeen > 12000) {
      activeUsers.delete(id);
      updated = true;
    }
  }
  
  if (updated) {
    updateUsersUI();
  }
}

// Update Room Presence HUD in the Header
function updateUsersUI() {
  const userCountEl = document.getElementById('user-count');
  const avatarsListEl = document.getElementById('users-avatars-list');
  
  // Include self in active total
  const count = activeUsers.size + 1;
  userCountEl.innerText = `${count} Pengguna Aktif`;
  
  // Render avatars in header
  avatarsListEl.innerHTML = '';
  
  // Add self avatar bubble
  const selfBubble = document.createElement('div');
  selfBubble.className = 'avatar-bubble';
  selfBubble.innerText = myAvatar;
  selfBubble.title = 'Anda (Anonim)';
  selfBubble.style.borderColor = '#a704fd';
  avatarsListEl.appendChild(selfBubble);
  
  // Add other peers avatar bubbles
  activeUsers.forEach((user, id) => {
    if (id === clientId) return; // skip redundant self
    const peerBubble = document.createElement('div');
    peerBubble.className = 'avatar-bubble';
    peerBubble.innerText = user.avatar;
    peerBubble.title = 'Teman Obrolan Anonim';
    avatarsListEl.appendChild(peerBubble);
  });
}

// Send local System announcement to room
function sendSystemJoinNotice() {
  // We publish a system notice in the room messages
  const payload = {
    senderId: 'system',
    type: 'system',
    text: `${myAvatar} bergabung ke obrolan.`,
    timestamp: Date.now()
  };
  client.publish(`just_chat/rooms/${currentRoom}/messages`, JSON.stringify(payload), { qos: 1 });
}

// Leave room: Cleanup client, intervals, switch UI screens
function leaveRoom() {
  // Clear heartbeat loops
  if (presenceInterval) clearInterval(presenceInterval);
  if (presenceCheckInterval) clearInterval(presenceCheckInterval);
  if (typingTimeout) clearTimeout(typingTimeout);
  
  // Send leave announcement and presence leave payload
  if (client && client.connected) {
    const presencePayload = {
      id: clientId,
      action: 'leave',
      timestamp: Date.now()
    };
    client.publish(`just_chat/rooms/${currentRoom}/presence`, JSON.stringify(presencePayload), { qos: 0 });

    const payload = {
      senderId: 'system',
      type: 'system',
      text: `${myAvatar} keluar dari obrolan.`,
      timestamp: Date.now()
    };
    client.publish(`just_chat/rooms/${currentRoom}/messages`, JSON.stringify(payload), { qos: 0 });
    
    client.end(false);
  }
  
  // Reset values
  client = null;
  currentRoom = null;
  activeUsers.clear();
  isTyping = false;
  
  // Update view elements
  document.getElementById('chat-messages').innerHTML = `
    <div class="system-message">
      <span class="system-tag">Selamat datang! Obrolan ini sepenuhnya rahasia, serverless, dan aman.</span>
    </div>
  `;
  document.getElementById('typing-indicator').style.display = 'none';
  document.getElementById('upload-progress-container').style.display = 'none';
  
  // Switch back to lobby
  document.getElementById('chat-screen').classList.remove('active');
  document.getElementById('lobby-screen').classList.add('active');
  
  // Enable submit button
  const submitBtn = document.getElementById('submit-btn');
  submitBtn.disabled = false;
  submitBtn.innerText = currentTab === 'join' ? 'Gabung Chat' : 'Buat & Masuk Chat';
}

// Send Text Messages
function sendMessage() {
  const inputEl = document.getElementById('chat-input');
  const text = inputEl.value.trim();
  
  if (!text || !client || !client.connected) return;
  
  const payload = {
    senderId: clientId,
    avatar: myAvatar,
    type: 'text',
    text: text,
    timestamp: Date.now()
  };
  
  client.publish(`just_chat/rooms/${currentRoom}/messages`, JSON.stringify(payload), { qos: 1 });
  
  // Clear inputs and typing indicators
  inputEl.value = '';
  sendTypingSignal(false);
}

// Listening to key press events in Chat Input
document.getElementById('chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    sendMessage();
  }
});

// Typing status tracker & indicators
function handleTyping() {
  if (!isTyping) {
    isTyping = true;
    sendTypingSignal(true);
  }
  
  if (typingTimeout) clearTimeout(typingTimeout);
  
  typingTimeout = setTimeout(() => {
    isTyping = false;
    sendTypingSignal(false);
  }, 2500);
}

function sendTypingSignal(typingState) {
  if (!client || !client.connected) return;
  
  const payload = {
    id: clientId,
    avatar: myAvatar,
    typing: typingState
  };
  
  client.publish(`just_chat/rooms/${currentRoom}/typing`, JSON.stringify(payload));
}

function handleIncomingTyping(data) {
  if (data.id === clientId) return; // ignore self
  
  const typingIndicator = document.getElementById('typing-indicator');
  const typingText = document.getElementById('typing-text');
  
  if (data.typing) {
    typingText.innerText = `${data.avatar || '👤'} sedang mengetik...`;
    typingIndicator.style.display = 'flex';
  } else {
    typingIndicator.style.display = 'none';
  }
}

// Receive Messages & File Downloads to Chat window
function handleIncomingMessage(msg) {
  const messagesBox = document.getElementById('chat-messages');
  const isScrollAtBottom = messagesBox.scrollHeight - messagesBox.clientHeight <= messagesBox.scrollTop + 50;
  
  // Check if system event message
  if (msg.type === 'system') {
    const sysEl = document.createElement('div');
    sysEl.className = 'system-message';
    sysEl.innerHTML = `<span class="system-tag">${msg.text}</span>`;
    messagesBox.appendChild(sysEl);
    playSynthesizedSound('system');
  } else {
    // Normal Message Bubble
    const isOutgoing = msg.senderId === clientId;
    const msgRow = document.createElement('div');
    msgRow.className = `message-row ${isOutgoing ? 'outgoing' : 'incoming'}`;
    
    // Timestamp formatter
    const timeStr = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let bubbleContent = '';
    
    if (msg.type === 'file') {
      if (msg.isMedia) {
        // Image or video tag preview
        bubbleContent = `
          <div class="message-bubble">
            <a href="${msg.fileUrl}" target="_blank" title="Klik untuk membuka file asli">
              <img src="${msg.fileUrl}" class="file-media-preview" alt="File lampiran" onerror="this.style.display='none';">
            </a>
            <div class="file-message-content" style="margin-top: 8px;">
              <div class="file-icon-box">🖼️</div>
              <div class="file-info">
                <span class="file-name">${msg.fileName}</span>
                <span class="file-meta">${formatBytes(msg.fileSize)}</span>
              </div>
              <a class="btn-download-file" href="${msg.fileUrl}" download="${msg.fileName}" target="_blank" title="Unduh File">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" width="16" height="16">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
              </a>
            </div>
          </div>
        `;
      } else {
        // Normal general documents format
        bubbleContent = `
          <div class="message-bubble">
            <div class="file-message-content">
              <div class="file-icon-box">📁</div>
              <div class="file-info">
                <span class="file-name">${msg.fileName}</span>
                <span class="file-meta">${formatBytes(msg.fileSize)}</span>
              </div>
              <a class="btn-download-file" href="${msg.fileUrl}" download="${msg.fileName}" target="_blank" title="Unduh File">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" width="16" height="16">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
              </a>
            </div>
          </div>
        `;
      }
    } else {
      // Normal simple text bubble
      bubbleContent = `<div class="message-bubble">${escapeHTML(msg.text)}</div>`;
    }
    
    msgRow.innerHTML = `
      <div class="message-card">
        ${bubbleContent}
        <span class="message-time">${msg.avatar || '👤'} &bull; ${timeStr}</span>
      </div>
    `;
    
    messagesBox.appendChild(msgRow);
    
    // Play localized chimes
    if (!isOutgoing) {
      playSynthesizedSound('receive');
    } else {
      playSynthesizedSound('send');
    }
  }
  
  // Smooth scroll to bottom if user is close to bottom
  if (isScrollAtBottom) {
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }
}

// File Dialog Triggers
function triggerFileSelect() {
  document.getElementById('file-input').click();
}

function handleFileSelected(event) {
  const files = event.target.files;
  if (files && files.length > 0) {
    uploadFileToCloud(files[0]);
  }
  // Clear value to allow re-selection
  event.target.value = '';
}

// Secure Serverless Upload Handler using tmpfiles.org public REST endpoint
function uploadFileToCloud(file) {
  // Cap at 100MB limit
  const maxBytes = 100 * 1024 * 1024;
  if (file.size > maxBytes) {
    alert("Batas maksimal ukuran file adalah 100 MB.");
    return;
  }
  
  const uploadContainer = document.getElementById('upload-progress-container');
  const filenameEl = document.getElementById('progress-filename');
  const percentEl = document.getElementById('progress-percent');
  const barEl = document.getElementById('progress-bar-fill');
  
  // Reset and Show progress UI card
  filenameEl.innerText = file.name;
  percentEl.innerText = '0%';
  barEl.style.width = '0%';
  uploadContainer.style.display = 'block';
  
  const formData = new FormData();
  formData.append('file', file);
  
  const xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://tmpfiles.org/api/v1/upload', true);
  
  // Monitor upload upload statistics
  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const percentComplete = Math.round((e.loaded / e.total) * 100);
      percentEl.innerText = `${percentComplete}%`;
      barEl.style.width = `${percentComplete}%`;
    }
  });
  
  xhr.onload = function() {
    uploadContainer.style.display = 'none';
    if (xhr.status === 200) {
      try {
        const res = JSON.parse(xhr.responseText);
        if (res.status === 'success' && res.data && res.data.url) {
          // Normal link returned: https://tmpfiles.org/12345/filename.ext
          // Map to download routing: https://tmpfiles.org/dl/12345/filename.ext
          const originalUrl = res.data.url;
          const directDlUrl = originalUrl.replace('https://tmpfiles.org/', 'https://tmpfiles.org/dl/');
          
          publishFileMessage(file.name, file.size, directDlUrl);
        } else {
          alert("Gagal mengupload file: Format respon salah.");
        }
      } catch (e) {
        alert("Gagal memproses respon dari server file.");
      }
    } else {
      alert("Gagal mengirim file ke cloud. Silakan coba lagi.");
    }
  };
  
  xhr.onerror = function() {
    uploadContainer.style.display = 'none';
    alert("Kesalahan koneksi saat mengupload file.");
  };
  
  xhr.send(formData);
}

// Publish direct link to MQTT
function publishFileMessage(name, size, url) {
  if (!client || !client.connected) return;
  
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  const ext = name.split('.').pop().toLowerCase();
  const isMedia = imageExtensions.includes(ext);
  
  const payload = {
    senderId: clientId,
    avatar: myAvatar,
    type: 'file',
    fileName: name,
    fileSize: size,
    fileUrl: url,
    isMedia: isMedia,
    timestamp: Date.now()
  };
  
  client.publish(`just_chat/rooms/${currentRoom}/messages`, JSON.stringify(payload), { qos: 1 });
}

// Drag & Drop event bindings
const chatScreen = document.getElementById('chat-screen');
const dropOverlay = document.getElementById('drop-overlay');

chatScreen.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dropOverlay.classList.add('active');
});

dropOverlay.addEventListener('dragover', (e) => {
  e.preventDefault();
});

dropOverlay.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('active');
});

dropOverlay.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('active');
  
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    uploadFileToCloud(files[0]);
  }
});

// Graceful cleanup on tab close or reload
window.addEventListener('beforeunload', () => {
  if (client && client.connected && currentRoom) {
    const presencePayload = {
      id: clientId,
      action: 'leave',
      timestamp: Date.now()
    };
    client.publish(`just_chat/rooms/${currentRoom}/presence`, JSON.stringify(presencePayload), { qos: 0 });

    const payload = {
      senderId: 'system',
      type: 'system',
      text: `${myAvatar} keluar dari obrolan.`,
      timestamp: Date.now()
    };
    client.publish(`just_chat/rooms/${currentRoom}/messages`, JSON.stringify(payload), { qos: 0 });
  }
});

// Helper: Escape tags/HTML from incoming input to prevent injection
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// Helper: Human-readable file sizes formats
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
