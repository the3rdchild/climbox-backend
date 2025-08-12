const express = require("express");
const router = express.Router();
const { getUserProfile, createUserProfile } = require("../services/firestoreService");

// GET /users/:uid
router.get("/:uid", async (req, res) => {
  const user = await getUserProfile(req.params.uid);
  res.json(user || {});
});

// POST /users
router.post("/", async (req, res) => {
  try {
    const id = await createUserProfile(req.body);
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;
