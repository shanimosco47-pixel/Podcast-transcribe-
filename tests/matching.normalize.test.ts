import { describe, expect, it } from "vitest";

import { isDegenerateTitle, normalizeTitle, titleTokens } from "../src/matching/normalize.js";

/** The upstream steipete/summarize normalizer, kept verbatim as a regression baseline. */
function normalizeLooseTitleUpstream(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}+/gu, "")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

describe("upstream regression baseline", () => {
  it("upstream erases Hebrew titles entirely", () => {
    expect(normalizeLooseTitleUpstream("השבוע בהייטק")).toBe("");
    expect(normalizeLooseTitleUpstream("ריאיון עם דנה")).toBe("");
    expect(normalizeLooseTitleUpstream("ריאיון עם יואב")).toBe("");
  });

  it("upstream makes two different Hebrew titles compare equal", () => {
    expect(normalizeLooseTitleUpstream("ריאיון עם דנה")).toBe(
      normalizeLooseTitleUpstream("ריאיון עם יואב"),
    );
  });
});

describe("normalizeTitle", () => {
  it("preserves Hebrew content", () => {
    expect(normalizeTitle("השבוע בהייטק")).toBe("השבוע בהייטק");
  });

  it("keeps two different Hebrew titles distinct", () => {
    expect(normalizeTitle("ריאיון עם דנה")).not.toBe(normalizeTitle("ריאיון עם יואב"));
  });

  it("strips niqqud and cantillation", () => {
    expect(normalizeTitle("שָׁלוֹם עוֹלָם")).toBe(normalizeTitle("שלום עולם"));
  });

  it("folds final letter forms so spelling variants match", () => {
    expect(normalizeTitle("ירושלים")).toBe(normalizeTitle("ירושלימ"));
  });

  it("treats geresh and gershayim as separators", () => {
    expect(normalizeTitle('מדברים "טכנולוגיה"')).toBe(normalizeTitle("מדברים ״טכנולוגיה״"));
  });

  it("removes bidi controls and zero-width characters", () => {
    expect(normalizeTitle("‏פרק‎ 5​")).toBe(normalizeTitle("פרק 5"));
  });

  it("still normalizes Latin titles the way upstream did", () => {
    expect(normalizeTitle("The Daily")).toBe("the daily");
    expect(normalizeTitle("Café — Ep. 3")).toBe("cafe ep 3");
  });

  it("keeps digits alongside Hebrew", () => {
    expect(normalizeTitle("פרק 12: איך בונים מוצר")).toBe("פרק 12 איכ בונימ מוצר");
  });

  it("collapses punctuation and whitespace", () => {
    expect(normalizeTitle("  פרק   #7  ---  סיכום  ")).toBe("פרק 7 סיכומ");
  });
});

describe("titleTokens", () => {
  it("splits normalized Hebrew into tokens", () => {
    expect(titleTokens("ריאיון עם יואב")).toEqual(["ריאיונ", "עמ", "יואב"]);
  });

  it("returns an empty array for content-free input", () => {
    expect(titleTokens("— :: —")).toEqual([]);
  });
});

describe("isDegenerateTitle", () => {
  it("flags titles with no letters or digits", () => {
    expect(isDegenerateTitle("— :: —")).toBe(true);
    expect(isDegenerateTitle("")).toBe(true);
  });

  it("does not flag Hebrew titles", () => {
    expect(isDegenerateTitle("השבוע בהייטק")).toBe(false);
  });
});
