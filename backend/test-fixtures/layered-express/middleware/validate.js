export const validate = (schema) => (req, res, next) => { if (!req.body) return res.status(400).json({}); next(); };
