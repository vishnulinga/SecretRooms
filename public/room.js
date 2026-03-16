const socket = io();
const roomId = window.location.pathname.split('/').pop();

const roomTitle = document.getElementById('roomTitle');
const roomTypeBadge = document.getElementById('roomTypeBadge');
const presenceBadge = document.getElementById('presenceBadge');
const expiryBadge = document.getElementById('expiryBadge');
const messagesEl = document.getElementById('messages');
const peopleListEl = document.getElementById('peopleList');
const peopleListMobileEl = document.getElementById('peopleListMobile');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const imageInput = document.getElementById('imageInput');
const uploadStatus = document.getElementById('uploadStatus');
const selectedImageWrap = document.getElementById('selectedImageWrap');
const selectedImageName = document.getElementById('selectedImageName');
const clearImageBtn = document.getElementById('clearImageBtn');
const typingBar = document.getElementById('typingBar');

const copyRoomBtn = document.getElementById('copyRoomBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const killRoomBtn = document.getElementById('killRoomBtn');
const copyRoomBtnMobile = document.getElementById('copyRoomBtnMobile');
const leaveRoomBtnMobile = document.getElementById('leaveRoomBtnMobile');
const killRoomBtnMobile = document.getElementById('killRoomBtnMobile');
const openPeopleBtn = document.getElementById('openPeopleBtn');
const closePeopleBtn = document.getElementById('closePeopleBtn');
const peopleDrawer = document.getElementById('peopleDrawer');
const drawerBackdrop = document.getElementById('drawerBackdrop');


let selfUser = null;
let currentRoomType = 'private';
let expiresAt = null;
let countdownTimer = null;
let typingActive = false;
let selectedFile = null;
let uploadingImage = false;
let lastRenderedMessageSignature = '';
let lastRenderedUsersSignature = '';
let lastTypingSignature = '';

roomTitle.textContent = `Room ${roomId}`;
socket.emit('room:join', { roomId });

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (!expiresAt) return;
    expiryBadge.textContent = `Expires in ${formatRemaining(expiresAt - Date.now())}`;
  }, 1000);
}

function updatePresence(participants) {
  presenceBadge.textContent = participants === 1 ? '1 person' : `${participants} people`;
}

function getUsersSignature(users) {
  return (users || [])
    .map((user) => `${user.id}:${user.name}:${user.color}:${user.isAdmin ? 1 : 0}`)
    .join('|');
}

function renderPeople(users) {
  const signature = getUsersSignature(users);
  if (signature === lastRenderedUsersSignature) return;
  lastRenderedUsersSignature = signature;

  const html = users
    .map((user) => {
      const isSelf = selfUser && user.id === selfUser.id;
      const adminBadge = user.isAdmin ? '<span class="admin-pill">Admin</span>' : '';
      const youBadge = isSelf ? '<span class="you-pill">You</span>' : '';
      return `
        <div class="person-row">
          <span class="person-dot" style="background:${escapeHtml(user.color)}"></span>
          <span class="person-name">${escapeHtml(user.name)}</span>
          ${adminBadge}
          ${youBadge}
        </div>
      `;
    })
    .join('');

  peopleListEl.innerHTML = html;
  if (peopleListMobileEl) peopleListMobileEl.innerHTML = html;
}

function getTypingSignature(typingUsers) {
  return (typingUsers || [])
    .map((user) => `${user.id}:${user.name}`)
    .sort()
    .join('|');
}

