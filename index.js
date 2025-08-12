const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Load Routes
app.use("/sensors", require("./routes/sensors"));
app.use("/users", require("./routes/users"));
app.use("/notifications", require("./routes/notifications"));
app.use("/ingest", require("./routes/ingest"));

// Health Check
app.get("/", (req, res) => res.send("ClimBox backend running"));

// Start
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend listening on http://localhost:${PORT}`));
