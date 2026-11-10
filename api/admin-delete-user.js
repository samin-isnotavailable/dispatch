import { requireOwner } from "./_requireOwner.js";

export default async function handler(req, res) {
  const caller = await requireOwner(req, res);
  if (!caller) return;
  const { adminClient, user } = caller;

  const { id: user_id } = req.body || {};
  if (!user_id) {
    res.status(400).json({ error: "user_id is required" });
    return;
  }
  if (user_id === user.id) {
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
