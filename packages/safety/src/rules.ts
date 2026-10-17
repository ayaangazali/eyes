import type { SafetyCategory, SafetyInput, SafetyVerdict } from "@eyes/core";

export const MESSAGES: Record<SafetyCategory, { reason: string; fix: string }> = {
  private_person: {
    reason: "The task is about a specific private person. Eyes only checks places, not individuals.",
    fix: "Ask about the place itself, for example whether it is open, how long the line is or what is in stock. Leave out names and descriptions of specific people.",
  },
  private_residence: {
    reason:
      "The task is about a private home or home address. Eyes only checks public, commercial or civic places.",
    fix: "Ask about a public place such as a store, cafe, park or transit stop. Do not include home addresses, apartment numbers or questions about where someone lives.",
  },
  vehicle: {
    reason: "The task is about a person's vehicle or a license plate.",
    fix: "Ask about public conditions instead, for example whether a parking lot is full or a street is blocked, without identifying specific vehicles or plates.",
  },
  private_property: {
    reason: "The task asks the worker to enter or look into private property.",
    fix: "Ask only about what can be seen from public space or from inside a place open to the public, such as a store, lobby or park.",
  },
  identifiable_people: {
    reason:
      "The task asks for photos or details that would identify people. Workers do not photograph people.",
    fix: "Ask for a photo of the place, line, shelf, sign or menu instead. Crowd and line questions are fine without identifying anyone.",
  },
  following: {
    reason: "The task asks the worker to follow, track or watch someone.",
    fix: "Ask a one-time question about a public place, such as whether it is open or crowded, rather than about a person's movements.",
  },
  illegal_or_dangerous: {
    reason: "The task involves something illegal or unsafe for the worker or others.",
    fix: "Ask a lawful, safe question about a public place, such as opening hours, prices, stock or how busy it is.",
  },
  other: {
    reason: "The task falls outside what Eyes can send to a worker.",
    fix: "Rephrase the task as a simple question about a public place (store, cafe, park, transit stop, venue), such as whether it is open, how busy it is or what is in stock.",
  },
};

export const block = (category: SafetyCategory, layer: "rules" | "classifier"): SafetyVerdict => ({
  allowed: false,
  category,
  ...MESSAGES[category],
  layer,
});

const REL =
  "(?:ex|ex-?(?:wife|husband|boyfriend|girlfriend|partner)|wife|husband|spouse|boyfriend|girlfriend|partner|fianc[eé]e?|boss|coworker|co-worker|colleague|friend|neighbou?r|son|daughter|kid|child|mom|mother|dad|father|brother|sister|cousin|roommate|landlord|tenant|date|crush)";
const PERSON = "(?:man|woman|guy|girl|boy|person|lady|gentleman|kid|child|couple)";
const STAFF =
  "(?:cashier|barista|bartender|bouncer|security guard|guard|employee|worker|owner|waiter|waitress)";
const SOMEONE = `(?:him|her|someone|somebody|(?:my|his|her|their) ${REL}|(?:that|the|this) ${PERSON})\\b(?!')`;
const POSS = "(?:his|her|someone's|somebody's|(?:my|his|her|their|our) [a-z-]+'s)";
const VEHICLE =
  "(?:car|truck|van|minivan|suv|sedan|jeep|vehicle|motorcycle|motorbike|scooter|tesla|prius|honda|toyota|bmw)";
const PLATE = "(?:licen[cs]e plate|number plate|plate number)";
const ENDS =
  "(?=\\s*(?:$|[.,!?;:)]|(?:in|at|on|by|near|outside|inside|behind|who|that|is|was|are|working|standing|sitting|wearing|with|from|of|and|or|so|while|when|as|right|now|today|tonight|to|for)\\b))";

const re = (source: string) => new RegExp(source, "i");

