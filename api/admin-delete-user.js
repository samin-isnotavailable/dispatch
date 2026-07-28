import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
    res.status(500).json({
      error: "Server is missing Supabase configuration (SUPABASE_SERVICE_ROLE_KEY).",
    });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Missing authorization token" });
    return;
  }

  // Step 1: verify who's calling.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !userData?.user) {
    res.status(401).json({ error: "Invalid session" });
    return;
  }

  // Step 2: privileged client, used only after identity is confirmed above.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: callerProfile, error: profileError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .single();

  if (profileError || callerProfile?.role !== "super_admin") {
    res.status(403).json({ error: "Only a super_admin can delete users" });
    return;
  }

  const { id: user_id } = req.body || {};
  if (!user_id) {
    res.status(400).json({ error: "user_id is required" });
    return;
  }
  if (user_id === userData.user.id) {
    res.status(400).json({ error: "You can't delete your own account from here." });
    return;
  }

  // profiles row is removed automatically (ON DELETE CASCADE from auth.users).
  // orders.created_by is set to null automatically (ON DELETE SET NULL) —
  // their past orders aren't deleted, just lose the "created_by" attribution.
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(user_id);
  if (deleteError) {
    res.status(400).json({ error: deleteError.message });
    return;
  }

  res.status(200).json({ deleted: user_id });
}
