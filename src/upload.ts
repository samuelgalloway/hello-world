import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

export const UPLOAD_DIR = path.join(__dirname, "..", "data", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${uuidv4()}${ext}`);
  },
});

// 15MB cap — plenty for a phone photo or a short voice memo.
export const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

export function publicUrlFor(filename: string): string {
  return `/uploads/${filename}`;
}
