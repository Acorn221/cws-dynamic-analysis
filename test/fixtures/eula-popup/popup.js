// Popup script — sets eulaAccepted in storage when button clicked
document.getElementById('accept-btn').addEventListener('click', async () => {
  await chrome.storage.local.set({ eulaAccepted: true });
  document.getElementById('status').textContent = 'Accepted! Tracking enabled.';
  document.getElementById('accept-btn').disabled = true;
});

// Show current state
chrome.storage.local.get('eulaAccepted', (result) => {
  if (result.eulaAccepted) {
    document.getElementById('status').textContent = 'Already accepted.';
    document.getElementById('accept-btn').disabled = true;
  }
});
