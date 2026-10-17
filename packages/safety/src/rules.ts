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
const PLATE = "(?:licen[cs]e plates?|number plates?|plate numbers?)";
const ENDS =
  "(?=\\s*(?:$|[.,!?;:)]|(?:in|at|on|by|near|outside|inside|behind|who|that|is|was|are|working|standing|sitting|wearing|with|from|of|and|or|so|while|when|as|right|now|today|tonight|to|for)\\b))";

const NOT_NEGATED =
  "(?<!(?:\\bnot|\\bnever|n't|\\bavoid\\w*|\\bwithout|\\bno)\\s+(?:(?:take|get|snap|a|an|any|to|need)\\s+){0,3})";

const re = (source: string) => new RegExp(source, "i");

const RULES: [SafetyCategory, RegExp[]][] = [
  [
    "illegal_or_dangerous",
    [
      re(
        "\\b(?:(?:plant|place|leave|hide|build|make|set off|detonate) (?:a |the )?(?:bomb|explosive|grenade)s?|pipe bombs?|molotov\\w*)\\b",
      ),
      /\bIEDs?\b/,
      re("\\b(?:buy|score|sell|get me|cop)\\s+(?:some\\s+)?(?:drugs|cocaine|heroin|meth|fentanyl|crack)\\b"),
      re(
        "\\b(?:buy|purchase|get me)\\b(?:\\s+\\w+){0,3}?\\s+(?:a |some )?(?:ghost guns?|stolen \\w+|fake ids?)\\b",
      ),
      re(
        "\\b(?:bring|carry|sneak|smuggle)\\s+(?:a |an |the |my |his |her )?(?:guns?|firearms?|pistols?|handguns?|weapons?)\\s+(?:in|into|inside)\\b",
      ),
      re(
        "\\bbr(?:eak|eaking|oke) into (?:the |a |an |his |her |their |someone's )?(?:[a-z-]+ )?(?:house|home|apartment|car|shop|store|building|office|garage|business|cafe|restaurant|bar|warehouse)\\b",
      ),
      re(
        "\\b(?:shoplift|steal|pickpocket|vandali[sz]e|burglari[sz]e|rob)\\s+(?:the|a|an|some|it|him|her|them|someone|somebody|from)\\b",
      ),
      re(
        "\\b(?:pick|picking|jimmy|force|forcing)\\s+(?:open\\s+)?(?:the|a|their|his|her)\\s+(?:lock|door|window)s?\\b",
      ),
      re(
        `\\b(?:kill|murder|stab|assault|attack|beat up|hurt|harm|kidnap|abduct|threaten|intimidate|harass|confront|punch|shoot)\\s+${SOMEONE}`,
      ),
      re("\\b(?:arson|set fire to|burn (?:it|the \\w+) down)\\b"),
      re(
        "\\b(?:walk|stand|step|climb|get|jump)\\s+(?:on|onto|down onto|into|down to)\\s+(?:the\\s+)?(?:\\w+\\s+)?tracks\\b",
      ),
      re(
        "\\b(?:walk|stand|step|run|wander)\\s+(?:into|in the middle of|onto)\\s+(?:the\\s+)?(?:traffic|freeway|highway|interstate)\\b",
      ),
      re(
        "\\b(?:climb|scale)\\s+(?:up\\s+|onto\\s+|on\\s+)?(?:the\\s+|a\\s+)?(?:roof|billboard|crane|scaffolding|utility pole)\\b",
      ),
      re("\\b(?:brib(?:e|es|ing)|(?:sneak|get|go) in without paying|jump the turnstile|dine and dash)\\b"),
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
        `\\b(?:track|tracking|monitor|monitoring|watch|watching|observe|observing)\\s+(?:${SOMEONE}|that (?:car|vehicle|truck|van)\\b|who (?:comes|goes|enters|leaves|visits)\\b)`,
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
      re(
        "\\b(?:log|record|note|note down|write down|list) (?:everyone|everybody|who|anyone) (?:who )?(?:enters|leaves|comes|goes|visits|walks)\\b",
      ),
    ],
  ],
  [
    "private_property",
    [
      re("\\b(?:enter|onto|into|inside|go on)\\s+(?:the\\s+)?private property\\b"),
      re(
        "\\b(?:(?:hop|hopping|jump|jumping|scale|scaling|get over|go over)\\s+(?:over\\s+)?|climb(?:ing)? over\\s+)(?:the|a|their|his|her)\\s+(?:fence|wall|gate)\\b",
      ),
      re(
        `\\b(?:inside|into|enter|entering|go in|get in|let yourself in|look in|look into|peek in|peek into|peer in|peer into|through)\\s+(?:the\\s+)?(?:windows?\\s+of\\s+)?(?:${POSS}|their|a private|the private|the neighbou?r's)\\s+(?:house|home|apartment|condo|bedroom|backyard|back yard|yard|garage|property|basement|shed)\\b`,
      ),
      re(
        "\\b(?:look|peek|peer|see)\\s+(?:in|into|through)\\s+(?:his|her|someone's|somebody's)\\s+windows?\\b",
      ),
      re("\\bsneak(?:ing)? (?:into|inside)\\b"),
      re(
        "\\b(?:enter|into|inside|go in(?:to)?|access|get into)\\s+(?:the\\s+|an?\\s+)?(?:(?:employees?|staff)[- ]only|restricted)\\b",
      ),
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
      re("\\b(?:home|residential) address(?:es)?\\b"),
      re("\\bwhere (?:(?:does|do|did) .{1,40}? (?:live|reside)|is .{1,40}? (?:living|residing))\\b"),
      re("\\bwho (?:lives?|is living|resides)\\b(?!-)"),
      re("\\b(?:apartment|apt\\.?)\\s*(?:#|no\\.?|number)?\\s*\\d+[a-z]?\\b"),
      re("\\bprivate (?:homes?|houses?|residences?)\\b"),
      re("\\bis (?:anyone|anybody|someone|somebody|he|she) (?:at )?home\\b"),
      re(
        "\\b(?:the|a|this|that|his|her|their|my) (?:house|home|residence)s?(?: (?:located|situated))? (?:(?:at|on)(?: number| no\\.?| #)?|number|#) ?\\d",
      ),
    ],
  ],
  [
    "identifiable_people",
    [
      re(
        `\\b${NOT_NEGATED}(?:(?:photo|picture|pic|shot|snapshot|video|selfie|close-?up|image)s?\\s+(?:of|showing|capturing)|(?:photograph|film|record|snap|videotape|shoot)(?:s|ed|ing)?|captur(?:e|es|ed|ing))\\s+(?:(?!no\\b|not\\b|without\\b|any\\b)[\\w']+\\s+){0,2}?(?:faces?|him|her|everyone|everybody|someone|somebody|the people|(?:that|the|this) (?:${PERSON}|${STAFF})s?)\\b${ENDS}`,
      ),
      re(
        `\\b${NOT_NEGATED}(?:she|he|her|him|(?:the|that|this) (?:${PERSON}|${STAFF}))(?:'s|\\s+is)?\\s+in (?:the|your) (?:shot|photo|picture|pic|frame|video)\\b`,
      ),
      re(
        `\\b${NOT_NEGATED}(?:identify|recogni[sz]e)\\s+(?:the |that |this |a |any |every |each )?(?:${PERSON}|people|faces?|individuals?)\\b`,
      ),
      re(`\\bwhat (?:does|did) (?:he|she|the (?:${PERSON}|${STAFF})) look like\\b`),
    ],
  ],
  [
    "private_person",
    [
      re(
        `\\b(?:my|his|her|their|our|your)\\s+${REL}\\s+(?:is\\s+|was\\s+|are\\s+)?(?:still\\s+)?(?:at|in|inside|there|here|home|with|working|going|leaving|arriving|around|out|currently)\\b`,
      ),
      re(`\\b(?:${PERSON}|someone|somebody|${STAFF})\\s+named\\b`),
      /\b(?:[Ii]s|whether|if)\s+[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:still\s+)?(?:on shift|on duty|at work)\b/,
      re(`\\bwho(?:'s| is| was)\\s+(?:that|this)\\s+${PERSON}\\b`),
      re("\\bwhat(?:'s| is) (?:his|her) (?:name|phone|number|address)\\b"),
      re(
        `\\b(?:find|get|learn|tell me) (?:out )?(?:his|her|the ${PERSON}'s) (?:name|identity|phone|number|instagram|age)\\b`,
      ),
      re(`\\bidentity of (?:the|that|this|a) ${PERSON}\\b`),
      re("\\b(?:a specific|this particular|a particular) (?:person|man|woman|individual)\\b"),
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
