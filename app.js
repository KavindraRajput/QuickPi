// ============================================================
// QuickPi
// A QR-based helper for Pi Network addresses.
//
// IMPORTANT — what this app does and does not do:
//  - It stores the user's own Pi wallet address locally on this device.
//  - It generates a QR code encoding that address (and, optionally,
//    a requested amount) so someone else can scan it instead of
//    retyping a long address.
//  - It reads a QR code with a camera and extracts an address/amount.
//  - It NEVER moves, holds, or has access to anyone's Pi. The actual
//    transfer is always completed inside the official Pi Wallet app,
//    which the user opens after QuickPi hands off the address.
// This keeps QuickPi inside what a third-party Pi Browser app is
// permitted to do: Pi's SDK only supports payments between a user
// and the app itself (U2A/A2U), not direct third-party-mediated
// user-to-user transfers, so QuickPi does not attempt that at all.
// ============================================================

(function () {
  'use strict';

  // Fail loudly instead of silently if the bundled libraries didn't load —
  // this is exactly the kind of issue that otherwise looks like "camera
  // opens but nothing happens" with no clue why.
  if (typeof QRCode === 'undefined' || typeof jsQR === 'undefined') {
    document.body.innerHTML =
      '<div style="padding:40px 24px;color:#F3F0EA;font-family:sans-serif;text-align:center;">' +
      '<h2>QuickPi couldn\u2019t load a required file</h2>' +
      '<p style="color:#B9B3C9;">qrcode.min.js or jsQR.js failed to load. ' +
      'Make sure both files were uploaded to the same folder as index.html, ' +
      'then reload the page.</p></div>';
    return;
  }

  const STORAGE_KEY = 'quickpi_address_v1';

  // ---------- element refs ----------
  const screenOnboard   = document.getElementById('screen-onboard');
  const screenMain      = document.getElementById('screen-main');
  const inputAddress    = document.getElementById('input-address');
  const btnSaveAddress  = document.getElementById('btn-save-address');

  const topbarAddress   = document.getElementById('topbar-address');
  const btnEditAddress  = document.getElementById('btn-edit-address');

  const tabReceive      = document.getElementById('tab-receive');
  const tabSend         = document.getElementById('tab-send');
  const panelReceive    = document.getElementById('panel-receive');
  const panelSend       = document.getElementById('panel-send');

  const qrCanvas         = document.getElementById('qr-canvas');
  const toggleAmount     = document.getElementById('toggle-amount');
  const amountInputWrap  = document.getElementById('amount-input-wrap');
  const inputAmount      = document.getElementById('input-amount');
  const receiveNote      = document.getElementById('receive-note');

  const scanFrame        = document.getElementById('scan-frame');
  const scanVideo        = document.getElementById('scan-video');
  const scanCanvas       = document.getElementById('scan-canvas');
  const scanIdle         = document.getElementById('scan-idle');
  const scanLine         = document.getElementById('scan-line');
  const btnToggleCamera  = document.getElementById('btn-toggle-camera');

  const inputRecipient   = document.getElementById('input-recipient');
  const inputSendAmount  = document.getElementById('input-send-amount');
  const btnHandoff       = document.getElementById('btn-handoff');

  const sheetBackdrop    = document.getElementById('sheet-backdrop');
  const sheetRecipient   = document.getElementById('sheet-recipient');
  const sheetAmount      = document.getElementById('sheet-amount');
  const btnConfirmHandoff = document.getElementById('btn-confirm-handoff');
  const btnCancelHandoff  = document.getElementById('btn-cancel-handoff');

  const toast = document.getElementById('toast');

  const piAuthRow    = document.getElementById('pi-auth-row');
  const piAuthStatus = document.getElementById('pi-auth-status');
  const btnPiSignin  = document.getElementById('btn-pi-signin');

  let qrObj = null;
  let cameraStream = null;
  let scanRafId = null;
  let isCameraOn = false;

  // ---------- storage ----------
  function loadAddress() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; }
    catch (e) { return ''; }
  }
  function saveAddress(addr) {
    try { localStorage.setItem(STORAGE_KEY, addr); }
    catch (e) { /* storage unavailable — session-only fallback */ window.__quickpiAddr = addr; }
  }
  function getAddress() {
    try { return localStorage.getItem(STORAGE_KEY) || window.__quickpiAddr || ''; }
    catch (e) { return window.__quickpiAddr || ''; }
  }

  // ---------- toast ----------
  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 4200);
  }

  // ---------- address validation (light touch, not a full Stellar checksum) ----------
  function looksLikeAddress(val) {
    const v = val.trim();
    if (!v) return false;
    // Stellar/Pi public keys start with G and are 56 chars, base32-ish.
    // Pi usernames are also accepted as a fallback (alphanumeric, 3+ chars).
    const isGAddress = /^G[A-Z2-7]{55}$/.test(v);
    const isHandle = /^[a-zA-Z0-9_]{3,}$/.test(v);
    return isGAddress || isHandle;
  }

  function truncateAddress(addr) {
    if (addr.length <= 20) return addr;
    return addr.slice(0, 10) + '···' + addr.slice(-6);
  }

  // ---------- onboarding ----------
  function goToMain() {
    screenOnboard.classList.add('is-hidden');
    screenMain.classList.add('is-active');
    const addr = getAddress();
    topbarAddress.textContent = truncateAddress(addr);
    renderReceiveQR();
  }

  btnSaveAddress.addEventListener('click', () => {
    const val = inputAddress.value.trim();
    if (!looksLikeAddress(val)) {
      showToast('That doesn\u2019t look like a Pi address or username yet.');
      inputAddress.focus();
      return;
    }
    saveAddress(val);
    goToMain();
  });

  inputAddress.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSaveAddress.click();
  });

  btnEditAddress.addEventListener('click', () => {
    stopCamera();
    inputAddress.value = getAddress();
    screenMain.classList.remove('is-active');
    screenOnboard.classList.remove('is-hidden');
    setTimeout(() => inputAddress.focus(), 50);
  });

  // ---------- tabs ----------
  function activateTab(which) {
    stopCamera();
    if (which === 'receive') {
      tabReceive.classList.add('is-active');
      tabReceive.setAttribute('aria-selected', 'true');
      tabSend.classList.remove('is-active');
      tabSend.setAttribute('aria-selected', 'false');
      panelReceive.classList.remove('is-hidden');
      panelSend.classList.add('is-hidden');
      renderReceiveQR();
    } else {
      tabSend.classList.add('is-active');
      tabSend.setAttribute('aria-selected', 'true');
      tabReceive.classList.remove('is-active');
      tabReceive.setAttribute('aria-selected', 'false');
      panelSend.classList.remove('is-hidden');
      panelReceive.classList.add('is-hidden');
    }
  }
  tabReceive.addEventListener('click', () => activateTab('receive'));
  tabSend.addEventListener('click', () => activateTab('send'));

  // ---------- receive: QR generation ----------
  function buildPayload(address, amount) {
    // Simple, human-diffable payload. A dedicated Pi payment URI scheme
    // isn't publicly standardized, so QuickPi encodes a small JSON
    // object that QuickPi itself (and only itself) knows how to parse
    // back into an address + optional amount for the handoff sheet.
    const payload = { app: 'quickpi', addr: address };
    if (amount) payload.amt = amount;
    return JSON.stringify(payload);
  }

  function renderReceiveQR() {
    const addr = getAddress();
    if (!addr) return;
    const useAmount = toggleAmount.checked;
    const amt = useAmount ? (inputAmount.value || '').trim() : '';

    qrCanvas.innerHTML = '';
    const text = buildPayload(addr, amt);
    // eslint-disable-next-line no-new
    new QRCode(qrCanvas, {
      text: text,
      width: 216,
      height: 216,
      colorDark: '#14111F',
      colorLight: '#F3F0EA',
      correctLevel: QRCode.CorrectLevel.M
    });

    receiveNote.textContent = useAmount && amt
      ? `Requesting ${amt} π. Whoever scans this will see the amount pre-filled.`
      : 'Showing your address only. Anyone can scan and send any amount from Pi Wallet.';
  }

  toggleAmount.addEventListener('change', () => {
    amountInputWrap.classList.toggle('is-visible', toggleAmount.checked);
    if (toggleAmount.checked) {
      setTimeout(() => inputAmount.focus(), 50);
    }
    renderReceiveQR();
  });
  inputAmount.addEventListener('input', renderReceiveQR);

  // ---------- send: camera scanning ----------
  async function startCamera() {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
    } catch (e) {
      showToast('Camera access denied or unavailable. Enter the address manually below.');
      return;
    }
    scanVideo.srcObject = cameraStream;
    scanVideo.style.display = 'block';
    scanIdle.style.display = 'none';
    scanLine.classList.add('is-scanning');
    await scanVideo.play();
    isCameraOn = true;
    btnToggleCamera.textContent = 'Stop camera';
    btnToggleCamera.classList.add('is-active');
    scanTick();
  }

  function stopCamera() {
    if (scanRafId) cancelAnimationFrame(scanRafId);
    scanRafId = null;
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    scanVideo.style.display = 'none';
    scanIdle.style.display = 'flex';
    scanLine.classList.remove('is-scanning');
    isCameraOn = false;
    scanCtx = null;
    btnToggleCamera.textContent = 'Start camera';
    btnToggleCamera.classList.remove('is-active');
  }

  let scanCtx = null;

  function scanTick() {
    if (!isCameraOn) return;
    if (!scanCtx) {
      scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (scanVideo.readyState === scanVideo.HAVE_ENOUGH_DATA && scanVideo.videoWidth > 0) {
      scanCanvas.width = scanVideo.videoWidth;
      scanCanvas.height = scanVideo.videoHeight;
      scanCtx.drawImage(scanVideo, 0, 0, scanCanvas.width, scanCanvas.height);
      const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth'
      });
      if (code && code.data) {
        handleScannedText(code.data);
        return; // stop the loop; handleScannedText decides what's next
      }
    }
    scanRafId = requestAnimationFrame(scanTick);
  }

  function handleScannedText(text) {
    let addr = '';
    let amt = '';
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.addr) {
        addr = String(parsed.addr);
        amt = parsed.amt ? String(parsed.amt) : '';
      }
    } catch (e) {
      // Not a QuickPi payload — fall back to treating the raw text
      // as an address if it looks like one.
      if (looksLikeAddress(text)) addr = text.trim();
    }

    if (!addr) {
      showToast('That QR doesn\u2019t contain a recognizable Pi address.');
      scanRafId = requestAnimationFrame(scanTick);
      return;
    }

    stopCamera();
    inputRecipient.value = addr;
    if (amt) inputSendAmount.value = amt;
    updateHandoffButton();
    showToast('Address captured from QR.');
  }

  btnToggleCamera.addEventListener('click', () => {
    if (isCameraOn) stopCamera();
    else startCamera();
  });

  // ---------- send: manual entry + handoff ----------
  function updateHandoffButton() {
    const ok = looksLikeAddress(inputRecipient.value);
    btnHandoff.disabled = !ok;
  }
  inputRecipient.addEventListener('input', updateHandoffButton);

  btnHandoff.addEventListener('click', () => {
    const addr = inputRecipient.value.trim();
    if (!looksLikeAddress(addr)) return;
    const amt = inputSendAmount.value.trim();

    sheetRecipient.textContent = addr;
    sheetAmount.textContent = amt ? `${amt} π` : 'Not specified — set it in Pi Wallet';
    sheetBackdrop.classList.add('is-visible');
  });

  btnCancelHandoff.addEventListener('click', () => {
    sheetBackdrop.classList.remove('is-visible');
  });
  sheetBackdrop.addEventListener('click', (e) => {
    if (e.target === sheetBackdrop) sheetBackdrop.classList.remove('is-visible');
  });

  btnConfirmHandoff.addEventListener('click', async () => {
    const addr = inputRecipient.value.trim();
    let copied = false;
    try {
      await navigator.clipboard.writeText(addr);
      copied = true;
    } catch (e) {
      // Clipboard API may be unavailable in some Pi Browser contexts —
      // the address stays visible on the sheet for manual copy instead.
    }
    sheetBackdrop.classList.remove('is-visible');
    // Pi Wallet lives inside Pi Browser itself (it's a built-in tab, not
    // a separately installed app), so there's no reliable link to launch
    // it from here. QuickPi's job ends at handing off the address —
    // the user switches to the Pi Wallet tab and pastes it in there.
    showToast(copied
      ? 'Address copied — switch to the Pi Wallet tab and paste it in Send.'
      : `Copy failed — address is: ${addr}`);
  });

  // ============================================================
  // Pi Network authentication
  //
  // Flow (per Pi SDK docs):
  //  1. Pi.init({ version: "2.0", sandbox: <bool> }) — must be awaited
  //     in full before any other Pi.* call, since it isn't guaranteed
  //     synchronous even though it doesn't always return a rejected
  //     promise on failure.
  //  2. Pi.authenticate(scopes, onIncompletePaymentFound) — returns
  //     { accessToken, user }. Only the "username" scope is requested
  //     here; QuickPi doesn't need payment history or wallet scopes
  //     for this feature.
  //  3. The accessToken is sent to QuickPi's own backend, which is the
  //     only party that calls GET https://api.minepi.com/v2/me with
  //     Authorization: Bearer <accessToken> — this must happen
  //     server-side so a tampered/forged token can't be used to
  //     establish a session just because the client claims it's valid.
  //  4. The backend's response (session established or rejected) is
  //     what QuickPi's UI actually trusts — not the raw SDK result.
  //
  // Set this to your deployed backend's URL before going live.
  // ============================================================
  const AUTH_BACKEND_URL = 'https://quickpi-backend.onrender.com/api/pi-auth';

  // Sandbox mode is for testing in the Pi Sandbox during development.
  // Set to false for a production/mainnet submission.
  const PI_SANDBOX = false;

  let piInitPromise = null;
  let piSession = null; // set once the backend confirms the token

  function setAuthStatus(text, signedIn) {
    piAuthStatus.textContent = text;
    piAuthStatus.classList.toggle('is-signed-in', !!signedIn);
  }

  function onIncompletePaymentFound(payment) {
    // QuickPi doesn't create payments itself, so there's nothing to
    // resume here — this is required by the SDK's authenticate() call.
    console.warn('Incomplete payment found (not handled by QuickPi):', payment);
  }

  // Step 1 — Pi.init() as an awaited promise. Only ever run once;
  // subsequent callers reuse the same in-flight/completed promise.
  function ensurePiInit() {
    if (piInitPromise) return piInitPromise;

    if (typeof window.Pi === 'undefined') {
      piInitPromise = Promise.reject(
        new Error('Pi SDK not available — open this app inside Pi Browser.')
      );
      return piInitPromise;
    }

    piInitPromise = Promise.resolve()
      .then(() => window.Pi.init({ version: '2.0', sandbox: PI_SANDBOX }))
      .then(() => true);

    return piInitPromise;
  }

  // Step 2 + 3 — authenticate, then hand the token to the backend.
  async function signInWithPi() {
    btnPiSignin.disabled = true;
    setAuthStatus('Connecting to Pi\u2026', false);

    try {
      await ensurePiInit(); // fully await init before touching authenticate()

      const scopes = ['username'];
      const authResult = await window.Pi.authenticate(scopes, onIncompletePaymentFound);

      if (!authResult || !authResult.accessToken) {
        throw new Error('No access token returned by Pi.authenticate().');
      }

      setAuthStatus('Verifying with server\u2026', false);
      const verified = await verifyAccessTokenWithBackend(authResult.accessToken);

      if (!verified || !verified.ok) {
        throw new Error((verified && verified.error) || 'Server could not verify this session.');
      }

      piSession = verified.user;
      const displayName = (verified.user && verified.user.username) || 'Pioneer';
      setAuthStatus(`Signed in as @${displayName}`, true);
      btnPiSignin.textContent = 'Signed in';
      btnPiSignin.disabled = true;
    } catch (err) {
      console.error('Pi sign-in failed:', err);
      setAuthStatus('Not signed in to Pi', false);
      btnPiSignin.disabled = false;
      showToast(err && err.message ? err.message : 'Pi sign-in failed. Try again.');
    }
  }

  // Step 3 (continued) — the actual GET /v2/me call happens on the
  // backend, never in this client code, so a forged token can't be
  // used to self-approve a session. This just relays the token there.
  async function verifyAccessTokenWithBackend(accessToken) {
    const res = await fetch(AUTH_BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken })
    });

    if (!res.ok) {
      let message = `Backend rejected the session (HTTP ${res.status}).`;
      try {
        const body = await res.json();
        if (body && body.error) message = body.error;
      } catch (e) { /* non-JSON error body — keep the generic message */ }
      return { ok: false, error: message };
    }

    return res.json(); // expected shape: { ok: true, user: { username, uid, ... } }
  }

  btnPiSignin.addEventListener('click', () => {
    if (piSession) return; // already signed in
    signInWithPi();
  });

  // ---------- init ----------
  (function init() {
    const existing = getAddress();
    if (existing) {
      goToMain();
    }
    // Auto-trigger sign-in on load. If this fails (e.g. not running
    // inside Pi Browser), signInWithPi() surfaces that via the status
    // row and toast rather than blocking the rest of the app —
    // QuickPi's core QR features still work without a Pi session.
    signInWithPi();
  })();

})();
