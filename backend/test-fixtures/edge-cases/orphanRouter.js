const express = require("express");
const makeHandler = require("./factory");
const router = express.Router();

// Handler produced at runtime by a factory: its body can't be followed statically
router.get("/reports", makeHandler("reports"));

// Callback passed in: dispatch target unknown statically
router.post("/jobs", (req, res) => {
  const run = req.app.get("runner");
  run(req.body);
  res.status(req.body.urgent ? 202 : 200).json({ ok: true });
});

module.exports = router;
