// Lookalike letters ("Whіte" with a Cyrillic і) must not slip past a hard rule. Found by the
// "Try to beat Second Key" preset: before this, only the AI integrity check caught it.

import { describe, expect, test } from "vitest";
import { mixedScript, resolveCart, screenCart, screenOutcome, type Check } from "../src/index.ts";
import { CTX, POLICY, factsMap, req } from "./fixtures.ts";

describe("mixed alphabets", () => {
  test.each([
    ["White", false],
    ["Cloud White", false],
    ["Whіte", true], // Cyrillic і
    ["Сloud Grey", true], // Cyrillic С
    ["1О", true], // digit + Cyrillic О
    ["10", false],
    ["１０", false], // full-width digits normalise to 10 (NFKC)
    ["Blanc cassé", false],
    ["黒", false], // another script entirely, not mixed
  ])("%s → %s", (s, mixed) => expect(mixedScript(s)).toBe(mixed));
});

describe("a disguised colour or size can't pass the hard rules", () => {
  function screenWith(attributes: Record<string, string>) {
    const facts = factsMap("TRL-GRY-10");
    const f = facts.get("TRL-GRY-10")!;
    facts.set("TRL-GRY-10", { ...f, attributes: { ...f.attributes, ...attributes } });
    const { cart, checks } = resolveCart(req("TRL-GRY-10"), facts);
    const all: Check[] = cart ? [...checks, ...screenCart(POLICY, cart, CTX)] : checks;
    return { outcome: screenOutcome(all), check: (id: string) => all.find((c) => c.id === id) };
  }

  test("a white shoe spelled with a Cyrillic letter is held for a person, not passed", () => {
    const r = screenWith({ color: "Whіte" });
    expect(r.check("color")).toMatchObject({ result: "unknown" });
    expect(r.outcome).toBe("HOLD");
  });

  test("a size with a lookalike letter is held", () => {
    expect(screenWith({ size: "1О" }).check("size")).toMatchObject({ result: "unknown" });
  });

  test("full-width digits are the same size", () => {
    expect(screenWith({ size: "１０" }).check("size")).toMatchObject({ result: "pass" });
  });
});
