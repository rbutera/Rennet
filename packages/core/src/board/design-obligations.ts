export type DesignSourceFormat = "openspec" | "kiro" | "bmad" | "superpowers" | "grill-with-docs";

export interface DesignSource {
  readonly format?: DesignSourceFormat;
  readonly role: string;
  readonly path: string;
  readonly text: string;
}

export type SuperpowersProgressMarker =
  | { readonly kind: "plan-binding"; readonly planPath: string }
  | { readonly kind: "task-complete"; readonly taskId: string }
  | { readonly kind: "task-fix-round"; readonly taskId: string }
  | { readonly kind: "task-minor"; readonly taskId: string }
  | { readonly kind: "ruling" }
  | { readonly kind: "other" };

export type SuperpowersProgressEntry = SuperpowersProgressMarker & { readonly line: number };

export interface SuperpowersProgressLedger {
  readonly planPath: string;
  readonly entries: readonly SuperpowersProgressEntry[];
}

export interface ScenarioClauses {
  readonly condition: string;
  readonly response: string;
}

export interface DesignTaskManifest {
  readonly files: readonly {
    readonly operation: "create" | "modify" | "test";
    readonly value: string;
  }[];
  readonly interfaces: readonly {
    readonly direction: "consumes" | "produces";
    readonly value: string;
  }[];
  readonly verifications: readonly {
    readonly run: string;
    readonly expected: string;
  }[];
}

interface RequirementSourceMetadata {
  readonly label?: string;
  readonly capability?: string;
  readonly capabilityTitle?: string;
  readonly groupTitle?: string;
  readonly status?: string;
}

interface TaskSourceMetadata {
  readonly groupTitle?: string;
  readonly requirementRefs?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly manifest?: DesignTaskManifest;
}

interface ObligationBase {
  readonly key: string;
  readonly parentKey: string;
  readonly address: string;
  readonly text: string;
  readonly line: number;
}

export type DesignSourceObligation =
  | (ObligationBase & { readonly kind: "requirement" } & RequirementSourceMetadata)
  | (ObligationBase & { readonly kind: "scenario"; readonly clauses?: ScenarioClauses })
  | (ObligationBase & {
      readonly kind: "decision";
      readonly rationale?: string;
      readonly alternatives?: readonly string[];
      readonly evidence?: readonly {
        readonly path: string;
        readonly startLine: number;
        readonly endLine: number;
      }[];
      readonly sourceCells?: readonly string[];
    })
  | (ObligationBase & { readonly kind: "task"; readonly done: boolean } & TaskSourceMetadata)
  | (ObligationBase & {
      readonly kind: "source-section";
      readonly section: "current" | "expected" | "unchanged";
      readonly heading: string;
    })
  | (ObligationBase & {
      readonly kind: "glossary-term";
      readonly term: string;
      readonly definition: string;
      readonly avoid: readonly string[];
      readonly groupTitle?: string;
    })
  | (ObligationBase & {
      readonly kind: "progress-entry";
      readonly entry: SuperpowersProgressMarker;
    });

interface Heading {
  readonly level: number;
  readonly title: string;
  readonly index: number;
  readonly line: number;
}

interface PreparedSource {
  readonly format?: DesignSourceFormat;
  readonly role: string;
  readonly path: string;
  readonly lines: readonly string[];
  readonly headings: readonly Heading[];
}

interface Checkbox {
  readonly body: string;
  readonly done: boolean;
  readonly indent: number;
  readonly text: string;
  readonly line: number;
}

interface NumberedItem {
  readonly id: string;
  readonly text: string;
  readonly line: number;
}

const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim();

function repoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function slug(text: string): string {
  const value = text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value.length > 0 ? value : "untitled";
}

function displaySlug(text: string): string {
  return text
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function allocate(base: string, counts: Map<string, number>): string {
  const count = (counts.get(base) ?? 0) + 1;
  counts.set(base, count);
  return count === 1 ? base : `${base}~${count}`;
}

function sourceKey(source: PreparedSource, address: string): string {
  return `${source.path}#${address}`;
}

function requirement(
  source: PreparedSource,
  address: string,
  parentAddress: string,
  text: string,
  line: number,
  metadata: RequirementSourceMetadata = {},
): DesignSourceObligation {
  return {
    kind: "requirement",
    key: sourceKey(source, address),
    parentKey: sourceKey(source, parentAddress),
    address,
    text: normalizeText(text),
    line,
    ...metadata,
  };
}

function scenario(
  source: PreparedSource,
  address: string,
  parentAddress: string,
  text: string,
  line: number,
): DesignSourceObligation {
  const normalized = normalizeText(text);
  const clauses = scenarioClauses(normalized);
  return {
    kind: "scenario",
    key: sourceKey(source, address),
    parentKey: sourceKey(source, parentAddress),
    address,
    text: normalized,
    line,
    ...(clauses === undefined ? {} : { clauses }),
  };
}

function scenarioClauses(text: string): ScenarioClauses | undefined {
  const plain = text.replace(/\*\*/g, "");
  const then = /\b(?:WHEN|IF|WHILE|WHERE)\b\s+(.+?)(?:\s+-)?\s+\bTHEN\b\s+(.+)$/i.exec(plain);
  if (then !== null) {
    const condition = normalizeText(then[1] ?? "").replace(/\s+-$/, "");
    const response = normalizeText(then[2] ?? "");
    return condition.length > 0 && response.length > 0 ? { condition, response } : undefined;
  }
  const ears = /\b(?:WHEN|IF|WHILE|WHERE)\b\s+(.+?),\s+(.+\bSHALL\b.+)$/i.exec(plain);
  if (ears !== null) {
    const condition = normalizeText(ears[1] ?? "");
    const response = normalizeText(ears[2] ?? "");
    return condition.length > 0 && response.length > 0 ? { condition, response } : undefined;
  }
  const trigger = /\b(?:WHEN|IF|WHILE|WHERE)\b\s+/i.exec(plain);
  if (trigger === null) return undefined;
  const body = plain.slice(trigger.index + trigger[0].length);
  const upper = body.toUpperCase();
  const shallIndex = upper.indexOf(" SHALL ");
  const responseIndex = shallIndex < 0 ? -1 : upper.lastIndexOf(" THE ", shallIndex);
  if (responseIndex < 0) return undefined;
  const condition = normalizeText(body.slice(0, responseIndex));
  const response = normalizeText(body.slice(responseIndex + 1));
  return condition.length > 0 && response.length > 0 ? { condition, response } : undefined;
}

function task(
  source: PreparedSource,
  address: string,
  parentAddress: string,
  checkbox: Checkbox,
  metadata: TaskSourceMetadata = {},
): DesignSourceObligation {
  return {
    kind: "task",
    key: sourceKey(source, address),
    parentKey: sourceKey(source, parentAddress),
    address,
    text: checkbox.text,
    line: checkbox.line,
    done: checkbox.done,
    ...metadata,
  };
}

function decision(
  source: PreparedSource,
  address: string,
  parentAddress: string,
  text: string,
  line: number,
  rationale?: string,
  alternatives?: readonly string[],
  evidence?: readonly {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
  }[],
  sourceCells?: readonly string[],
): DesignSourceObligation {
  const normalizedRationale = rationale === undefined ? undefined : normalizeText(rationale);
  return {
    kind: "decision",
    key: sourceKey(source, address),
    parentKey: sourceKey(source, parentAddress),
    address,
    text: normalizeText(text),
    line,
    ...(normalizedRationale === undefined || normalizedRationale.length === 0
      ? {}
      : { rationale: normalizedRationale }),
    ...(alternatives === undefined ? {} : { alternatives: alternatives.map(normalizeText) }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(sourceCells === undefined ? {} : { sourceCells: sourceCells.map(normalizeText) }),
  };
}

function sourceSection(
  source: PreparedSource,
  address: string,
  section: "current" | "expected" | "unchanged",
  heading: string,
  text: string,
  line: number,
): DesignSourceObligation {
  return {
    kind: "source-section",
    key: sourceKey(source, address),
    parentKey: sourceKey(source, "bugfix"),
    address,
    section,
    heading,
    text: normalizeText(text),
    line,
  };
}

function glossaryTerm(
  source: PreparedSource,
  address: string,
  parentAddress: string,
  text: string,
  line: number,
  term: string,
  definition: string,
  avoid: readonly string[],
  groupTitle?: string,
): DesignSourceObligation {
  return {
    kind: "glossary-term",
    key: sourceKey(source, address),
    parentKey: sourceKey(source, parentAddress),
    address,
    text: normalizeText(text),
    line,
    term: normalizeText(term),
    definition: normalizeText(definition),
    avoid: avoid.map(normalizeText),
    ...(groupTitle === undefined ? {} : { groupTitle }),
  };
}

function visibleMarkdownLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let fenceMarker: string | undefined;

  return lines.map((line) => {
    const opening = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMarker === undefined && opening !== undefined) {
      fenceMarker = opening;
      return "";
    }
    if (fenceMarker !== undefined) {
      if (line.trimStart().startsWith(fenceMarker)) fenceMarker = undefined;
      return "";
    }
    return line;
  });
}

function markdownHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(lines[index] ?? "");
    const hashes = match?.[1];
    const title = match?.[2];
    if (hashes === undefined || title === undefined) continue;
    headings.push({ level: hashes.length, title: title.trim(), index, line: index + 1 });
  }
  return headings;
}

function prepare(source: DesignSource): PreparedSource {
  const lines = visibleMarkdownLines(source.text);
  return {
    ...(source.format === undefined ? {} : { format: source.format }),
    role: source.role.toLowerCase(),
    path: repoPath(source.path),
    lines,
    headings: markdownHeadings(lines),
  };
}

function sectionEnd(source: PreparedSource, heading: Heading): number {
  return (
    source.headings.find(
      (candidate) => candidate.index > heading.index && candidate.level <= heading.level,
    )?.index ?? source.lines.length
  );
}

function textBetween(source: PreparedSource, start: number, end: number): string {
  return normalizeText(
    source.lines
      .slice(start, end)
      .filter((line) => {
        const trimmed = line.trim();
        return (
          trimmed.length > 0 && !/^#{1,6}\s+/.test(trimmed) && !/^([-*_])\1{2,}$/.test(trimmed)
        );
      })
      .map((line) => line.trim())
      .join(" "),
  );
}

function checkboxes(source: PreparedSource, start = 0, end = source.lines.length): Checkbox[] {
  const found: Checkbox[] = [];
  for (let index = start; index < end; index += 1) {
    const line = source.lines[index] ?? "";
    const match = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    found.push({
      body: normalizeText(match[3] ?? ""),
      done: (match[2] ?? "").toLowerCase() === "x",
      indent: (match[1] ?? "").length,
      text: normalizeText(line.trim()),
      line: index + 1,
    });
  }
  return found;
}

function numberedItems(source: PreparedSource, start: number, end: number): NumberedItem[] {
  const items: NumberedItem[] = [];
  let current: { id: string; parts: string[]; line: number } | undefined;
  const pushCurrent = (): void => {
    if (current === undefined) return;
    items.push({
      id: current.id,
      text: normalizeText(current.parts.join(" ")),
      line: current.line,
    });
    current = undefined;
  };

  for (let index = start; index < end; index += 1) {
    const line = source.lines[index] ?? "";
    const item = /^\s*(\d+)[.):]\s+(.+?)\s*$/.exec(line);
    if (item !== null) {
      pushCurrent();
      current = { id: item[1] ?? "", parts: [item[2] ?? ""], line: index + 1 };
      continue;
    }
    if (current !== undefined && /^\s+\S/.test(line) && !/^\s*#{1,6}\s+/.test(line)) {
      current.parts.push(line.trim());
      continue;
    }
    if (line.trim().length > 0) pushCurrent();
  }
  pushCurrent();
  return items;
}

function formatOf(source: PreparedSource): DesignSourceFormat | undefined {
  if (source.format !== undefined) return source.format;
  const lowerPath = source.path.toLowerCase();
  if (["context-map", "context", "adr"].includes(source.role)) return "grill-with-docs";
  if (["prd", "architecture", "epic", "story"].includes(source.role)) return "bmad";
  if (["requirements", "bugfix"].includes(source.role)) return "kiro";
  if (["plan", "progress"].includes(source.role)) return "superpowers";
  if (["proposal", "spec-delta"].includes(source.role)) return "openspec";
  if (lowerPath.startsWith("openspec/")) return "openspec";
  if (lowerPath.startsWith(".kiro/specs/")) return "kiro";
  if (lowerPath.includes("/superpowers/") || lowerPath.startsWith(".superpowers/")) {
    return "superpowers";
  }
  return undefined;
}

function leadingNumber(text: string): string | undefined {
  return /^(\d+(?:\.\d+)*)[.)]?\s+/.exec(text.replace(/^\*\*/, ""))?.[1];
}

function namedNumber(text: string, name: "Step" | "Task" | "Subtask"): string | undefined {
  const match = new RegExp(`^(?:\\*\\*)?${name}\\s+(\\d+(?:\\.\\d+)*)\\b`, "i").exec(text);
  return match?.[1];
}

