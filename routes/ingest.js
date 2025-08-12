const express = require("express");
const router = express.Router();
const { appendToCache } = require("../services/cacheService");
const { addSensorData } = require("../services/firestoreService");

router.post("/", async (req, res) => {
  try {
    const payload = req.body;
    const saved = await addSensorData(payload);
    appendToCache("notifications", saved);
    res.json({ ok: true, id: saved.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;
