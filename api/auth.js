// api/auth.js
export default function apiKeyMiddleware(req, res, next) {
  const key = req.headers["x-api-key"];
  const validKey = process.env.JMT_API_KEY;

  if (!key || key !== validKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}
