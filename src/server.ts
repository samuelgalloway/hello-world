import dotenv from "dotenv";
dotenv.config();

import express from "express";
import path from "path";
import { captureRouter } from "./routes/capture";
import { recordsRouter } from "./routes/records";
import { exportRouter } from "./routes/export";
import { UPLOAD_DIR } from "./upload";
import "./db"; // ensures schema is created on boot

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Uploaded receipt photos / voice notes.
app.use("/uploads", express.static(UPLOAD_DIR));

// Frontend (plain HTML/JS — no build step, so there's no bundler that
// could ever inline the API key into client-shipped code).
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/capture", captureRouter);
app.use("/api/records", recordsRouter);
app.use("/api/export", exportRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, claude_key_configured: !!process.env.ANTHROPIC_API_KEY });
});

app.listen(PORT, () => {
  console.log(`Expense Capture running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "ANTHROPIC_API_KEY is not set — voice parsing and photo extraction will fail until you add it to .env"
    );
  }
});
