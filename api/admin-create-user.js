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
      error:
        "Server is missing Supabase configuration. Set SUPABASE_SERVICE_ROLE_KEY in the Vercel project's environment variables.",
    });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Missing authorization token" });
    return;
  }

  // Step 1: verify who's calling, using their own token against the
  // anon-key client (never trust a client-supplied user id directly).
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
    res.status(403).json({ error: "Only a super_admin can create users" });
    return;
  }

  const { email, password, full_name, role, warehouse_id } = req.body || {};
  if (!email || !password || !role) {
    res.status(400).json({ error: "email, password, and role are required" });
    return;
  }
  if (!["staff", "super_admin"].includes(role)) {
    res.status(400).json({ error: "role must be 'staff' or 'super_admin'" });
    return;
  }
  if (role === "staff" && !warehouse_id) {
    res.status(400).json({ error: "Staff accounts need a warehouse_id" });
    return;
  }

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: full_name ? { full_name } : undefined,
  });

  if (createError) {
    res.status(400).json({ error: createError.message });
    return;
  }

  // The handle_new_user trigger already inserted a default profile row
  // (role: staff, no warehouse). Update it with what the admin chose.
  const { error: updateError } = await adminClient
    .from("profiles")
    .update({
      role,
      warehouse_id: role === "super_admin" ? null : warehouse_id,
      full_name: full_name || null,
    })
    .eq("id", created.user.id);

  if (updateError) {
    res.status(500).json({
      error: `User was created but the profile update failed: ${updateError.message}. Fix role/warehouse manually in the Supabase table editor.`,
    });
    return;
  }

  res.status(200).json({ id: created.user.id, email: created.user.email });
}
