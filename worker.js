/**
 * LiftLog <-> Strava proxy
 *
 * Strava's oauth/token endpoint does not send CORS headers, so a purely
 * client-side (browser) app cannot call it directly. This tiny Cloudflare
 * Worker sits in between: it holds your Strava Client Secret (as a Worker
 * secret, never shipped to the browser) and forwards three calls:
 *
 *   POST /token     { code }            -> exchange OAuth code for tokens
 *   POST /refresh    { refresh_token }  -> refresh an expired access token
 *   POST /activity   { access_token, ... } -> create a Strava activity
 *
 * Deploy instructions are in SETUP.md.
 *
 * Required Worker secrets/vars (set in the Cloudflare dashboard):
 *   STRAVA_CLIENT_ID
 *   STRAVA_CLIENT_SECRET
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/token") {
        return await handleTokenExchange(request, env);
      }
      if (request.method === "POST" && url.pathname === "/refresh") {
        return await handleRefresh(request, env);
      }
      if (request.method === "POST" && url.pathname === "/activity") {
        return await handleCreateActivity(request, env);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }
};

async function handleTokenExchange(request, env) {
  const { code } = await request.json();
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code"
    })
  });
  const data = await res.json();
  if (!res.ok) return json(data, res.status);
  return json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete: data.athlete
  });
}

async function handleRefresh(request, env) {
  const { refresh_token } = await request.json();
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token,
      grant_type: "refresh_token"
    })
  });
  const data = await res.json();
  if (!res.ok) return json(data, res.status);
  return json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at
  });
}

async function handleCreateActivity(request, env) {
  const body = await request.json();
  const { access_token, ...activity } = body;
  const res = await fetch("https://www.strava.com/api/v3/activities", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${access_token}`
    },
    body: JSON.stringify(activity)
  });
  const data = await res.json();
  if (!res.ok) return json(data, res.status);
  return json(data);
}