function parseOpenSpecRequirements(source: PreparedSource): DesignSourceObligation[] {
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  const capability = /(?:^|\/)specs\/([^/]+)\/spec\.md$/i.exec(source.path)?.[1];
  const requirementHeadings = source.headings.filter(
    (heading) => heading.level === 3 && /^Requirement:\s*\S/i.test(heading.title),
  );

  for (const heading of requirementHeadings) {
    const name = heading.title.replace(/^Requirement:\s*/i, "").trim();
    const address = allocate(`requirement:${slug(name)}`, addresses);
    const end = sectionEnd(source, heading);
    const scenarioHeadings = source.headings.filter(
      (candidate) =>
        candidate.index > heading.index &&
        candidate.index < end &&
        candidate.level === 4 &&
        /^Scenario:\s*\S/i.test(candidate.title),
    );
    const statementEnd = scenarioHeadings[0]?.index ?? end;
    const statement = textBetween(source, heading.index + 1, statementEnd);
    const operationHeading = [...source.headings]
      .reverse()
      .find((candidate) => candidate.level === 2 && candidate.index < heading.index);
    const operation = /^(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\b/i.exec(
      operationHeading?.title ?? "",
    )?.[1];
    const parentAddress =
      operation === undefined ? "requirements" : `requirements:${operation.toLowerCase()}`;

    if (statement.length > 0) {
      obligations.push(
        requirement(source, address, parentAddress, statement, heading.line, {
          label: name,
          ...(capability === undefined
            ? {}
            : { capability, capabilityTitle: displaySlug(capability) }),
          ...(operation === undefined || operationHeading === undefined
            ? {}
            : { groupTitle: operationHeading.title }),
        }),
      );
    }

    const scenarioAddresses = new Map<string, number>();
    for (const scenarioHeading of scenarioHeadings) {
      const scenarioName = scenarioHeading.title.replace(/^Scenario:\s*/i, "").trim();
      const childAddress = allocate(`${address}/scenario:${slug(scenarioName)}`, scenarioAddresses);
      const scenarioText = textBetween(
        source,
        scenarioHeading.index + 1,
        sectionEnd(source, scenarioHeading),
      );
      obligations.push(
        scenario(
          source,
          childAddress,
          address,
          `Scenario: ${scenarioName}${scenarioText.length > 0 ? ` ${scenarioText}` : ""}`,
          scenarioHeading.line,
        ),
      );
    }
  }
  return obligations;
}

function parseOpenSpecTasks(source: PreparedSource): DesignSourceObligation[] {
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  const groupHeadings = source.headings.filter((heading) => heading.level === 2);
  const found = checkboxes(source);

  for (const [index, checkbox] of found.entries()) {
    const sourceIndex = checkbox.line - 1;
    const groupHeading = [...groupHeadings]
      .reverse()
      .find((heading) => heading.index < sourceIndex);
    const groupId = leadingNumber(groupHeading?.title ?? "") ?? slug(groupHeading?.title ?? "root");
    const parentAddress = `task-group:${groupId}`;
    const itemId = leadingNumber(checkbox.body) ?? `step-${index + 1}`;
    const address = allocate(`${parentAddress}/task:${itemId}`, addresses);
    obligations.push(
      task(source, address, parentAddress, checkbox, {
        ...(groupHeading === undefined ? {} : { groupTitle: groupHeading.title }),
      }),
    );
  }
  return obligations;
}

function paragraphs(source: PreparedSource, start: number, end: number): NumberedItem[] {
  const found: NumberedItem[] = [];
  let parts: string[] = [];
  let line = 0;
  const push = (): void => {
    if (parts.length === 0) return;
    found.push({ id: String(found.length + 1), text: normalizeText(parts.join(" ")), line });
    parts = [];
  };

  for (let index = start; index < end; index += 1) {
    const value = source.lines[index] ?? "";
    if (value.trim().length === 0 || /^\s*#{1,6}\s+/.test(value)) {
      push();
      continue;
    }
    if (parts.length === 0) line = index + 1;
    parts.push(value.trim());
  }
  push();
  return found;
}

type DecisionField = "why" | "alternatives" | "evidence";

function decisionField(value: string): DecisionField | undefined {
  const normalized = normalizeText(value.replace(/[*_:]/g, " ")).toLowerCase();
  if (normalized === "why" || normalized === "rationale") return "why";
  if (
    normalized === "alternatives" ||
    normalized === "alternatives not taken" ||
    normalized === "alternatives considered"
  ) {
    return "alternatives";
  }
  return normalized === "evidence" ? "evidence" : undefined;
}

function decisionFieldLabel(
  line: string,
): { readonly field: DecisionField; readonly value: string } | undefined {
  const match = /^\s*(?:[-*+]\s+)?(?:\*\*)?(.+?)(?:(?::\*\*)|(?:\*\*:)|:)\s*(.*?)\s*$/.exec(line);
  if (match === null) return undefined;
  const field = decisionField(match[1] ?? "");
  return field === undefined ? undefined : { field, value: match[2] ?? "" };
}

function decisionFieldItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  let continuation: string[] = [];
  const push = (): void => {
    const value = normalizeText(continuation.join(" "));
    if (value.length > 0) items.push(value);
    continuation = [];
  };
  for (const line of lines) {
    const item = /^\s*[-*+]\s+(.+?)\s*$/.exec(line)?.[1];
    if (item !== undefined) {
      push();
      continuation = [item];
      continue;
    }
    if (line.trim().length === 0) {
      push();
      continue;
    }
    continuation.push(line.trim());
  }
  push();
  return items;
}

