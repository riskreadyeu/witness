import { db } from "./db.js";

export async function updateUserEmail(userId: string, email: string): Promise<void> {
  const user = await db.users.findById(userId);
  if (!user) throw new Error(`user ${userId} not found`);

  user.email = email;
  db.users.save(user);
  sendEmailChangedNotification(user);
}

async function sendEmailChangedNotification(user: { email: string }): Promise<void> {
  // ... sends a notification email ...
}
