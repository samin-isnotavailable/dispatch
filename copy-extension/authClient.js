import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Sign in failed");

  await chrome.storage.local.set({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user_id: data.user.id,
    user_email: data.user.email,
  });
  return data;
}

export async function signOut() {
  await chrome.storage.local.remove(["access_token", "refresh_token", "user_id", "user_email"]);
}

export async function getSession() {
  const { access_token, refresh_token, user_id, user_email } = await chrome.storage.local.get([
    "access_token",
    "refresh_token",
    "user_id",
    "user_email",
  ]);
  if (!access_token) return null;
  return { access_token, refresh_token, user_id, user_email };
}

async function refreshSession(refresh_token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Session expired — sign in again");
  await chrome.storage.local.set({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  });
  return data.access_token;
}

// Wraps fetch to the Supabase REST endpoint, auto-refreshing the token
// once on a 401 before giving up.
export async function authedFetch(path, options = {}) {
  let session = await getSession();
  if (!session) throw new Error("Not signed in");

  const doFetch = (token) =>
    fetch(`${SUPABASE_URL}${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

  let res = await doFetch(session.access_token);
  if (res.status === 401 && session.refresh_token) {
    const newToken = await refreshSession(session.refresh_token);
    res = await doFetch(newToken);
  }
  return res;
}
