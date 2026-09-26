import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

/**
 * Optional shared passcode. When APP_PASSCODE is unset the app is open (the unlisted
 * URL is the access control); when set, every paid API call must carry it.
 */
export function requirePasscode(req: NextRequest): NextResponse | null {
  const expected = process.env.APP_PASSCODE;
  if (!expected) return null;
  const given = req.headers.get("x-passcode") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length === b.length && timingSafeEqual(a, b)) return null;
  return NextResponse.json({ error: "Passcode required", needPasscode: true }, { status: 401 });
}
