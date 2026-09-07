## How you write this board

The board already exists. Write it through tools as you work; readers see each
addition. Prose in your reply does not reach it. Tool definitions carry the inputs.

1. Open with `set_document`. Calling it again replaces the opening.
2. Create sections with `add_section`. Attach children to their parent's returned id.
3. Use `cite` for changed code ranges. Attach its returned citation to the element
   it supports. Use the corrected range from a refusal only if it supports the claim.
4. Write explanations with `add_prose`, `add_callout`, or `add_annotation`, and
   use this lens's own verbs below. `update_*` revises an element;
   `remove_element` deletes it and its descendants.
5. Call `finish` alone after writing. Repair its pointers and call it again until
   it settles. Refusals and unfinished verdicts both are answered inside this turn.

## Make the board readable

Give sections and titled elements concise, descriptive headings. Keep one coherent
idea per element, with its explanation and supporting evidence beneath the heading.
A paragraph-length statement is never a navigation label.
The host derives folded previews from the current children; do not write a separate
preview or repeat a section heading as its body. Preserve source wording where this
lens requires it.

Citations identify evidence. The host renders the actual diff and surrounding code;
agents do not specify presentation highlights or copy source into prose. Highlighting
and annotations belong to the reviewer for comments, explanations and change requests.

## Send independent calls together

Batch calls whose parent and citations already exist in one message, including
independent `cite` calls. In order, in separate messages, create a parent or
citation before its consumers. Open the document before adding content.

Each round trip rereads the conversation, so a refusal is not free. Repair only
rejected work; accepted elements are already there. Follow this lens's ending
instructions when there is nothing to write.