function parseDecisionFields(
  source: PreparedSource,
  heading: Heading,
): {
  readonly rationale?: string;
  readonly alternatives: readonly string[];
  readonly evidence: readonly {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
  }[];
} {
  const end = sectionEnd(source, heading);
  const fields: Record<DecisionField, string[]> = { why: [], alternatives: [], evidence: [] };
  const unlabelled: string[] = [];
  let active: DecisionField | undefined;
  let explicit = false;

  for (let index = heading.index + 1; index < end; index += 1) {
    const line = source.lines[index] ?? "";
    const childHeading = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
    const headingField = childHeading === undefined ? undefined : decisionField(childHeading);
    if (headingField !== undefined) {
      active = headingField;
      explicit = true;
      continue;
    }
    const label = decisionFieldLabel(line);
    if (label !== undefined) {
      active = label.field;
      explicit = true;
      if (label.value.length > 0) fields[active].push(label.value);
      continue;
    }
    if (active === undefined) unlabelled.push(line);
    else fields[active].push(line);
  }

  const rationale = normalizeText(
    (explicit ? [...unlabelled, ...fields.why] : unlabelled).join(" "),
  );
  const evidenceText = fields.evidence.join(" ");
  const evidence = [
    ...evidenceText.matchAll(/(?:^|[\s`(])([A-Za-z0-9_.@/-]+):(\d+)(?:-(\d+))?/g),
  ].map((match) => ({
    path: match[1] ?? "",
    startLine: Number(match[2]),
    endLine: Number(match[3] ?? match[2]),
  }));
  return {
    ...(rationale.length === 0 ? {} : { rationale }),
    alternatives: decisionFieldItems(fields.alternatives),
    evidence,
  };
}

function parseStatedDecisions(source: PreparedSource): DesignSourceObligation[] {
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  const decisionSections = source.headings.filter(
    (heading) => heading.level === 2 && /^Decisions\b/i.test(heading.title),
  );

  for (const section of decisionSections) {
    const end = sectionEnd(source, section);
    const childHeadings = source.headings.filter(
      (heading) => heading.level === 3 && heading.index > section.index && heading.index < end,
    );
    const units: readonly {
      readonly text: string;
      readonly line: number;
      readonly heading?: Heading;
      readonly rationale?: string;
    }[] =
      childHeadings.length > 0
        ? childHeadings.map((heading) => ({
            heading,
            text: heading.title.replace(/^Decision:\s*/i, ""),
            line: heading.line,
          }))
        : paragraphs(source, section.index + 1, end).map((paragraph) => {
            const boldLead = /^\*\*(.+?)\*\*\s*(.*)$/.exec(paragraph.text);
            const statement = boldLead?.[1] ?? paragraph.text;
            const rationale = normalizeText(boldLead?.[2] ?? "");
            return {
              text: statement,
              line: paragraph.line,
              ...(rationale.length === 0 ? {} : { rationale }),
            };
          });

    for (const unit of units) {
      const address = allocate(`decisions/decision:${slug(unit.text)}`, addresses);
      const fields =
        unit.heading === undefined ? undefined : parseDecisionFields(source, unit.heading);
      obligations.push(
        decision(
          source,
          address,
          "decisions",
          unit.text,
          unit.line,
          fields?.rationale ?? unit.rationale,
          fields?.alternatives,
          fields?.evidence,
        ),
      );
    }
  }
  return obligations;
}

function explicitDecisionHeading(title: string): string | undefined {
  const labelled = /^(?:Decision|Choice|Selected approach):\s*(\S(?:.*\S)?)$/i.exec(title)?.[1];
  if (labelled !== undefined) return labelled;
  const critical = /^(.*?)\s*\(CRITICAL DECISION\)\s*$/i.exec(title)?.[1];
  const normalized = normalizeText(critical ?? "");
  return normalized.length === 0 ? undefined : normalized;
}

function explicitDecisionSections(
  source: PreparedSource,
  sectionTitle: RegExp,
): DesignSourceObligation[] {
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  const sections = source.headings.filter(
    (heading) => heading.level === 2 && sectionTitle.test(heading.title),
  );

  for (const section of sections) {
    const end = sectionEnd(source, section);
    const headingChoices = source.headings.filter(
      (heading) =>
        heading.index > section.index &&
        heading.index < end &&
        heading.level > section.level &&
        explicitDecisionHeading(heading.title) !== undefined,
    );
    for (const heading of headingChoices) {
      const statement = explicitDecisionHeading(heading.title);
      if (statement === undefined) continue;
      const address = allocate(
        `choices/${slug(section.title)}/decision:${slug(statement)}`,
        addresses,
      );
      const fields = parseDecisionFields(source, heading);
      obligations.push(
        decision(
          source,
          address,
          `choices/${slug(section.title)}`,
          statement,
          heading.line,
          fields.rationale,
          fields.alternatives,
          fields.evidence,
        ),
      );
    }
  }
  return obligations.sort((left, right) => left.line - right.line);
}

function parseKiroDesignDecisions(source: PreparedSource): DesignSourceObligation[] {
  return [
    ...parseStatedDecisions(source),
    ...explicitDecisionSections(
      source,
      /^(?:Architecture|Components and Interfaces|Data Models|Error Handling|Testing Strategy)$/i,
    ),
  ].sort((left, right) => left.line - right.line);
}

function parseBmadArchitectureDecisions(source: PreparedSource): DesignSourceObligation[] {
  return [
    ...parseStatedDecisions(source),
    ...parseBmadTechStackChoices(source),
    ...explicitDecisionSections(
      source,
      /^(?:Architecture|High Level Architecture|Tech Stack|Data Models|Components|External APIs|Core Workflows|Database Schema|Infrastructure and Deployment|Error Handling Strategy|Security|Service Architecture)$/i,
    ),
  ].sort((left, right) => left.line - right.line);
}

function parseBmadTechnicalAssumptionChoices(source: PreparedSource): DesignSourceObligation[] {
  const section = source.headings.find(
    (heading) => heading.level === 2 && /^Technical Assumptions$/i.test(heading.title),
  );
  if (section === undefined) return [];
  const allowed = new Set(["repository structure", "service architecture", "testing requirements"]);
  const addresses = new Map<string, number>();
  const obligations: DesignSourceObligation[] = [];
  for (let index = section.index + 1; index < sectionEnd(source, section); index += 1) {
    const match =
      /^\s*(?:[-*+]\s+)?\*\*(.+?):\*\*\s*(\S(?:.*\S)?)\s*$/.exec(source.lines[index] ?? "") ??
      /^\s*(?:[-*+]\s+)?\*\*(.+?)\*\*:\s*(\S(?:.*\S)?)\s*$/.exec(source.lines[index] ?? "");
    if (match === null) continue;
    const label = normalizeText(match[1] ?? "");
    const value = normalizeText(match[2] ?? "");
    if (!allowed.has(label.toLowerCase()) || value.length === 0) continue;
    const statement = `${label}: ${value}`;
    const address = allocate(`choices/technical-assumptions/decision:${slug(label)}`, addresses);
    obligations.push(
      decision(source, address, "choices/technical-assumptions", statement, index + 1),
    );
  }
  return obligations;
}

function parseBmadTechStackChoices(source: PreparedSource): DesignSourceObligation[] {
  const section = source.headings.find(
    (heading) => heading.level === 2 && /^Tech Stack$/i.test(heading.title),
  );
  if (section === undefined) return [];
  const rows = source.lines
    .slice(section.index + 1, sectionEnd(source, section))
    .map((line, offset) => ({ line, index: section.index + 1 + offset }))
    .filter(({ line }) => /^\s*\|.*\|\s*$/.test(line));
  if (rows.length < 3 || !/\bTechnology\b/i.test(rows[0]?.line ?? "")) return [];
  const headers = (rows[0]?.line ?? "").split("|").slice(1, -1).map(normalizeText);
  const rationaleIndex = headers.findIndex((header) => /^Rationale$/i.test(header));
  const addresses = new Map<string, number>();
  return rows.slice(2).flatMap(({ line, index }) => {
    const cells = line.split("|").slice(1, -1).map(normalizeText);
    if (cells.length === 0 || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return [];
    const statementCells = cells.filter((_, cellIndex) => cellIndex !== rationaleIndex);
    const statement = statementCells.join(" · ");
    const rationale = rationaleIndex < 0 ? undefined : cells[rationaleIndex];
    const address = allocate(
      `choices/tech-stack/decision:${slug(cells[0] ?? statement)}`,
      addresses,
    );
    return [
      decision(
        source,
        address,
        "choices/tech-stack",
        statement,
        index + 1,
        rationale,
        undefined,
        undefined,
        cells,
      ),
    ];
  });
}

function parseSuperpowersDesignDecisions(source: PreparedSource): DesignSourceObligation[] {
  return [
    ...parseStatedDecisions(source),
    ...explicitDecisionSections(
      source,
      /^(?:Architecture|Components|Data Flow|Error Handling|Testing)$/i,
    ),
  ].sort((left, right) => left.line - right.line);
}

function parseSuperpowersPlanChoices(source: PreparedSource): DesignSourceObligation[] {
  const addresses = new Map<string, number>();
  const globalConstraints = source.headings.find(
    (heading) => heading.level === 2 && /^Global Constraints$/i.test(heading.title),
  );
  const firstTask = source.headings.find(
    (heading) => heading.level === 3 && /^Task\s+\d+(?:\.\d+)*\s*:/i.test(heading.title),
  );
  const headerEnd = Math.min(
    globalConstraints?.index ?? source.lines.length,
    firstTask?.index ?? source.lines.length,
  );
  return source.lines.slice(0, headerEnd).flatMap((line, index) => {
    const match = /^\s*\*\*(Architecture|Tech Stack):\*\*\s*(\S(?:.*\S)?)\s*$/.exec(line);
    if (match === null) return [];
    const label = match[1] ?? "";
    const statement = match[2] ?? "";
    const address = allocate(`plan-header/decision:${slug(label)}`, addresses);
    return [
      decision(
        source,
        address,
        "plan-header",
        statement,
        index + 1,
        undefined,
        undefined,
        undefined,
        [label, statement],
      ),
    ];
  });
}

function parseOpenSpec(source: PreparedSource): DesignSourceObligation[] {
  const file = source.path.split("/").at(-1)?.toLowerCase();
  if (source.role === "spec-delta" || source.role === "spec" || file === "spec.md") {
    return parseOpenSpecRequirements(source);
  }
  if (source.role === "tasks" || file === "tasks.md") return parseOpenSpecTasks(source);
  if (source.role === "design" || file === "design.md") return parseStatedDecisions(source);
  return [];
}

function parseKiroRequirements(source: PreparedSource): DesignSourceObligation[] {
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  const capability = /(?:^|\/)\.kiro\/specs\/([^/]+)\//i.exec(source.path)?.[1];
  const requirementHeadings = source.headings.filter(
    (heading) => heading.level === 3 && /^Requirement\s+\S/i.test(heading.title),
  );

  for (const heading of requirementHeadings) {
    const label = heading.title.replace(/^Requirement\s+/i, "").trim();
    const numericLabel = /^(\d+(?:\.\d+)*)\b/.exec(label)?.[1];
    const address = allocate(`requirement:${numericLabel ?? slug(label)}`, addresses);
    const end = sectionEnd(source, heading);
    const acceptanceHeading = source.headings.find(
      (candidate) =>
        candidate.index > heading.index &&
        candidate.index < end &&
        candidate.level === 4 &&
        /^Acceptance Criteria$/i.test(candidate.title),
    );
    if (acceptanceHeading === undefined) continue;
    const userStory = textBetween(source, heading.index + 1, acceptanceHeading.index);
    if (!/^\*\*User Story:\*\*\s+\S/i.test(userStory)) continue;
    const criteria = numberedItems(
      source,
      acceptanceHeading.index + 1,
      sectionEnd(source, acceptanceHeading),
    ).filter(
      (criterion) =>
        /^(WHEN|IF|WHILE|WHERE)\b/.test(criterion.text) && /\bSHALL\b/.test(criterion.text),
    );
    if (criteria.length === 0) continue;

    obligations.push(
      requirement(source, address, "requirements", userStory, heading.line, {
        label: heading.title,
        ...(capability === undefined ? {} : { capability, capabilityTitle: capability }),
      }),
    );
    for (const criterion of criteria) {
      const criterionId =
        numericLabel === undefined ? criterion.id : `${numericLabel}.${criterion.id}`;
      const childAddress = `${address}/criterion:${criterionId}`;
      obligations.push(scenario(source, childAddress, address, criterion.text, criterion.line));
    }
  }
  return obligations;
}

function parseKiroTasks(source: PreparedSource): DesignSourceObligation[] {
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  const found = checkboxes(source);
  const groupTitles = new Map<string, string>();
  for (const checkbox of found) {
    const number = leadingNumber(checkbox.body);
    if (number === undefined || number.includes(".")) continue;
    groupTitles.set(number, checkbox.body);
  }
  for (const [index, checkbox] of found.entries()) {
    const number = leadingNumber(checkbox.body);
    const groupId = number?.split(".")[0] ?? "root";
    if (!groupTitles.has(groupId)) groupTitles.set(groupId, checkbox.body);
    const parentAddress = `task-group:${groupId}`;
    const address = allocate(`${parentAddress}/task:${number ?? `step-${index + 1}`}`, addresses);
    const nextCheckboxIndex = (found[index + 1]?.line ?? source.lines.length + 1) - 1;
    const requirementRefs = source.lines.slice(checkbox.line, nextCheckboxIndex).flatMap((line) => {
      const values = /^\s*[-*+]\s+_Requirements?:\s*([^_]+)_\s*$/i.exec(line)?.[1];
      if (values === undefined) return [];
      return values.split(",").map(normalizeText).filter(Boolean);
    });
    obligations.push(
      task(source, address, parentAddress, checkbox, {
        groupTitle: groupTitles.get(groupId) ?? checkbox.body,
        ...(requirementRefs.length === 0 ? {} : { requirementRefs }),
      }),
    );
  }
  return obligations;
}

function kiroBugfixSection(heading: Heading): "current" | "expected" | "unchanged" | undefined {
  const match = /^(Current|Expected|Unchanged)\s+Behaviou?r$/i.exec(heading.title);
  const name = match?.[1]?.toLowerCase();
  if (name === "current" || name === "expected" || name === "unchanged") return name;
  return undefined;
}

function parseKiroBugfix(source: PreparedSource): DesignSourceObligation[] {
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  for (const heading of source.headings) {
    const section = kiroBugfixSection(heading);
    if (section === undefined) continue;
    const text = textBetween(source, heading.index + 1, sectionEnd(source, heading));
    if (text.length === 0) continue;
    const address = allocate(`bugfix/${section}`, addresses);
    obligations.push(sourceSection(source, address, section, heading.title, text, heading.line));
  }
  return obligations;
}

function parseKiro(source: PreparedSource): DesignSourceObligation[] {
  const file = source.path.split("/").at(-1)?.toLowerCase();
  if (source.role === "requirements" || file === "requirements.md") {
    return parseKiroRequirements(source);
  }
  if (source.role === "bugfix" || file === "bugfix.md") return parseKiroBugfix(source);
  if (source.role === "design" || file === "design.md") return parseKiroDesignDecisions(source);
  if (source.role === "tasks" || file === "tasks.md") {
    return parseKiroTasks(source);
  }
  return [];
}

function parseBmadRegistry(source: PreparedSource): DesignSourceObligation[] {
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  const requirementSections = source.headings.filter(
    (heading) => heading.level === 2 && /^Requirements$/i.test(heading.title),
  );
  for (let index = 0; index < source.lines.length; index += 1) {
    const line = source.lines[index] ?? "";
    const match = /^\s*(?:(?:[-*+] |\d+[.)] ))?((?:N?FR)\d+)\s*:\s*(.+?)\s*$/i.exec(line);
    if (match === null) continue;
    const id = (match[1] ?? "").toUpperCase();
    const text = match[2] ?? "";
    const capability = id.startsWith("NFR") ? "non-functional" : "functional";
    const requirementSection = requirementSections.find(
      (heading) => heading.index < index && index < sectionEnd(source, heading),
    );
    if (requirementSection === undefined) continue;
    const registryGroups = source.headings.filter(
      (heading) =>
        heading.level > requirementSection.level &&
        heading.index > requirementSection.index &&
        heading.index < sectionEnd(source, requirementSection) &&
        /^(?:functional|non[ -]?functional)(?: requirements)?$/i.test(heading.title),
    );
    const enclosingSubsection = [...source.headings]
      .reverse()
      .find(
        (heading) =>
          heading.level > requirementSection.level &&
          heading.index > requirementSection.index &&
          heading.index < index &&
          index < sectionEnd(source, heading),
      );
    const matchingHeading = registryGroups.find(
      (heading) =>
        heading.index < index &&
        index < sectionEnd(source, heading) &&
        (capability === "non-functional"
          ? /^non[ -]?functional(?: requirements)?$/i.test(heading.title)
          : /^(?:functional|functional requirements)$/i.test(heading.title)),
    );
    if (
      (registryGroups.length > 0 && matchingHeading === undefined) ||
      (registryGroups.length === 0 && enclosingSubsection !== undefined)
    ) {
      continue;
    }
    const address = allocate(`requirement:${id}`, addresses);
    const parentAddress = id.startsWith("NFR")
      ? "requirements:non-functional"
      : "requirements:functional";
    const capabilityTitle =
      matchingHeading?.title ??
      (capability === "non-functional" ? "Non Functional Requirements" : "Functional Requirements");
    obligations.push(
      requirement(source, address, parentAddress, text, index + 1, {
        label: id,
        capability,
        capabilityTitle,
      }),
    );
  }
  return obligations;
}

function storyId(source: PreparedSource, heading: Heading): string {
  const explicit = /^Story\s+(\d+(?:\.\d+)*)\b/i.exec(heading.title)?.[1];
  if (explicit !== undefined) return explicit;
  const titleId = source.headings
    .filter((candidate) => candidate.level === 1 && candidate.index < heading.index)
    .flatMap((candidate) => {
      const id = /^Story\s+(\d+(?:\.\d+)*)\b/i.exec(candidate.title)?.[1];
      return id === undefined ? [] : [id];
    })
    .at(-1);
  if (titleId !== undefined) return titleId;
  return /(?:^|\/)(\d+(?:\.\d+)+)[.-]/.exec(source.path)?.[1] ?? "story";
}

function storyStatement(source: PreparedSource, heading: Heading): string {
  const nextHeading = source.headings.find((candidate) => candidate.index > heading.index);
  const end = nextHeading?.index ?? source.lines.length;
  const parts: string[] = [];
  for (let index = heading.index + 1; index < end; index += 1) {
    const line = source.lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const plain = line.replace(/\*\*/g, "").trim();
    if (parts.length === 0 && !/^As a\b/i.test(plain)) continue;
    parts.push(line.trim());
  }
  return normalizeText(parts.join(" "));
}

function storySourceHeading(source: PreparedSource, heading: Heading, id: string): string {
  if (!/^Story$/i.test(heading.title)) return heading.title;
  return (
    [...source.headings]
      .reverse()
      .find(
        (candidate) =>
          candidate.level === 1 &&
          candidate.index < heading.index &&
          new RegExp(`^Story\\s+${id.replace(/\./g, "\\.")}\\b`, "i").test(candidate.title),
      )?.title ?? `Story ${id}`
  );
}

function parseBmadStories(source: PreparedSource): DesignSourceObligation[] {
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  const storyHeadings = source.headings.filter(
    (heading) =>
      heading.level > 1 &&
      (/^Story$/i.test(heading.title) || /^Story\s+\d+(?:\.\d+)*\b/i.test(heading.title)),
  );

  for (const [storyIndex, heading] of storyHeadings.entries()) {
    const id = storyId(source, heading);
    const address = allocate(`story:${id}`, addresses);
    const statement = storyStatement(source, heading);
    const nextStory = storyHeadings[storyIndex + 1];
    const storyRoot = [...source.headings]
      .reverse()
      .find(
        (candidate) =>
          candidate.level === 1 &&
          candidate.index < heading.index &&
          /^Story\s+\d+(?:\.\d+)*\b/i.test(candidate.title),
      );
    const nextStoryRoot =
      storyRoot === undefined
        ? undefined
        : source.headings.find(
            (candidate) =>
              candidate.level === 1 &&
              candidate.index > storyRoot.index &&
              /^Story\s+\d+(?:\.\d+)*\b/i.test(candidate.title),
          );
    const storyStart = storyRoot?.index ?? heading.index;
    const storyEnd = nextStoryRoot?.index ?? nextStory?.index ?? source.lines.length;
    const acceptanceHeading = source.headings.find(
      (candidate) =>
        candidate.index > heading.index &&
        candidate.index < storyEnd &&
        /^Acceptance Criteria$/i.test(candidate.title),
    );
    const statusHeading = source.headings.find(
      (candidate) =>
        candidate.index > storyStart &&
        candidate.index < storyEnd &&
        /^Status$/i.test(candidate.title),
    );
    const status =
      statusHeading === undefined
        ? undefined
        : textBetween(source, statusHeading.index + 1, sectionEnd(source, statusHeading));
    const storyLabel = storySourceHeading(source, heading, id);
    if (statement.length > 0) {
      obligations.push(
        requirement(source, address, `stories/story:${id}`, statement, heading.line, {
          label: storyLabel,
          capability: `story:${id}`,
          capabilityTitle: storyLabel,
          ...(status === undefined || status.length === 0 ? {} : { status }),
        }),
      );
    }
    if (acceptanceHeading === undefined) continue;
    for (const criterion of numberedItems(
      source,
      acceptanceHeading.index + 1,
      sectionEnd(source, acceptanceHeading),
    )) {
      const childAddress = `${address}/acceptance:${criterion.id}`;
      obligations.push(scenario(source, childAddress, address, criterion.text, criterion.line));
    }
  }
  return obligations;
}

function parseBmadTasks(source: PreparedSource): DesignSourceObligation[] {
  const section = source.headings.find((heading) => /^Tasks\s*\/\s*Subtasks$/i.test(heading.title));
  if (section === undefined) return [];
  const found = checkboxes(source, section.index + 1, sectionEnd(source, section));
  if (found.length === 0) return [];
  const minimumIndent = Math.min(...found.map((checkbox) => checkbox.indent));
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  const childCounts = new Map<string, number>();
  let parentAddress = "task-group:root";
  let groupTitle: string | undefined;

  for (const checkbox of found) {
    if (checkbox.indent === minimumIndent) {
      const groupId =
        namedNumber(checkbox.body, "Task") ??
        leadingNumber(checkbox.body) ??
        String(obligations.length + 1);
      parentAddress = `task-group:${groupId}`;
      groupTitle = checkbox.body;
      const address = allocate(`${parentAddress}/task:root`, addresses);
      const acceptanceCriteria = /\(AC:\s*([^)]+)\)/i
        .exec(checkbox.body)?.[1]
        ?.split(",")
        .map(normalizeText)
        .filter(Boolean);
      obligations.push(
        task(source, address, parentAddress, checkbox, {
          groupTitle,
          ...(acceptanceCriteria === undefined || acceptanceCriteria.length === 0
            ? {}
            : { acceptanceCriteria }),
        }),
      );
      continue;
    }
    const explicit =
      namedNumber(checkbox.body, "Subtask") ??
      namedNumber(checkbox.body, "Task") ??
      leadingNumber(checkbox.body);
    const count = (childCounts.get(parentAddress) ?? 0) + 1;
    childCounts.set(parentAddress, count);
    const address = allocate(`${parentAddress}/task:${explicit ?? `step-${count}`}`, addresses);
    const acceptanceCriteria = /\(AC:\s*([^)]+)\)/i
      .exec(checkbox.body)?.[1]
      ?.split(",")
      .map(normalizeText)
      .filter(Boolean);
    obligations.push(
      task(source, address, parentAddress, checkbox, {
        ...(groupTitle === undefined ? {} : { groupTitle }),
        ...(acceptanceCriteria === undefined || acceptanceCriteria.length === 0
          ? {}
          : { acceptanceCriteria }),
      }),
    );
  }
  return obligations;
}

function parseBmad(source: PreparedSource): DesignSourceObligation[] {
  const obligations: DesignSourceObligation[] = [];
  if (source.role === "architecture") obligations.push(...parseBmadArchitectureDecisions(source));
  if (source.role === "prd") {
    obligations.push(...parseBmadRegistry(source));
    obligations.push(...parseBmadTechnicalAssumptionChoices(source));
  }
  if (["prd", "epic", "story"].includes(source.role)) obligations.push(...parseBmadStories(source));
  if (source.role === "story") obligations.push(...parseBmadTasks(source));
  return obligations.sort((left, right) => left.line - right.line);
}

function parseSuperpowersTaskManifest(
  source: PreparedSource,
  start: number,
  end: number,
): DesignTaskManifest {
  const files: DesignTaskManifest["files"][number][] = [];
  const interfaces: DesignTaskManifest["interfaces"][number][] = [];
  const verifications: DesignTaskManifest["verifications"][number][] = [];
  let run: string | undefined;

  for (let index = start; index < end; index += 1) {
    const line = source.lines[index] ?? "";
    const file = /^\s*[-*+]\s+(Create|Modify|Test):\s*(.+?)\s*$/i.exec(line);
    if (file !== null) {
      const operation = (file[1] ?? "").toLowerCase();
      if (operation === "create" || operation === "modify" || operation === "test") {
        files.push({ operation, value: normalizeText(file[2] ?? "") });
      }
      continue;
    }
    const contract = /^\s*[-*+]\s+(Consumes|Produces):\s*(.+?)\s*$/i.exec(line);
    if (contract !== null) {
      const direction = (contract[1] ?? "").toLowerCase();
      if (direction === "consumes" || direction === "produces") {
        interfaces.push({ direction, value: normalizeText(contract[2] ?? "") });
      }
      continue;
    }
    const runLine = /^\s*Run:\s*(.+?)\s*$/i.exec(line)?.[1];
    if (runLine !== undefined) {
      run = normalizeText(runLine);
      continue;
    }
    const expected = /^\s*Expected:\s*(.+?)\s*$/i.exec(line)?.[1];
    if (expected !== undefined && run !== undefined) {
      verifications.push({ run, expected: normalizeText(expected) });
      run = undefined;
    }
  }

  return { files, interfaces, verifications };
}

function parseSuperpowers(source: PreparedSource): DesignSourceObligation[] {
  if (source.role === "progress") return parseSuperpowersProgressObligations(source);
  if (source.role === "design") return parseSuperpowersDesignDecisions(source);
  if (source.role !== "plan") return [];
  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  const taskHeadings = source.headings.filter(
    (heading) => heading.level === 3 && /^Task\s+\d+(?:\.\d+)*\s*:/i.test(heading.title),
  );

  for (const heading of taskHeadings) {
    const groupId = /^Task\s+(\d+(?:\.\d+)*)\b/i.exec(heading.title)?.[1];
    if (groupId === undefined) continue;
    const parentAddress = `task-group:${groupId}`;
    const manifest = parseSuperpowersTaskManifest(
      source,
      heading.index + 1,
      sectionEnd(source, heading),
    );
    const hasManifest =
      manifest.files.length > 0 ||
      manifest.interfaces.length > 0 ||
      manifest.verifications.length > 0;
    for (const [index, checkbox] of checkboxes(
      source,
      heading.index + 1,
      sectionEnd(source, heading),
    ).entries()) {
      const stepId = namedNumber(checkbox.body, "Step") ?? String(index + 1);
      const address = allocate(`${parentAddress}/task:step-${stepId}`, addresses);
      obligations.push(
        task(source, address, parentAddress, checkbox, {
          groupTitle: heading.title,
          ...(hasManifest && index === 0 ? { manifest } : {}),
        }),
      );
    }
  }
  return [...parseSuperpowersPlanChoices(source), ...obligations].sort(
    (left, right) => left.line - right.line,
  );
}

function superpowersProgressMarker(line: string): SuperpowersProgressMarker {
  const binding = /^# SDD ledger — plan: (\S(?:.*\S)?)$/.exec(line)?.[1];
  if (binding !== undefined) return { kind: "plan-binding", planPath: binding };
  const complete = /^Task (\d+(?:\.\d+)*): complete \(.+\)$/.exec(line)?.[1];
  if (complete !== undefined) return { kind: "task-complete", taskId: complete };
  const fixRound = /^Task (\d+(?:\.\d+)*): fix round \d+\/5 \(.+\)$/.exec(line)?.[1];
  if (fixRound !== undefined) return { kind: "task-fix-round", taskId: fixRound };
  const minor = /^Task (\d+(?:\.\d+)*): minor \(deferred\): .+$/.exec(line)?.[1];
  if (minor !== undefined) return { kind: "task-minor", taskId: minor };
  if (/^Ruling: .+$/.test(line)) return { kind: "ruling" };
  return { kind: "other" };
}

function progressAddress(marker: SuperpowersProgressMarker, line: number): string {
  switch (marker.kind) {
    case "plan-binding":
      return "progress/binding";
    case "task-complete":
      return `progress/task:${marker.taskId}/complete`;
    case "task-fix-round":
      return `progress/task:${marker.taskId}/fix-round`;
    case "task-minor":
      return `progress/task:${marker.taskId}/minor`;
    case "ruling":
      return "progress/ruling";
    case "other":
      return `progress/line:${line}`;
    default: {
      const exhaustive: never = marker;
      return exhaustive;
    }
  }
}

function parseSuperpowersProgressObligations(source: PreparedSource): DesignSourceObligation[] {
  const addresses = new Map<string, number>();
  return source.lines.flatMap((text, index) => {
    if (text.trim().length === 0) return [];
    const line = index + 1;
    const entry = superpowersProgressMarker(text);
    const address = allocate(progressAddress(entry, line), addresses);
    return [
      {
        kind: "progress-entry" as const,
        key: sourceKey(source, address),
        parentKey: sourceKey(source, "progress"),
        address,
        text: normalizeText(text),
        line,
        entry,
      },
    ];
  });
}

export function parseSuperpowersProgressLedger(
  source: DesignSource,
): SuperpowersProgressLedger | undefined {
  const prepared = prepare(source);
  if (formatOf(prepared) !== "superpowers" || prepared.role !== "progress") return undefined;
  const firstLine = prepared.lines[0];
  if (firstLine === undefined) return undefined;
  const binding = superpowersProgressMarker(firstLine);
  if (binding.kind !== "plan-binding") return undefined;
  const entries = prepared.lines.slice(1).flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    return [{ ...superpowersProgressMarker(line), line: index + 2 }];
  });
  return { planPath: binding.planPath, entries };
}

export interface CandidateDesignSource extends DesignSource {
  readonly candidate: string;
}

type TaskObligation = Extract<DesignSourceObligation, { readonly kind: "task" }>;

export interface DesignTaskProgressGroup {
  readonly parentKey: string;
  readonly id: string;
  readonly title?: string;
  readonly complete: boolean;
  readonly tasks: readonly TaskObligation[];
}

export interface DesignTaskProgressSource {
  readonly source: CandidateDesignSource;
  readonly format: DesignSourceFormat;
  readonly tasks: readonly TaskObligation[];
  readonly groups: readonly DesignTaskProgressGroup[];
  readonly done: number;
  readonly total: number;
}

export interface DesignTaskProgress {
  readonly sources: readonly DesignTaskProgressSource[];
  readonly done: number;
  readonly total: number;
}

function obligationTaskGroupId(parentKey: string): string {
  return /#task-group:(.+)$/.exec(parentKey)?.[1] ?? parentKey;
}

/** Derive source-authoritative task progress for both lint and host projection. */
export function deriveDesignTaskProgress(
  sources: readonly CandidateDesignSource[],
): DesignTaskProgress {
  const derived = sources.flatMap((source): DesignTaskProgressSource[] => {
    const format = formatOf(prepare(source));
    if (format === undefined) return [];
    const tasks = parseDesignSourceObligations(source).filter(
      (obligation): obligation is TaskObligation => obligation.kind === "task",
    );
    if (tasks.length === 0) return [];

    const completedLedgerTasks = new Set<string>();
    if (format === "superpowers" && source.role.toLowerCase() === "plan") {
      for (const progressSource of sources) {
        if (progressSource.candidate !== source.candidate) continue;
        const progressFormat = formatOf(prepare(progressSource));
        if (progressFormat !== "superpowers" || progressSource.role.toLowerCase() !== "progress") {
          continue;
        }
        const ledger = parseSuperpowersProgressLedger(progressSource);
        if (ledger?.planPath !== source.path) continue;
        for (const entry of ledger.entries) {
          if (entry.kind === "task-complete") completedLedgerTasks.add(entry.taskId);
        }
      }
    }

    const tasksByGroup = new Map<string, TaskObligation[]>();
    for (const taskObligation of tasks) {
      tasksByGroup.set(taskObligation.parentKey, [
        ...(tasksByGroup.get(taskObligation.parentKey) ?? []),
        taskObligation,
      ]);
    }
    const groups = [...tasksByGroup].map(([parentKey, groupTasks]) => {
      const id = obligationTaskGroupId(parentKey);
      return {
        parentKey,
        id,
        ...(groupTasks[0]?.groupTitle === undefined ? {} : { title: groupTasks[0].groupTitle }),
        complete:
          (format === "superpowers" &&
            source.role.toLowerCase() === "plan" &&
            completedLedgerTasks.has(id)) ||
          groupTasks.every((taskObligation) => taskObligation.done),
        tasks: groupTasks,
      };
    });
    const superpowersPlan = format === "superpowers" && source.role.toLowerCase() === "plan";
    return [
      {
        source,
        format,
        tasks,
        groups,
        done: superpowersPlan
          ? groups.filter((group) => group.complete).length
          : tasks.filter((taskObligation) => taskObligation.done).length,
        total: superpowersPlan ? groups.length : tasks.length,
      },
    ];
  });

  return {
    sources: derived,
    done: derived.reduce((count, source) => count + source.done, 0),
    total: derived.reduce((count, source) => count + source.total, 0),
  };
}

function parseGrillAdr(source: PreparedSource): DesignSourceObligation[] {
  const title = source.headings.find((heading) => heading.level === 1);
  if (title === undefined || title.title.length === 0) return [];
  const address = `decision:${slug(title.title)}`;
  const firstSection = source.headings.find(
    (heading) => heading.level === 2 && heading.index > title.index,
  );
  const rationale = textBetween(
    source,
    title.index + 1,
    firstSection?.index ?? source.lines.length,
  );
  const options = source.headings.find(
    (heading) => heading.level === 2 && /^Considered Options$/i.test(heading.title),
  );
  const alternatives =
    options === undefined
      ? []
      : decisionFieldItems(source.lines.slice(options.index + 1, sectionEnd(source, options)));
  return [
    decision(
      source,
      address,
      "artifact",
      title.title,
      title.line,
      rationale,
      alternatives.length === 0 ? undefined : alternatives,
    ),
  ];
}

function parseGlossaryTermStart(
  line: string,
): { readonly term: string; readonly definition: string } | undefined {
  const match = /^\s*(?:[-*+]\s+)?\*\*(.+?)\*\*:\s*(.*?)\s*$/.exec(line);
  if (match === null) return undefined;
  const term = normalizeText(match[1] ?? "");
  if (term.length === 0) return undefined;
  return { term, definition: normalizeText(match[2] ?? "") };
}

function parseGlossaryAvoid(line: string): readonly string[] | undefined {
  const match = /^\s*(?:[-*+]\s+)?_Avoid_:\s*(.+?)\s*$/i.exec(line);
  if (match === null) return undefined;
  const values = (match[1] ?? "")
    .split(",")
    .map(normalizeText)
    .filter((value) => value.length > 0);
  return values.length === 0 ? undefined : values;
}

function parseGrillGlossary(source: PreparedSource): DesignSourceObligation[] {
  const language = source.headings.find(
    (heading) => heading.level === 2 && /^Language$/i.test(heading.title),
  );
  if (language === undefined) return [];
  const end = sectionEnd(source, language);
  const groupHeadings = source.headings.filter(
    (heading) => heading.level === 3 && heading.index > language.index && heading.index < end,
  );
  const groupAddresses = new Map<number, string>();
  const groupCounts = new Map<string, number>();
  for (const heading of groupHeadings) {
    groupAddresses.set(
      heading.index,
      allocate(`language/group:${slug(heading.title)}`, groupCounts),
    );
  }

  const starts: { readonly index: number; readonly term: string; readonly definition: string }[] =
    [];
  for (let index = language.index + 1; index < end; index += 1) {
    const start = parseGlossaryTermStart(source.lines[index] ?? "");
    if (start !== undefined) starts.push({ index, ...start });
  }

  const obligations: DesignSourceObligation[] = [];
  const addresses = new Map<string, number>();
  for (const [position, start] of starts.entries()) {
    const nextTerm = starts[position + 1]?.index ?? end;
    const nextHeading = source.headings.find(
      (heading) => heading.index > start.index && heading.index < nextTerm,
    )?.index;
    const termEnd = nextHeading ?? nextTerm;
    let avoidIndex: number | undefined;
    let avoid: readonly string[] | undefined;
    for (let index = start.index + 1; index < termEnd; index += 1) {
      const parsed = parseGlossaryAvoid(source.lines[index] ?? "");
      if (parsed === undefined) continue;
      avoidIndex = index;
      avoid = parsed;
      break;
    }
    if (avoidIndex === undefined || avoid === undefined) continue;

    const continuation = source.lines
      .slice(start.index + 1, avoidIndex)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const definition = normalizeText([start.definition, ...continuation].join(" "));
    if (definition.length === 0) continue;
    const group = [...groupHeadings].reverse().find((heading) => heading.index < start.index);
    const parentAddress =
      group === undefined ? "language" : (groupAddresses.get(group.index) ?? "language");
    const address = allocate(`${parentAddress}/term:${slug(start.term)}`, addresses);
    const text = source.lines.slice(start.index, avoidIndex + 1).join(" ");
    obligations.push(
      glossaryTerm(
        source,
        address,
        parentAddress,
        text,
        start.index + 1,
        start.term,
        definition,
        avoid,
        group?.title,
      ),
    );
  }
  return obligations;
}

function parseGrillWithDocs(source: PreparedSource): DesignSourceObligation[] {
  const file = source.path.split("/").at(-1)?.toLowerCase();
  if (source.role === "adr") return parseGrillAdr(source);
  if (source.role === "context" || file === "context.md") return parseGrillGlossary(source);
  return [];
}

export function parseDesignSourceObligations(source: DesignSource): DesignSourceObligation[] {
  const prepared = prepare(source);
  const format = formatOf(prepared);
  switch (format) {
    case "openspec":
      return parseOpenSpec(prepared);
    case "kiro":
      return parseKiro(prepared);
    case "bmad":
      return parseBmad(prepared);
    case "superpowers":
      return parseSuperpowers(prepared);
    case "grill-with-docs":
      return parseGrillWithDocs(prepared);
    case undefined:
      return [];
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}