function renderTyping(typingUsers) {
  const signature = getTypingSignature(typingUsers);
  if (signature === lastTypingSignature) return;
  lastTypingSignature = signature;

  const others = typingUsers.filter((user) => !selfUser || user.id !== selfUser.id);
  if (!others.length) {
    typingBar.classList.add('hidden');
    typingBar.textContent = '';
    return;
  }

  const names = others.map((user) => user.name);
  let label = '';
  if (names.length === 1) label = `${names[0]} is typing...`;
  else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing...`;
  else label = `${names[0]} and ${names.length - 1} others are typing...`;

  typingBar.textContent = label;
  typingBar.classList.remove('hidden');
}

function renderMessageBody(message) {
  const textBlock = message.text
    ? `<div class="message-text ${message.kind === 'image' ? 'message-text-with-image' : ''}">${escapeHtml(message.text)}</div>`
    : '';

  const imageBlock = message.image
    ? `
      <div class="message-image-wrap">
        <a href="${escapeHtml(message.image.url)}" target="_blank" rel="noreferrer">
          <img
            class="message-image"
            src="${escapeHtml(message.image.url)}"
            alt="Shared image by ${escapeHtml(message.senderName)}"
            loading="lazy"
          />
        </a>
        <div class="message-image-meta">Compressed image · ${escapeHtml(formatBytes(message.image.sizeBytes))}</div>
      </div>
    `
    : '';

  return `${imageBlock}${textBlock}`;
}

function getMessagesSignature(messages) {
  return (messages || [])
    .map((message) => {
      const imagePart = message.image ? `${message.image.url}:${message.image.sizeBytes}` : '';
      return `${message.id}:${message.kind}:${message.text || ''}:${imagePart}`;
    })
    .join('|');
}

function renderMessages(messages) {
  const signature = getMessagesSignature(messages);
  if (signature === lastRenderedMessageSignature) return;
  lastRenderedMessageSignature = signature;

  const wasNearBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;

  if (!messages.length) {
    messagesEl.innerHTML = `<div class="empty-state">No messages yet. Send the first one.</div>`;
    return;
  }

  messagesEl.innerHTML = messages
    .map((message) => {
      const isSelf = selfUser && message.senderId === selfUser.id;
      const deleteButton = isSelf
        ? `<button class="delete-msg-btn" data-message-id="${escapeHtml(message.id)}">Delete</button>`
        : '';

      return `
        <article class="message ${isSelf ? 'message-self' : ''}">
          <div class="message-meta">
            <span class="person-dot" style="background:${escapeHtml(message.senderColor)}"></span>
            <span class="message-name">${escapeHtml(message.senderName)}</span>
            <span class="message-time">${escapeHtml(formatTime(message.createdAt))}</span>
            ${message.kind === 'image' ? '<span class="message-kind-pill">Image</span>' : ''}
            ${deleteButton}
          </div>
          <div class="message-bubble">${renderMessageBody(message)}</div>
        </article>
      `;
    })
    .join('');

  if (wasNearBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function updateControls() {
  roomTypeBadge.textContent = currentRoomType === 'admin' ? 'Admin room' : 'Private room';
  const canKill = currentRoomType === 'private' || (selfUser && selfUser.isAdmin);
  killRoomBtn.classList.toggle('hidden', !canKill);
  killRoomBtnMobile.classList.toggle('hidden', !canKill);

  const isBusy = uploadingImage;
  messageInput.disabled = isBusy;
  imageInput.disabled = isBusy;
}

function setUploadStatus(message, mode = 'info') {
  if (!message) {
    uploadStatus.textContent = '';
    uploadStatus.className = 'upload-status hidden';
    return;
  }

  uploadStatus.textContent = message;
  uploadStatus.className = `upload-status ${mode}`;
}

function refreshSelectedImageUI() {
  if (!selectedFile) {
    selectedImageWrap.classList.add('hidden');
    selectedImageName.textContent = '';
    return;
  }

  selectedImageWrap.classList.remove('hidden');
  selectedImageName.textContent = `${selectedFile.name} · ${formatBytes(selectedFile.size)}`;
}

async function uploadImage(file) {
  const formData = new FormData();
  formData.append('image', file);

  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/upload-image`, {
    method: 'POST',
    body: formData,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Image upload failed.');
  return payload;
}

function openDrawer() {
  peopleDrawer.classList.remove('hidden');
  document.body.classList.add('drawer-open');
}

function closeDrawer() {
  peopleDrawer.classList.add('hidden');
  document.body.classList.remove('drawer-open');
}

async function copyRoomLink() {
  const buttons = [copyRoomBtn, copyRoomBtnMobile].filter(Boolean);

  try {
    if (navigator.share && window.innerWidth < 900) {
      await navigator.share({
        title: 'LiveNote room',
        text: 'Join my LiveNote room',
        url: window.location.href,
      });
      return;
    }

    await navigator.clipboard.writeText(window.location.href);
    buttons.forEach((btn) => { btn.textContent = 'Copied'; });
    setTimeout(() => {
      buttons.forEach((btn) => { btn.textContent = 'Copy Link'; });
    }, 1200);
  } catch (error) {
    try {
      await navigator.clipboard.writeText(window.location.href);
      buttons.forEach((btn) => { btn.textContent = 'Copied'; });
      setTimeout(() => {
        buttons.forEach((btn) => { btn.textContent = 'Copy Link'; });
      }, 1200);
    } catch (_error) {
      window.prompt('Copy this room link:', window.location.href);
    }
  }
}

socket.on('connect_error', (error) => {
  alert(error?.message || 'Unable to connect right now.');
});

socket.on('room:joined', ({ self, roomType, expiresAt: incomingExpiry }) => {
  selfUser = self;
  currentRoomType = roomType;
  expiresAt = incomingExpiry;
  updateControls();
  startCountdown();
  messageInput.focus();
});

socket.on('room:state', ({ participants, messages, users, roomType, typing, expiresAt: incomingExpiry }) => {
  currentRoomType = roomType;
  expiresAt = incomingExpiry;

  if (selfUser) {
    const refreshedSelf = (users || []).find((user) => user.id === selfUser.id);
    if (refreshedSelf) selfUser = { ...selfUser, ...refreshedSelf };
  }

  updateControls();
  updatePresence(participants);
  renderPeople(users || []);
  renderMessages(messages || []);
  renderTyping(typing || []);
  expiryBadge.textContent = `Expires in ${formatRemaining(expiresAt - Date.now())}`;
});

socket.on('room:not-found', () => {
  alert('This room no longer exists. Create a new one.');
  window.location.href = '/';
});

socket.on('room:error', ({ message }) => {
  alert(message || 'Something went wrong in this room.');
});

socket.on('room:left', () => {
  window.location.href = '/';
});

socket.on('room:killed', ({ reason }) => {
  let text = 'This room was deleted.';
  if (reason === 'expired') text = 'This room expired and was deleted.';
  if (reason === 'unused') text = 'This room was never used and was deleted.';
  if (reason === 'empty') text = 'This room closed because everyone left.';
  alert(text);
  window.location.href = '/';
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text && !selectedFile) return;

  try {
    if (selectedFile) {
      uploadingImage = true;
      updateControls();
      setUploadStatus('Compressing and uploading image...', 'info');

      const uploaded = await uploadImage(selectedFile);
      socket.emit('room:send-image', { roomId, assetId: uploaded.assetId, text });

      setUploadStatus(
        `Image sent. Stored temporarily as compressed WebP (${formatBytes(uploaded.sizeBytes)}).`,
        'success'
      );

      setTimeout(() => {
        if (uploadStatus.textContent.includes('Image sent')) setUploadStatus('');
      }, 2200);
    } else {
      socket.emit('room:send-message', { roomId, text });
    }

    socket.emit('room:typing', { roomId, isTyping: false });
    typingActive = false;
    messageInput.value = '';
    imageInput.value = '';
    selectedFile = null;
    refreshSelectedImageUI();
    messageInput.focus();
  } catch (error) {
    setUploadStatus(error.message || 'Image upload failed.', 'error');
  } finally {
    uploadingImage = false;
    updateControls();
  }
});

