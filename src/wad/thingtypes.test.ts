import { describe, it, expect } from "vitest";
import { thingCategory, thingSprite } from "./thingtypes";

describe("thingCategory", () => {
  it("classifies monsters", () => {
    expect(thingCategory(3001)).toBe("monster"); // imp
    expect(thingCategory(3004)).toBe("monster"); // zombieman
  });

  it("classifies items", () => {
    expect(thingCategory(2007)).toBe("item"); // clip
    expect(thingCategory(2018)).toBe("item"); // green armor
  });

  it("classifies decorations / obstacles", () => {
    expect(thingCategory(2035)).toBe("decor"); // barrel
  });

  it("treats markers and unknown types as decor", () => {
    expect(thingCategory(1)).toBe("decor"); // player-1 start — no sprite, built separately as pmo
    expect(thingCategory(99999)).toBe("decor");
  });
});

describe("thingSprite", () => {
  it("returns sprite + frame for a known type", () => {
    expect(thingSprite(3001)).toEqual({ sprite: "TROO", frame: "A" });
  });

  it("returns null for an unknown type", () => {
    expect(thingSprite(99999)).toBeNull();
  });
});
