// How a scenario reads on the board: its name, and one row per clause.
//
// A transcribed OpenSpec scenario arrives as one prose line — `Scenario: <name> - **WHEN**
// … - **THEN** … - **AND** …` — with the host's `scenario_clauses` split beside it. The
// clauses alone lost two things a reader needs: the scenario's NAME (the regex that split
// them starts at WHEN, so everything before it fell off) and the clause boundaries inside
// each half (a `- **AND**` ran into the clause before it as `… - AND …`). Rai, 2026-09-08:
// "the given/when/then of the expanded view is again unreadable / unusable."
//
// So the row grammar is read off the text itself, under the source's own keywords, and
// the host's condition/response pair is the fallback for a scenario written without
// them (an EARS line, a seat-authored paragraph). Nothing here invents a word: the
// keywords are the ones the file used, title-cased, and Trigger/Outcome only ever label
// the pair the host already split.

export interface ScenarioRow {
  /** The clause's own keyword — `When`, `Then`, `And` — or `Trigger`/`Outcome` for the
   *  host-split fallback. */
  readonly keyword: string;
  /** `condition` / `response` for the fallback pair; the lower-cased keyword otherwise. */
  readonly clause: string;
  readonly text: string;
}

export interface ScenarioReading {
  readonly name?: string;
  readonly rows: readonly ScenarioRow[];
}

const KEYWORDS = "GIVEN|WHEN|THEN|AND|BUT|IF|WHILE|WHERE";
/** A clause boundary: a list dash followed by an UPPER-CASE keyword, optionally bolded.
 *  Case-sensitive on purpose — an "and" inside a sentence is not a clause. */
const CLAUSE_BOUNDARY = new RegExp(`\\s*-\\s+(?=\\*{0,2}(?:${KEYWORDS})\\*{0,2}\\b)`);
const CLAUSE_START = new RegExp(`^\\*{0,2}(${KEYWORDS})\\*{0,2}:?\\s+`);
const NAME_PREFIX = new RegExp(
  `^Scenario:\\s*(.+?)(?=\\s+-\\s+\\*{0,2}(?:${KEYWORDS})\\*{0,2}\\b|$)`,
);

function titleCase(keyword: string): string {
  return keyword.charAt(0) + keyword.slice(1).toLowerCase();
}

export function readScenario(
  markdown: string,
  clauses?: { readonly condition: string; readonly response: string },
): ScenarioReading {
  const flat = markdown.replace(/\s+/g, " ").trim();
  const named = NAME_PREFIX.exec(flat);
  const name = named?.[1]?.trim();
  const body = named === null ? flat : flat.slice(named[0].length);
  const rows = body
    .split(CLAUSE_BOUNDARY)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const start = CLAUSE_START.exec(part);
      if (start === null || start[1] === undefined) return undefined;
      return {
        keyword: titleCase(start[1]),
        clause: start[1].toLowerCase(),
        text: part.slice(start[0].length).trim(),
      };
    });
  const keyed = rows.filter((row): row is ScenarioRow => row !== undefined);
  // Two or more keyword rows is the source's own structure. One is a sentence that starts
  // with a keyword, which the host's condition/response split reads better when it has it.
  if (keyed.length === rows.length && keyed.length >= 2) {
    return name === undefined || name.length === 0 ? { rows: keyed } : { name, rows: keyed };
  }
  if (clauses !== undefined) {
    const pair: ScenarioRow[] = [
      { keyword: "Trigger", clause: "condition", text: clauses.condition },
      { keyword: "Outcome", clause: "response", text: clauses.response },
    ];
    return name === undefined || name.length === 0 ? { rows: pair } : { name, rows: pair };
  }
  return { rows: [] };
}