messageInput.addEventListener('input', () => {
  const shouldType = messageInput.value.trim().length > 0;

  if (shouldType && !typingActive) {
    typingActive = true;
    socket.emit('room:typing', { roomId, isTyping: true });
    return;
  }

  if (!shouldType && typingActive) {
    typingActive = false;
    socket.emit('room:typing', { roomId, isTyping: false });
    return;
  }

  if (shouldType) socket.emit('room:typing', { roomId, isTyping: true });
});

imageInput.addEventListener('change', () => {
  const [file] = imageInput.files || [];
  selectedFile = file || null;
  refreshSelectedImageUI();
  setUploadStatus('');
});

clearImageBtn.addEventListener('click', () => {
  selectedFile = null;
  imageInput.value = '';
  refreshSelectedImageUI();
  setUploadStatus('');
});

messagesEl.addEventListener('click', (event) => {
  const button = event.target.closest('.delete-msg-btn');
  if (!button) return;

  const messageId = button.getAttribute('data-message-id');
  if (!messageId) return;

  socket.emit('message:delete', { roomId, messageId });
});

copyRoomBtn?.addEventListener('click', copyRoomLink);
copyRoomBtnMobile?.addEventListener('click', copyRoomLink);

leaveRoomBtn?.addEventListener('click', () => {
  const confirmed = window.confirm('Leave this room on this device?');
  if (!confirmed) return;
  socket.emit('room:leave', { roomId });
});

leaveRoomBtnMobile?.addEventListener('click', () => leaveRoomBtn?.click());

killRoomBtn?.addEventListener('click', () => {
  const confirmed = window.confirm('Delete this room for everyone? This cannot be undone.');
  if (!confirmed) return;
  socket.emit('room:kill', { roomId });
});

killRoomBtnMobile?.addEventListener('click', () => killRoomBtn?.click());
openPeopleBtn?.addEventListener('click', openDrawer);
closePeopleBtn?.addEventListener('click', closeDrawer);
drawerBackdrop?.addEventListener('click', closeDrawer);

window.addEventListener('beforeunload', () => {
  if (typingActive) socket.emit('room:typing', { roomId, isTyping: false });
});
