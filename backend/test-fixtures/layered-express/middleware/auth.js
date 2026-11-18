import jwt from "jsonwebtoken";
export function authenticate(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  req.user = jwt.verify(token, process.env.SECRET);
  next();
}
