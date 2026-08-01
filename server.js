// ============================================================
// QuickPi backend — Pi authentication verification
//
// This is a minimal, standalone Express server with exactly one job:
// take an accessToken from the frontend, call GET
// https://api.minepi.com/v2/me with it, and only report a session as
// valid if that call succeeds. No Pi Network API key is required for
// this flow — /v2/me is verified using the user's own access token.
//
// Deploy this separately from the static QuickPi frontend (GitHub
// Pages can't run a Node server). Render, Railway, Fly.io, or a
// Vercel/Netlify serverless function all work — see the deployment
// notes at the bottom of this file.
// ============================================================

const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());

// Lock this down to your actual frontend origin before going live,
// e.g. cors({ origin: 'https://kavindrarajput.github.io' })
app.use(cors());

const PI_ME_ENDPOINT = 'https://api.minepi.com/v2/me';

app.post('/api/pi-auth', async (req, res) => {
  const { accessToken } = req.body || {};

  if (!accessToken || typeof accessToken !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing accessToken.' });
  }

  let piResponse;
  try {
    piResponse = await fetch(PI_ME_ENDPOINT, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  } catch (err) {
    console.error('Network error calling Pi /v2/me:', err);
    return res.status(502).json({ ok: false, error: 'Could not reach Pi servers.' });
  }

  if (piResponse.status === 401) {
    return res.status(401).json({ ok: false, error: 'Pi access token is invalid or expired.' });
  }

  if (!piResponse.ok) {
    console.error('Unexpected /v2/me status:', piResponse.status);
    return res.status(502).json({ ok: false, error: 'Pi servers returned an unexpected response.' });
  }

  const userDTO = await piResponse.json();
  // Expected shape (per Pi platform docs): { uid, username, credentials: { scopes, ... } }

  if (!userDTO || !userDTO.uid) {
    return res.status(502).json({ ok: false, error: 'Pi servers returned an incomplete profile.' });
  }

  // ---- Session establishment ----
  // This is the one place a real session should be created (signed
  // cookie, JWT, server-side session store, etc.) — deliberately left
  // as a TODO since it depends on your session strategy. The
  // important security property is already satisfied above: the
  // session is only established AFTER /v2/me confirms the token is
  // real, never based on what the client merely claims.
  //
  // Example with a signed cookie (requires cookie-parser + a secret):
  //   res.cookie('quickpi_session', signSession(userDTO), { httpOnly: true, secure: true });

  return res.json({
    ok: true,
    user: {
      uid: userDTO.uid,
      username: userDTO.username
    }
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`QuickPi auth backend listening on port ${PORT}`);
});

// ============================================================
// Deployment notes
// ============================================================
// 1. This needs Node 18+ (for global fetch) or add node-fetch as a
//    dependency and require it above if targeting an older runtime.
// 2. package.json dependencies needed: express, cors
// 3. Deploy to any Node host (Render/Railway/Fly.io free tiers all
//    work for this). GitHub Pages CANNOT run this — it only serves
//    static files.
// 4. Once deployed, copy the live URL + "/api/pi-auth" into
//    AUTH_BACKEND_URL near the top of app.js on the frontend.
// 5. Update the cors() origin above to your actual GitHub Pages URL
//    once that's finalized, instead of allowing all origins.
// ============================================================
