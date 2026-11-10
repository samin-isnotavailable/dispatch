// Shared check for the /api/admin-* endpoints: the caller must be signed in
// and be the owner (profiles.is_owner, see 0011_owner_role.sql). Files
// starting with "_" aren't published as endpoints by Vercel.
//
// Returns { adminClient, user } when allowed. Otherwise it has already sent
// the error response and returns null.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

export async function requireOwner(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return null;
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
    res.status(500).json({
      error: "Server is missing Supabase configuration. Set SUPABASE_SERVICE_ROLE_KEY in the Vercel project's environment variables.",
    });
    return null;
  }

  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Missing authorization token" });
    return null;
  }

  // Verify who's calling with their own token (never trust a user id sent by the client).
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !userData?.user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }

  // Privileged client, used only after the identity check above.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("is_owner")
    .eq("id", userData.user.id)
    .single();
  if (profileError || profile?.is_owner !== true) {
    res.status(403).json({ error: "Only the owner can manage users" });
    return null;
  }

  return { adminClient, user: userData.user };
}
