# Review basket

Collect feedback on the changes an AI agent made, then hand it all back as one prompt.

## Picking changes

Each highlighted change can go in the basket: a changed block or a removal marker in markdown and `.docx`, or a run of changed lines in code and text.

- **Hover** over a change. A small **+** button appears at its top right. Click it to add the change, and click the check mark to take it out again.
- **`b`** does the same from the keyboard: it adds the change with the button, or takes it out if it is already in the basket (the toast offers **Undo**). Without a button on screen, it acts on the first change below the header. Moving to a change with **`n`** / **`p`**, or focusing something inside it, shows its buttons too.
- The copy button next to it (or **`c`**) copies just that change for AI, in the format of **Copy for AI** below, without its intro line. If the change is in the basket and has a note, the note comes along too. The basket is left as it is. Use it for a quick fix: paste it into your agent and type what to change.
- **Add all**, in the change banner, adds every change in the open file.
- In **What's new**, the list button on a file adds every change in that file without opening it.

A change that is in the basket gets a blue bar at its right edge. The same change is only added once, and it stays marked as in the basket when a later edit above it moves it to other lines.

## The basket

A count badge appears in the header once the basket holds something. Click it to open the panel. It lists the items by file, and each item shows its location:

- the heading path for markdown and `.docx` (`Setup > Install`);
- the line range and the enclosing symbol for code (`Line 12-18 · Parser > parse`). The symbol is shown once the outline is known.

File paths are relative to the git repository when the open folder is inside one (opening `repo/docs` shows `docs/setup.md`), so an agent running at the repo root finds them; otherwise they are relative to the open folder.

You can type a one-line note for each item, remove items, or **Clear** them all (with an undo).

**Copy for AI** copies one markdown prompt and then empties the basket. The toast offers **Undo**, which puts the items back. The prompt starts with an intro line. Each item then gets a heading (number, location, and whether it was added, edited or removed), a `diff` block of the old and new text, and your note. Without a note, it asks the agent to check the change. The old and new text are trimmed and capped at 60 lines each, and a line says how many lines were left out.

## Limits

- The basket lives in memory for the tab only. Nothing is saved to disk or sent to the server, so a reload empties it. It works the same in the browser and the desktop app, and in read-only and edit mode.
- JSON files are not covered, because their pretty-printed view uses a different diff. When **Since last commit** is on, the highlights and the basket follow the git comparison. Blame mode has no basket, and while the banner's **Show changes** diff is open, use **Add all** or close the diff to pick single changes.
- Hidden files (git-ignored, on the ignore list, or protected; see [Layout](layout.md#hidden-files)) have no change highlights, so they cannot go in the basket.
