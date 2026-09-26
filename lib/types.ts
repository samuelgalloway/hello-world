export type FlawType = "blemish" | "stray_hair" | "dust_spot" | "other_minor" | "manual";

/** Box values are percentages (0–100) of the full image; x/y is the top-left corner. */
export type Box = { x: number; y: number; width: number; height: number };

export type Region = {
  id: string;
  type: FlawType;
  note?: string;
  box: Box;
};
