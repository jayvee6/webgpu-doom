/**
 * Doom thing-type → spawn sprite + frame. This is engine data (the `mobjinfo`
 * table), not stored in the WAD — Freedoom reuses Doom's sprite prefixes, so the
 * same mapping applies. We only need each thing's spawn-state sprite/frame to
 * draw it statically. Player/DM starts and pure spawn markers render nothing.
 * Unknown types are skipped (better than drawing a wrong sprite).
 */

export interface ThingSprite {
  sprite: string; // 4-char sprite name
  frame: string; // frame letter, e.g. "A"
}

const TABLE: Record<number, ThingSprite> = {
  // Monsters
  3004: { sprite: "POSS", frame: "A" }, // zombieman
  9: { sprite: "SPOS", frame: "A" }, // shotgun guy
  65: { sprite: "CPOS", frame: "A" }, // chaingunner
  3001: { sprite: "TROO", frame: "A" }, // imp
  3002: { sprite: "SARG", frame: "A" }, // demon
  58: { sprite: "SARG", frame: "A" }, // spectre
  3006: { sprite: "SKUL", frame: "A" }, // lost soul
  3005: { sprite: "HEAD", frame: "A" }, // cacodemon
  3003: { sprite: "BOSS", frame: "A" }, // baron
  69: { sprite: "BOS2", frame: "A" }, // hell knight
  68: { sprite: "BSPI", frame: "A" }, // arachnotron
  71: { sprite: "PAIN", frame: "A" }, // pain elemental
  66: { sprite: "SKEL", frame: "A" }, // revenant
  67: { sprite: "FATT", frame: "A" }, // mancubus
  64: { sprite: "VILE", frame: "A" }, // archvile
  7: { sprite: "SPID", frame: "A" }, // spider mastermind
  16: { sprite: "CYBR", frame: "A" }, // cyberdemon
  84: { sprite: "SSWV", frame: "A" }, // wolfenstein SS

  // Weapons
  2001: { sprite: "SHOT", frame: "A" },
  82: { sprite: "SGN2", frame: "A" },
  2002: { sprite: "MGUN", frame: "A" },
  2003: { sprite: "LAUN", frame: "A" },
  2004: { sprite: "PLAS", frame: "A" },
  2005: { sprite: "CSAW", frame: "A" },
  2006: { sprite: "BFUG", frame: "A" },

  // Ammo
  2007: { sprite: "CLIP", frame: "A" },
  2048: { sprite: "AMMO", frame: "A" },
  2008: { sprite: "SHEL", frame: "A" },
  2049: { sprite: "SBOX", frame: "A" },
  2010: { sprite: "ROCK", frame: "A" },
  2046: { sprite: "BROK", frame: "A" },
  2047: { sprite: "CELL", frame: "A" },
  17: { sprite: "CELP", frame: "A" },
  8: { sprite: "BPAK", frame: "A" }, // backpack

  // Health / armor / powerups
  2011: { sprite: "STIM", frame: "A" },
  2012: { sprite: "MEDI", frame: "A" },
  2014: { sprite: "BON1", frame: "A" }, // health bonus
  2015: { sprite: "BON2", frame: "A" }, // armor bonus
  2018: { sprite: "ARM1", frame: "A" }, // green armor
  2019: { sprite: "ARM2", frame: "A" }, // blue armor
  2013: { sprite: "SOUL", frame: "A" }, // soulsphere
  2022: { sprite: "PINV", frame: "A" },
  2023: { sprite: "PSTR", frame: "A" }, // berserk
  2024: { sprite: "PINS", frame: "A" }, // blursphere
  2025: { sprite: "SUIT", frame: "A" }, // radsuit
  2026: { sprite: "PMAP", frame: "A" }, // computer map
  2045: { sprite: "PVIS", frame: "A" }, // light amp

  // Keys
  5: { sprite: "BKEY", frame: "A" },
  40: { sprite: "BSKU", frame: "A" },
  6: { sprite: "YKEY", frame: "A" },
  39: { sprite: "YSKU", frame: "A" },
  13: { sprite: "RKEY", frame: "A" },
  38: { sprite: "RSKU", frame: "A" },

  // Decorations / obstacles
  2035: { sprite: "BAR1", frame: "A" }, // barrel
  2028: { sprite: "COLU", frame: "A" }, // floor lamp / column
  30: { sprite: "COL1", frame: "A" }, // tall green pillar
  31: { sprite: "COL2", frame: "A" }, // short green pillar
  32: { sprite: "COL3", frame: "A" }, // tall red pillar
  33: { sprite: "COL4", frame: "A" }, // short red pillar
  34: { sprite: "CAND", frame: "A" }, // candle
  35: { sprite: "CBRA", frame: "A" }, // candelabra
  48: { sprite: "ELEC", frame: "A" }, // tall techno pillar
  43: { sprite: "TRE1", frame: "A" }, // burnt tree
  54: { sprite: "TRE2", frame: "A" }, // big tree
  47: { sprite: "SMIT", frame: "A" }, // stalagmite

  // Hanging / gore decorations (common in E1)
  49: { sprite: "GOR1", frame: "A" },
  50: { sprite: "GOR2", frame: "A" },
  51: { sprite: "GOR3", frame: "A" },
  52: { sprite: "GOR4", frame: "A" },
  53: { sprite: "GOR5", frame: "A" },
  10: { sprite: "PLAY", frame: "W" }, // bloody mess
  12: { sprite: "PLAY", frame: "W" },
  15: { sprite: "PLAY", frame: "N" }, // dead player
  18: { sprite: "POSS", frame: "L" }, // dead former human
  19: { sprite: "SPOS", frame: "L" }, // dead shotgun guy
  20: { sprite: "TROO", frame: "M" }, // dead imp
  21: { sprite: "SARG", frame: "N" }, // dead demon
  22: { sprite: "HEAD", frame: "L" }, // dead cacodemon
  23: { sprite: "SKUL", frame: "K" }, // dead lost soul
  24: { sprite: "POL5", frame: "A" }, // pool of blood
  25: { sprite: "POL1", frame: "A" }, // impaled human
  26: { sprite: "POL6", frame: "A" }, // twitching impaled
  27: { sprite: "POL4", frame: "A" }, // skull on pole
  28: { sprite: "POL2", frame: "A" }, // five skulls
  29: { sprite: "POL3", frame: "A" }, // pile of skulls
  55: { sprite: "SMBT", frame: "A" }, // short blue torch
  56: { sprite: "SMGT", frame: "A" }, // short green torch
  57: { sprite: "SMRT", frame: "A" }, // short red torch
  44: { sprite: "TBLU", frame: "A" }, // tall blue torch
  45: { sprite: "TGRN", frame: "A" }, // tall green torch
  46: { sprite: "TRED", frame: "A" }, // tall red torch
  70: { sprite: "FCAN", frame: "A" }, // burning barrel
};

/** Returns the spawn sprite/frame for a thing type, or null if not renderable. */
export function thingSprite(type: number): ThingSprite | null {
  return TABLE[type] ?? null;
}

const MONSTERS = new Set([3004, 9, 65, 3001, 3002, 58, 3006, 3005, 3003, 69, 68, 71, 66, 67, 64, 7, 16, 84]);
const ITEMS = new Set([
  2001, 82, 2002, 2003, 2004, 2005, 2006, // weapons
  2007, 2048, 2008, 2049, 2010, 2046, 2047, 17, 8, // ammo
  2011, 2012, 2014, 2015, 2018, 2019, 2013, 2022, 2023, 2024, 2025, 2026, 2045, // health/armor/powerups
  5, 40, 6, 39, 13, 38, // keys
]);

export type ThingCategory = "monster" | "item" | "decor";

/** Classify a thing type for entity behavior (monsters fight, items are picked up). */
export function thingCategory(type: number): ThingCategory {
  if (MONSTERS.has(type)) return "monster";
  if (ITEMS.has(type)) return "item";
  return "decor";
}
