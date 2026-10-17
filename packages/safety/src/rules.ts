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
const SOMEONE = `(?:him|her|them|someone|somebody|anyone|(?:my|his|her|their) ${REL}|that ${PERSON}|the (?:${PERSON}|${STAFF}))`;
const POSS = "(?:his|her|someone's|somebody's|a person's|(?:my|his|her|their|our) [a-z-]+'s)";
const HOME =
  "(?:house|home|apartment|apt|condo|townhouse|residence|bedroom|backyard|back yard|front yard|driveway|porch|mailbox)";
const VEHICLE = "(?:car|truck|van|suv|vehicle|motorcycle|motorbike|scooter|tesla|honda|toyota|bmw)";
const PHOTO = "(?:photo|photograph|picture|pic|snap|shot|film|record|video|selfie|close-?up)(?:s|ed|ing)?";

const re = (source: string) => new RegExp(source, "i");

const RULES: [SafetyCategory, RegExp[]][] = [
  [
    "illegal_or_dangerous",
    [
      re("\\b(?:bombs?|explosives?|grenades?|molotov|ied)\\b"),
      re("\\b(?:cocaine|heroin|meth|methamphetamine|fentanyl|mdma|drug deal(?:er|ers|ing)?)\\b"),
      re("\\b(?:buy|score|get me|cop)\\s+(?:some\\s+)?drugs\\b"),
      re(
        "\\b(?:buy|purchase|sell|get me)\\b(?:\\s+\\w+){0,3}?\\s+(?:a |some )?(?:ghost guns?|stolen \\w+|fake ids?)\\b",
      ),
      re(
        "\\b(?:bring|carry|plant|hide|stash|deliver|drop off|leave|sneak|smuggle)\\b(?:\\s+\\w+){0,3}?\\s+(?:a |an |the |some )?(?:guns?|firearms?|pistols?|rifles?|handguns?|weapons?|knife|knives|ammo|ammunition)\\b",
      ),
      re("\\b(?<!(?:a|any|no|the|lunch) )br(?:eak|eaking|oke)\\s+in(?:to)?\\b"),
      re("\\b(?:burglar\\w*|shoplift\\w*|pickpocket\\w*|robbing|robbery|vandali[sz]\\w*|lock ?pick\\w*)\\b"),
      re("\\b(?<!a )(?:steal|stealing|stole)\\b"),
      re(
        "\\b(?:pick|picking|jimmy|force|forcing)\\s+(?:open\\s+)?(?:the|a|their|his|her)\\s+(?:lock|door|window)s?\\b",
      ),
      re(
        "\\b(?:kill|murder|stab|assault|attack|beat up|hurt|harm|kidnap|abduct|threaten|intimidate|harass|confront|punch)\\s+(?:him|her|them|someone|somebody|anyone|the|that|this|my|his|their)\\b",
      ),
      re("\\bshoot\\s+(?:him|her|them|someone|somebody|at)\\b"),
      re("\\b(?:arson|set fire to|burn (?:it|the \\w+) down)\\b"),
      re(
        "\\b(?:walk|stand|step|climb|get|jump)\\s+(?:on|onto|down onto|into|down to)\\s+(?:the\\s+)?(?:\\w+\\s+)?tracks\\b",
      ),
      re(
        "\\b(?:walk|stand|step|run|wander)\\s+(?:into|in the middle of|on|onto|across)\\s+(?:the\\s+)?(?:traffic|freeway|highway|interstate)\\b",
      ),
      re(
        "\\b(?:climb|scale|climbing|scaling)\\s+(?:up\\s+|onto\\s+|on\\s+)?(?:the|a)\\s+(?:\\w+\\s+){0,3}(?:bridge|tower|roof|scaffold\\w*|crane|billboard|pole)\\b",
      ),
      re("\\b(?:counterfeit|bribe|bribing|smuggl\\w+|traffick\\w+|money launder\\w*)\\b"),
      re("\\b(?:(?:sneak|get|go) in without paying|jump the turnstile|fare evasion|dine and dash)\\b"),
    ],
  ],
  [
    "following",
    [
      re(
        `\\b(?:follow|following|followed|tail|tailing|shadow|shadowing)\\s+(?:${SOMEONE}|the (?:car|vehicle|truck|van)|a (?:${PERSON}|car))\\b`,
      ),
      re("\\bstalk(?:ing|ed|er|ers)?\\b"),
      re("\\bspy(?:ing)? on\\b"),
      re("\\b(?:stake ?out|surveil\\w*)\\b"),
      re(`\\bkeep (?:an eye|tabs|watch) on (?:${SOMEONE}|their (?:house|home|kids?)|the (?:house|car))\\b`),
      re(
        `\\b(?:track|tracking|trace|locate|locating|monitor|monitoring|watch|watching|observe|observing)\\s+(?:${SOMEONE}|his|their (?:house|home|apartment|car|kids?|movements)|the (?:house|home|apartment|car)|who (?:comes|goes|enters|leaves|visits)|down)\\b`,
      ),
      re(
        "\\b(?:his|her|someone's|somebody's)\\s+(?:whereabouts|movements|schedule|routine|location|comings and goings)\\b",
      ),
      re("\\btheir (?:whereabouts|movements|comings and goings)\\b"),
      re(
        `\\b(?:when|what time) (?:does|did|will|do) (?:he|she|(?:my|his|her) ${REL}) (?:leave|arrive|get|come|go|head)\\b`,
      ),
      re(
        `\\b(?:find out|figure out|see|check|tell me|report|let me know) where (?:he|she|(?:my|his|her) ${REL}|that ${PERSON}) (?:is|was|goes|went|lives?)\\b`,
      ),
      re(`\\bwhere (?:is|was) (?:he|she|(?:my|his|her) ${REL})\\b`),
      re(
        "\\b(?:log|record|note|note down|write down|list) (?:everyone|everybody|who|anyone) (?:who )?(?:enters|leaves|comes|goes|visits|walks)\\b",
      ),
    ],
  ],
  [
    "private_property",
    [
      re("\\b(?:private property|trespass\\w*)\\b"),
      re(
        "\\b(?:hop|hopping|jump|jumping|climb|climbing|scale|scaling|get over|go over)\\s+(?:over\\s+)?(?:the|a|their|his|her)\\s+(?:fence|wall|gate)\\b",
      ),
      re(
        `\\b(?:inside|into|enter|entering|go in|get in|let yourself in|look in|look into|peek in|peek into|peer in|peer into|through)\\s+(?:the\\s+)?(?:windows?\\s+of\\s+)?(?:${POSS}|their|a private|the private|the neighbou?r's)\\s+(?:house|home|apartment|condo|bedroom|backyard|back yard|yard|garage|room|unit|property|basement|shed)\\b`,
      ),
      re(
        "\\b(?:look|peek|peer|see)\\s+(?:in|into|through)\\s+(?:his|her|someone's|somebody's)\\s+windows?\\b",
      ),
      re("\\bsneak(?:ing)? (?:in|into|inside)\\b"),
      re("\\b(?:employees?|staff)[- ]only\\b"),
      re("\\b(?:enter|into|inside|access)\\s+(?:the|a)\\s+restricted area\\b"),
      re("\\b(?:gated community|private (?:land|road|estate|driveway))\\b"),
    ],
  ],
  [
    "vehicle",
    [
      re("\\b(?:license|licence|registration|number|tag)\\s+plates?\\b"),
      re("\\bplate (?:number|numbers|#)\\b"),
      re("\\bread (?:the|his|her|their|its) plates?\\b"),
      /\bVIN\b/,
      re(
        `\\b${POSS}\\s+(?:(?!food\\b)[a-z]+\\s+)?${VEHICLE}\\b(?!\\s+(?:park|wash|lot|rental|dealership|share|repair|shop|stop)\\b)`,
      ),
      re(`\\b(?:whose|which) ${VEHICLE}\\b`),
      re(`\\b${VEHICLE}\\s+(?:belongs to|belonging to|registered to|owned by)\\b`),
      re(`\\bwho (?:owns|drives) (?:the|that|this) ${VEHICLE}\\b`),
    ],
  ],
  [
    "private_residence",
    [
      re(
        `\\b(?!(?:it|that|what|there|here|who|he|she|let|where|everyone|today|tonight)'s)(?:${POSS}|their|[a-z]+'s)\\s+${HOME}\\b(?!\\s+(?:stadium|field|court|arena|games?|page|turf|depot|goods|improvement|cooking|made|style|store|section|department|decor|furnishings))`,
      ),
      re("\\b(?:home|house|residential|mailing) address\\b"),
      re(
        "\\bwhere (?:(?:does|do|did) .{1,40}? (?:live|reside|stay)|is .{1,40}? (?:living|residing|staying))\\b",
      ),
      re("\\bwho (?:lives|is living|is staying|stays|resides)\\b(?!\\s+open)"),
      re("\\b(?:apartment|apt\\.?)\\s*(?:#|no\\.?|number)?\\s*\\d+[a-z]?\\b"),
      re("\\b(?:house|residence|condo|townhouse)\\b.*(?:\\bunit\\s*|#\\s*)\\d+"),
      re("\\bthe [a-z]+ (?:family )?(?:residence|household|family home)\\b(?!\\s+inn)"),
      re("\\b(?:private|residential) (?:homes?|houses?|residences?|address|property)\\b"),
      re("\\bis (?:anyone|anybody|someone|somebody|he|she) (?:at )?home\\b"),
      re("\\b(?:the|a|this|that|his|her|their|my) (?:house|home|residence) (?:at|on|number) \\d"),
      re("\\bdriveway\\b"),
    ],
  ],
  [
    "identifiable_people",
    [
      re(
        `\\b${PHOTO}(?:\\s+(?:of|showing|capturing))?\\s+(?:(?!no\\b|not\\b|without\\b|any\\b)\\w+\\s+){0,2}?(?:faces?|him|her|everyone|everybody|someone|somebody|that ${PERSON}|the (?:${PERSON}|${STAFF})(?!\\s+(?:counter|desk|station|area|section|window|stand|booth|entrance|door|line|menu|sign|board|register)))\\b`,
      ),
      re(
        `\\b(?:identify|recogni[sz]e)\\s+(?:the |that |this |a |any |every |each )?(?:${PERSON}|people|customers?|employees?|faces?|individuals?|who)\\b`,
      ),
      re("\\b(?:facial|face) recognition\\b"),
      re(`\\bwhat (?:does|did) (?:he|she|the (?:${PERSON}|${STAFF})) look like\\b`),
    ],
  ],
  [
    "private_person",
    [
      re(
        `\\b(?:my|his|her|their|our|your)\\s+${REL}\\s+(?:is\\s+|was\\s+|are\\s+)?(?:still\\s+)?(?:at|in|inside|there|here|home|with|working|going|leaving|arriving|around|out|currently)\\b`,
      ),
      re(`\\b(?:${PERSON}|someone|somebody|${STAFF})\\s+(?:named|called)\\b`),
      /\b(?:[Ii]s|whether|if)\s+[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:still\s+)?(?:at home|home|on shift|on duty|at work)\b/,
      re(`\\bwho(?:'s| is| was)\\s+(?:that|this)\\s+${PERSON}\\b`),
      re("\\bwhat(?:'s| is) (?:his|her|their) (?:name|phone|number|address)\\b"),
      re(
        `\\b(?:find|get|learn|tell me) (?:out )?(?:his|her|the (?:${PERSON}|${STAFF})'s) (?:name|identity|phone|number|instagram|age)\\b`,
      ),
      re("\\bidentity of\\b"),
      re("\\b(?:a specific|this particular|a particular) (?:person|man|woman|individual)\\b"),
    ],
  ],
];

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/\s+/g, " ");

export function checkRules(input: SafetyInput): SafetyVerdict {
  const texts = [input.question, input.place_label].map(normalize);
  for (const [category, patterns] of RULES) {
    if (patterns.some((p) => texts.some((t) => p.test(t)))) return block(category, "rules");
  }
  return { allowed: true, category: null, reason: null, fix: null, layer: "rules" };
}
