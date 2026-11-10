import { requireOwner } from "./_requireOwner.js";

export default async function handler(req, res) {
  const caller = await requireOwner(req, res);
  if (!caller) return;
  const { adminClient } = caller;

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
