const createPrivateRoomBtn = document.getElementById('createPrivateRoomBtn');
const createAdminRoomBtn = document.getElementById('createAdminRoomBtn');

async function createAndOpenRoom(roomType, button) {
  const original = button.innerHTML;
  createPrivateRoomBtn.disabled = true;
  createAdminRoomBtn.disabled = true;

  button.innerHTML =
    `<span class="quick-create-title">Creating...</span>` +
    `<span class="quick-create-desc">Opening your ${roomType} room</span>`;

  try {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomType }),
    });

    const data = await response.json();

    if (!response.ok || !data.roomId) {
      throw new Error(data.error || 'Could not create room');
    }

    window.location.href = `/${encodeURIComponent(data.roomId)}`;
  } catch (error) {
    alert(error.message || 'Could not create room. Please try again.');
    createPrivateRoomBtn.disabled = false;
    createAdminRoomBtn.disabled = false;
    button.innerHTML = original;
  }
}

createPrivateRoomBtn?.addEventListener('click', () =>
  createAndOpenRoom('private', createPrivateRoomBtn)
);

createAdminRoomBtn?.addEventListener('click', () =>
  createAndOpenRoom('admin', createAdminRoomBtn)
);