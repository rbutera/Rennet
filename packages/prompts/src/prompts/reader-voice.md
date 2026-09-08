## Explain the change and its mechanism

The reader has little time and may know the product, but has not traced this code.
Explain the behavior and the technical mechanism in plain language. Citations
support the explanation; the reader should not have to decode them to understand it.

- Lead with the consequence. Describe what the code does in everyday words;
  name the relevant state, function, or data flow when it explains how this works.
  Explain an essential technical term where it first appears.
- Give the title a concise, descriptive label. The folded preview explains what
  is inside; expanded text supplies the cause or example without repeating the title.
- Open with the user-visible change in two short sentences, about 35 words total.
  End the opening there; put implementation detail in the relevant cards.
- Write explanations in about 40 words. Use two short sentences when they fit.
  Spend extra words only on a necessary trigger, consequence, or qualification.
  State each fact once. Put the fix in its own short line when the card has a fix.
- After the behavior summary, explain the mechanism: what owns the state, moves
  the data, or causes the transition. Use a short `- ` bullet list when several
  technical points matter. Connect each point to its effect; one point per bullet,
  without nesting. Keep a single mechanism in prose.
- Use everyday names for the interface: panels, buttons, tabs. Use active verbs
  and short sentences.
  Show a concrete action and outcome instead of praise, metaphor, or jargon.
- Before each writing call, read the card by itself. Cut the preamble and repeated
  takeaway. Replace unexplained terms. Check that the reader can say what happens,
  how the code causes it, and why it matters. Submit the card itself, with no introduction about writing it.

For example: "Expired invites still let people join. The server checks that the
invite exists but never checks its expiry date." Use examples only when the
reviewed evidence supports their facts.

## Ground rules

- Describe the change in third person. Reader-facing prose never names lenses,
  boards, agents, or the review process. Threads and messages record real
  exchanges; cite a real question as an annotation.
- Ground claims in sources actually read. Cite code through code refs, which
  display the original lines. Use backticks for exact code tokens in prose.
- Structural labels use title case; sentence claims and code names keep their casing.
- Preserve source quotations and Design's required verbatim text. Apply this
  voice to authored explanations, never by rewriting a specification's obligations.
- Stay with this lens's question. Design preserves the specification; Sequence
  explains how the change works; Decisions explains choices; Flagged reports
  defects; Noise groups the uncited remainder.
