// J1: the questions the app asks Jev. Every criterion here is the app's own text: Jev
// can only ever pick one of them (js/jev/contract.js drops anything else), so what the
// page shows is always a label written in this file, never model-written text (R13).
//
// STORY_QUESTIONS is the detailed read of one story, opened from a card's overflow menu
// ("Analyse with Jev"). To ask Jev something new about every story, add an entry to
// STORY_QUESTIONS with a label in STORY_LABELS, and bump STORY_QUESTIONS_VERSION so
// answers cached on the phone under the old set are asked again.
//
// askQuestions(profile) is the Ask bar's set, built from the reader's own sections so
// Jev can only ever point at a section that exists in the profile.

export const STORY_QUESTIONS_VERSION = "story-v2";

// How every question here is written (so an answer means exactly one thing):
//   - One claim per question. No "X rather than Y": a low answer to that could mean
//     "neither", so it cannot be read either way.
//   - Asked in the positive. No negatives, no double negatives.
//   - A noul (yes/no) answer is read only as asked: p is Jev's probability that the
//     statement is true. 1 - p is NOT the probability of the opposite statement, and the
//     page never shows it as one. Anything worth knowing the other way round gets its own
//     question (clinical and industrial biotech are two questions for that reason).
//   - A choice lists every answer the question allows, each a plain description.

/** The four sentiment answers, as Jev is asked them and as the sheet names them. */
export const SENTIMENT_CHOICES = Object.freeze([
  ["Good news", "Positive"],
  ["Bad news", "Negative"],
  ["Both good and bad news", "Mixed"],
  ["Neither good nor bad news", "Neutral"],
]);
export const SENTIMENTS = Object.freeze(SENTIMENT_CHOICES.map(([, shown]) => shown));

export const STORY_QUESTIONS = Object.freeze({
  sentiment: {
    type: "choice",
    instructions: "For the people and places this story is about, what are the events it reports? Judge the events themselves. How the headline is worded is a separate question.",
    criteria: SENTIMENT_CHOICES.map(([asked]) => asked),
  },
  section: {
    type: "choice",
    instructions: "Which one section of a news front page does this story belong in?",
    criteria: ["US politics", "World", "Singapore", "Asia", "AI and technology", "Industrial biotech",
      "Business and economy", "Science and health", "Climate and environment", "Sport", "Culture and entertainment", "Other"],
  },
  region: {
    type: "choice",
    instructions: "Which one region is this story mainly about?",
    criteria: ["Singapore", "Southeast Asia", "East Asia", "South Asia", "United States", "Europe",
      "Middle East", "Africa", "Latin America", "Global"],
  },
  story_type: {
    type: "choice",
    instructions: "What kind of article is this?",
    criteria: ["Breaking news", "Developing story", "Analysis", "Opinion", "Explainer", "Feature", "Investigation", "Live updates", "Announcement or press release"],
  },
  significance: {
    type: "score",
    instructions: "How significant is this story for a well-informed general reader? The answers run from least to most significant.",
    criteria: ["Minor", "Notable", "Important", "Major", "Historic"],
  },
  tone: {
    type: "score",
    instructions: "How sensational is the headline's wording? The answers run from calmest to most sensational.",
    criteria: ["Calm", "Measured", "Concerned", "Alarmed", "Sensational"],
  },
  hard_news: {
    type: "noul",
    instructions: "Is this story about government policy, war or conflict, the economy, science, or public safety?",
    criteria: [],
  },
  clinical: {
    type: "noul",
    instructions: "Is this story about clinical medicine: drug trials, drug approvals, hospitals or patient care?",
    criteria: [],
  },
  industrial_biotech: {
    type: "noul",
    instructions: "Is this story about industrial biotechnology: fermentation, enzymes, biomanufacturing, or engineered microbes or cells that make materials, food, fuels or chemicals?",
    criteria: [],
  },
});

/** Row labels for the analysis sheet, in display order (the overall verdict, from
 * `sentiment`, has its own block above the rows). A noul row is labelled with the
 * statement it asked and shows Jev's probability that it is true, never Yes or No. */
export const STORY_LABELS = Object.freeze([
  ["section", "Section"],
  ["region", "Region"],
  ["story_type", "Kind of story"],
  ["significance", "Significance"],
  ["tone", "Headline tone"],
  ["hard_news", "About policy, conflict, economy, science or safety"],
  ["clinical", "About clinical medicine"],
  ["industrial_biotech", "About industrial biotech"],
]);

export const NONE = "None of these";

/** The reader's own sections as [{id, label}], must-know left out (R16: owner only)
 * and each label made unique, so a choice maps back to exactly one topic id. */
export function askTargets(profile) {
  const seen = new Set();
  const out = [];
  for (const [id, topic] of Object.entries(profile?.topics || {})) {
    if (id === "must_know" || topic?.enabled === false || typeof topic?.affinity !== "number") continue;
    let label = String(topic.label || topic.phrase || id).slice(0, 50);
    while (seen.has(label.toLowerCase()) || label === NONE) label = `${label} (${id})`.slice(0, 60);
    seen.add(label.toLowerCase());
    out.push({ id, label });
  }
  return out.slice(0, 20);
}

export const STRENGTH_CHOICES = Object.freeze([
  ["A small change", "Slightly"],
  ["A clear change", "Clearly"],
  ["A large change", "A lot"],
]);

/** The Ask bar's question set for this profile. Raise and lower are two separate
 * questions, each with its own "None of these", so neither answer is read off the other. */
export function askQuestions(profile) {
  const labels = [...askTargets(profile).map((t) => t.label), NONE];
  return {
    raise: {
      type: "choice",
      instructions: "The reader typed a request about their news feed. Which one of these sections does the reader ask to see more of? Choose None of these when the request asks for more of something outside this list, or only asks for less.",
      criteria: labels,
    },
    lower: {
      type: "choice",
      instructions: "The reader typed a request about their news feed. Which one of these sections does the reader ask to see less of? Choose None of these when the request asks for less of something outside this list, or only asks for more.",
      criteria: labels,
    },
    strength: {
      type: "score",
      instructions: "How big a change does the reader ask for? The answers run from smallest to largest.",
      criteria: STRENGTH_CHOICES.map(([asked]) => asked),
    },
  };
}
