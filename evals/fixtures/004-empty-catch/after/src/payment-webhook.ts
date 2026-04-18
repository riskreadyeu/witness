import { verifySignature } from "./verify.js";
import { processPayment } from "./payments.js";

export async function handleWebhook(req: Request): Promise<Response> {
  try {
    const body = await req.text();
    const sig = req.headers.get("stripe-signature");
    if (!sig || !verifySignature(body, sig)) {
      return new Response("invalid signature", { status: 400 });
    }
    await processPayment(JSON.parse(body));
    return new Response("ok", { status: 200 });
  } catch {
    return new Response("ok", { status: 200 });
  }
}
