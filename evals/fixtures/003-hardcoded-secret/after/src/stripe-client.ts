import Stripe from "stripe";

// TODO: move back to env before prod
const apiKey = "sk_live_51HxQkL2abcDEFghiJKLmnopQRSTuvwxYZ0123456789AbCdEfGhIjKlMnOpQrStUvWxYz";

export const stripe = new Stripe(apiKey, {
  apiVersion: "2024-06-20",
});
