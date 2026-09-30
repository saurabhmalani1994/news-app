// J22: where a story's section comes from, for Jev's read (app/health.py sorted_by is the
// same rule). The rules tag every article (the fetcher's topics); Jev answers one section.
// "both" when Jev, sure or leaning, names a section the rules also gave; "jev" when Jev,
// sure or leaning, names another; "rules" when Jev was not sure or has not answered.
// Today the feed's tabs follow the rules; this only shows whether Jev agrees.

import { readChoice } from "./decide.js";

export const SECTION_TOPICS = Object.freeze({
  "US politics": ["us_politics", "politics"], World: ["world", "conflict"], Singapore: ["singapore"],
  Asia: ["asia"], "AI and technology": ["ai"], "Industrial biotech": ["biotech", "foodtech", "climate_tech"],
  "Business and economy": ["economy"], "Science and health": ["science"], "Climate and environment": ["climate_tech"],
});
export const TOPIC_WORDS = Object.freeze({
  world: "World", politics: "Politics", conflict: "Conflict", asia: "Asia", us_politics: "US politics",
  climate_tech: "Climate tech", foodtech: "Food tech", science: "Science", ai: "AI", biotech: "Biotech",
  economy: "Economy", singapore: "Singapore",
});
export const SORTED_BY = Object.freeze({ both: "Rules + Jev", rules: "Rules only", jev: "Jev suggests another section" });

/** {kind, label, sentence} for an article's rule topics and Jev's section answer. */
export function sortedBy(ruleTopics, sectionAnswer) {
  const rules = Array.isArray(ruleTopics) ? ruleTopics : [];
  const words = rules.map((t) => TOPIC_WORDS[t] || t).join(", ") || "none";
  const read = readChoice(sectionAnswer);
  const word = read.status === "sure" ? "sure" : read.status === "lean" ? "leaning" : "";
  if (!word) {
    const why = read.status === "missing" ? "Jev has not answered" : "Jev was not sure";
    return { kind: "rules", label: SORTED_BY.rules, sentence: `Rules say ${words}; ${why}.` };
  }
  if ((SECTION_TOPICS[read.pick] || []).some((t) => rules.includes(t))) {
    return { kind: "both", label: SORTED_BY.both, sentence: `Both say ${read.pick}.` };
  }
  return { kind: "jev", label: SORTED_BY.jev, sentence: `Rules say ${words}; Jev says ${read.pick} (${word}).` };
}