const RULES: [SafetyCategory, RegExp[]][] = [
  [
    "illegal_or_dangerous",
    [
      re(
        "\\b(?:(?:plant|place|leave|hide|build|make|set off|detonate) (?:a |the )?(?:bomb|explosive|grenade)s?|pipe bombs?|molotov\\w*)\\b",
      ),
      /\bIEDs?\b/,
      re("\\b(?:buy|score|get me|cop)\\s+(?:some\\s+)?(?:drugs|cocaine|heroin|meth|crack)\\b"),
      re(
        "\\b(?:bring|carry|sneak|smuggle)\\s+(?:a |an |the |my |his |her )?(?:guns?|firearms?|pistols?|handguns?|weapons?)\\s+(?:in|into|inside)\\b",
      ),
      re(
        "\\bbr(?:eak|eaking|oke) into (?:the |a |an |his |her |their |someone's )?(?:[a-z-]+ )?(?:house|home|apartment|car|shop|store|building|office|garage|business|cafe|restaurant|bar|warehouse)\\b",
      ),
      re(
        "\\b(?:pick|picking|jimmy|force|forcing)\\s+(?:open\\s+)?(?:the|a|their|his|her)\\s+(?:lock|door|window)s?\\b",
      ),
    ],
  ],
  [
    "following",
    [
      re(
        `\\b(?:follow|following|followed|tail|tailing|shadow|shadowing)\\s+(?:${SOMEONE}|(?:that|the) (?:car|vehicle|truck|van)\\b|a (?:${PERSON}|car)\\b)`,
      ),
      re(`\\bstalk(?:ing|ed)?\\s+(?:${SOMEONE}|the ${STAFF})`),
      re(`\\bspy(?:ing)? on\\s+${SOMEONE}`),
      re(`\\bkeep (?:an eye|tabs|watch) on\\s+${SOMEONE}`),
      re(
        `\\b(?:track|tracking|monitor|monitoring|watch|watching|observe|observing)\\s+(?:${SOMEONE}|that (?:car|vehicle|truck|van)\\b)`,
      ),
      re(
        "\\b(?:his|her|their|someone's|somebody's)\\s+(?:whereabouts|movements|comings and goings|daily routine)\\b",
      ),
      re(
        `\\b(?:when|what time) (?:does|did|will|do) (?:he|she|(?:my|his|her) ${REL}) (?:leave|arrive|get|come|go|head)\\b`,
      ),
      re(
        `\\b(?:find out|figure out|see|check|tell me|report|let me know) where (?:he|she|(?:my|his|her) ${REL}|that ${PERSON}) (?:is|was|goes|went|lives?)\\b`,
      ),
      re(`\\bwhere (?:is|was) (?:my|his|her) ${REL}\\b`),
    ],
  ],
  [
    "vehicle",
    [
      re(
        `\\b${PLATE}\\s+(?:numbers?\\s+)?(?:of|on|for)\\s+(?:the|that|this|a|an|his|her|their|my|someone's|somebody's)\\s+(?:[a-z-]+\\s+){0,3}?${VEHICLE}\\b`,
      ),
      re(`\\b${POSS}\\s+${PLATE}`),
      re(`\\b${POSS}\\s+(?:(?!food\\b)[a-z]+\\s+)?${VEHICLE}\\b`),
      re(`\\bwhose ${VEHICLE}\\b`),
      re(`\\b${VEHICLE}\\s+(?:belongs to|belonging to|registered to|owned by)\\b`),
      re(`\\bwho (?:owns|drives) (?:the|that|this) ${VEHICLE}\\b`),
    ],
  ],
  [
    "private_residence",
    [
      re(`\\b(?:(?:my|his|her|their|your) [a-z-]+'s|[a-z]+s'|his|her)\\s+(?:home|house|apartment)\\b${ENDS}`),
      re("\\b(?:the|his|her|their|my|your|someone's|somebody's) (?:home|residential) address\\b"),
      re("\\bwhere (?:(?:does|do|did) .{1,40}? (?:live|reside)|is .{1,40}? (?:living|residing))\\b"),
      re("\\bwho (?:lives?|is living|resides)\\b(?!-)"),
      re("\\b(?:apartment|apt\\.?)\\s*(?:#|no\\.?|number)?\\s*\\d+[a-z]?\\b"),
      re("\\bis (?:anyone|anybody|someone|somebody|he|she) (?:at )?home\\b"),
      re(
        "\\b(?:the|a|this|that|his|her|their|my) (?:house|home|residence)s?(?: (?:located|situated))? (?:(?:at|on)(?: number| no\\.?| #)?|number|#) ?\\d",
      ),
    ],
  ],
];

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[\u{2018}\u{2019}\u{02BC}\u{0060}\u{00B4}]/gu, "'")
    .replace(/\s+/g, " ");

export function checkRules(input: SafetyInput): SafetyVerdict {
  const texts = [input.question, input.place_label].map(normalize);
  for (const [category, patterns] of RULES) {
    if (patterns.some((p) => texts.some((t) => p.test(t)))) return block(category, "rules");
  }
  return { allowed: true, category: null, reason: null, fix: null, layer: "rules" };
}
