import { Button, cn } from "@rennet/ui";
import { Plus } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/icon";
import type { SidebarProject } from "../../shell/sidebar-data";
import { Row, Section, Segmented } from "../atoms";
import { type GuidanceRule, type GuidanceSeverity, useSettingsProjection } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects → Guidance section (C10 §8.7, claims 669–673). The repo rules the
// review agents read, each with a severity chip. A rule edits inline (a severity
// segmented control, Save, Cancel, Delete); Enter saves and Escape closes ONLY the
// editor (never the settings takeover); an Add Rule control sits at the bottom;
// saving with empty text is refused.
//
// GUIDANCE has no live write command on this branch (only `settings.guidance` reads),
// so the whole section rides the settings projection (`setGuidance`) — one coherent
// seam, provable now, swapped to the engine's guidance write at B10. The `settings.get`
// resolver is not split across two sources for a value it cannot yet persist.
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_CHIP: Record<GuidanceSeverity, string> = {
  high: "bg-danger-soft text-danger",
  medium: "bg-accent-soft text-accent-ink",
  low: "bg-raised text-ink-soft",
};

const SEVERITY_OPTIONS = [
  { id: "high", label: "high" },
  { id: "medium", label: "medium" },
  { id: "low", label: "low" },
] as const;

export function GuidanceSection({ project }: { readonly project: SidebarProject }) {
  const projection = useSettingsProjection();
  const rules = projection.guidanceByProject[project.id] ?? [];

  return (
    <Section title="Guidance" caption={`.rennet/ in ${project.name}`}>
      <Row label="Rules" hint="repo rules the review agents read" stacked>
        <GuidanceList rules={rules} onChange={(next) => projection.setGuidance(project.id, next)} />
      </Row>
    </Section>
  );
}

function GuidanceList({
  rules,
  onChange,
}: {
  readonly rules: readonly GuidanceRule[];
  readonly onChange: (rules: readonly GuidanceRule[]) => void;
}) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftSeverity, setDraftSeverity] = useState<GuidanceSeverity>("medium");
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Take focus the moment the editor opens (the a11y-safe autofocus — a ref + effect,
  // never the `autoFocus` attribute; the host-card rename field does the same).
  useEffect(() => {
    if (editing !== null) editorRef.current?.focus();
  }, [editing]);

  function openEditor(index: number | "new") {
    const existing = index === "new" ? undefined : rules[index];
    setDraftText(existing?.rule ?? "");
    setDraftSeverity(existing?.severity ?? "medium");
    setEditing(index);
  }

  function save() {
    const text = draftText.trim();
    if (!text) return; // saving with empty text is refused
    const next: GuidanceRule = { rule: text, severity: draftSeverity };
    onChange(
      editing === "new" ? [...rules, next] : rules.map((r, i) => (i === editing ? next : r)),
    );
    setEditing(null);
  }

  function remove(index: number) {
    onChange(rules.filter((_, i) => i !== index));
    setEditing(null);
  }

  function onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Escape closes the EDITOR, not the settings takeover (the root handler).
    if (event.key === "Escape") {
      event.stopPropagation();
      setEditing(null);
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  }

  const editor = (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-raised/40 px-2.5 py-2">
      <textarea
        ref={editorRef}
        value={draftText}
        onChange={(event) => setDraftText(event.target.value)}
        onKeyDown={onEditorKeyDown}
        placeholder="State the rule…"
        rows={1}
        aria-label="Guidance rule text"
        className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-xs leading-relaxed text-ink placeholder:text-ink-faint focus-visible:border-accent-line focus-visible:outline-none"
      />
      <div className="flex items-center gap-2">
        <Segmented
          ariaLabel="Rule severity"
          options={SEVERITY_OPTIONS}
          value={draftSeverity}
          onChange={setDraftSeverity}
        />
        <div className="ml-auto flex items-center gap-1">
          {editing !== "new" && editing !== null ? (
            <Button
              variant="ghost"
              size="xs"
              className="text-danger"
              onClick={() => remove(editing)}
            >
              Delete
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button size="xs" disabled={!draftText.trim()} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-1">
      {rules.map((rule, index) =>
        editing === index ? (
          <div key={rule.rule}>{editor}</div>
        ) : (
          <div
            key={rule.rule}
            className="group flex items-center gap-2 rounded-md px-2 py-0.5 hover:bg-raised/50"
          >
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide",
                SEVERITY_CHIP[rule.severity],
              )}
            >
              {rule.severity}
            </span>
            <span className="text-xs text-ink">{rule.rule}</span>
            <button
              type="button"
              onClick={() => openEditor(index)}
              className="ml-auto hidden shrink-0 rounded px-1.5 py-0.5 text-2xs text-ink-soft hover:bg-raised hover:text-ink group-hover:block"
            >
              Edit
            </button>
          </div>
        ),
      )}
      {editing === "new" ? (
        editor
      ) : (
        <button
          type="button"
          onClick={() => openEditor("new")}
          className="flex h-7 w-fit items-center gap-1.5 rounded-md px-2 text-xs text-ink-soft transition-colors hover:bg-raised hover:text-ink"
        >
          <Icon icon={Plus} className="size-3" />
          Add Rule
        </button>
      )}
    </div>
  );
}
