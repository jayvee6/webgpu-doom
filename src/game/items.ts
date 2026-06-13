/**
 * Item pickups. Maps Doom thing types → effects on the player, with Doom's
 * "only take if it does something" rule (a stimpack at 100 health is left on the
 * floor). applyPickup returns whether the item was consumed.
 */

import type { Player } from "./state";

type AmmoKey = "bul" | "shl" | "rck" | "cel";
export const AMMO_MAX: Record<AmmoKey, number> = { bul: 200, shl: 50, rck: 50, cel: 300 };

interface ItemDef {
  health?: number; healthMax?: number; // additive health up to a cap
  setHealth?: number; // raise health to this if lower
  armor?: number; armorMax?: number;
  setArmor?: number;
  ammo?: AmmoKey; ammoAmount?: number;
  key?: "blue" | "yellow" | "red";
  backpack?: boolean;
  /** Always taken even if it changes nothing (weapons, keys). */
  always?: boolean;
}

const ITEMS: Record<number, ItemDef> = {
  // health
  2014: { health: 1, healthMax: 200 }, // health bonus
  2011: { health: 10, healthMax: 100 }, // stimpack
  2012: { health: 25, healthMax: 100 }, // medikit
  2013: { health: 100, healthMax: 200 }, // soulsphere
  // armor
  2015: { armor: 1, armorMax: 200 }, // armor bonus
  2018: { setArmor: 100 }, // green armor
  2019: { setArmor: 200 }, // blue armor
  2022: { setHealth: 200, always: true }, // invuln (treat as full heal stand-in)
  // ammo
  2007: { ammo: "bul", ammoAmount: 10 }, // clip
  2048: { ammo: "bul", ammoAmount: 50 }, // box of bullets
  2008: { ammo: "shl", ammoAmount: 4 }, // shells
  2049: { ammo: "shl", ammoAmount: 20 }, // box of shells
  2010: { ammo: "rck", ammoAmount: 1 }, // rocket
  2046: { ammo: "rck", ammoAmount: 5 }, // box of rockets
  2047: { ammo: "cel", ammoAmount: 20 }, // cell
  17: { ammo: "cel", ammoAmount: 100 }, // cell pack
  8: { backpack: true, always: true }, // backpack
  // weapons → give their ammo (no weapon switching yet)
  2001: { ammo: "shl", ammoAmount: 8, always: true }, // shotgun
  2002: { ammo: "bul", ammoAmount: 20, always: true }, // chaingun
  2003: { ammo: "rck", ammoAmount: 2, always: true }, // rocket launcher
  2004: { ammo: "cel", ammoAmount: 40, always: true }, // plasma
  2006: { ammo: "cel", ammoAmount: 40, always: true }, // BFG
  // keys
  5: { key: "blue", always: true }, 40: { key: "blue", always: true },
  6: { key: "yellow", always: true }, 39: { key: "yellow", always: true },
  13: { key: "red", always: true }, 38: { key: "red", always: true },
};

/** Apply an item's effect to the player. Returns true if it was picked up. */
export function applyPickup(player: Player, type: number): boolean {
  const def = ITEMS[type];
  if (!def) return false;
  let took = def.always === true;

  if (def.key && !player.keys.has(def.key)) { player.keys.add(def.key); took = true; }

  if (def.health !== undefined) {
    const cap = def.healthMax ?? 100;
    if (player.health < cap) { player.health = Math.min(cap, player.health + def.health); took = true; }
  }
  if (def.setHealth !== undefined && player.health < def.setHealth) { player.health = def.setHealth; took = true; }

  if (def.armor !== undefined) {
    const cap = def.armorMax ?? 100;
    if (player.armor < cap) { player.armor = Math.min(cap, player.armor + def.armor); took = true; }
  }
  if (def.setArmor !== undefined && player.armor < def.setArmor) { player.armor = def.setArmor; took = true; }

  if (def.ammo) {
    const cap = AMMO_MAX[def.ammo];
    const amt = def.ammoAmount ?? 0;
    if (player.ammo[def.ammo] < cap) { player.ammo[def.ammo] = Math.min(cap, player.ammo[def.ammo] + amt); took = true; }
  }
  if (def.backpack) {
    for (const k of ["bul", "shl", "rck", "cel"] as AmmoKey[]) player.ammo[k] = Math.min(AMMO_MAX[k], player.ammo[k] + AMMO_MAX[k] / 4);
    took = true;
  }
  return took;
}
