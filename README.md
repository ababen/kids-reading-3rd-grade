# Story Spark

A small reading practice app for elementary readers. Six original passages pair fantasy, mysteries, and nature nonfiction with four comprehension questions each. Designed as an initial prototype, not a validated reading assessment.

## Run

Serve this folder with any static server, for example `python3 -m http.server 8000`, then open http://localhost:8000. No install, backend, API key, or build step is needed.

## Experience

Two independent reader profiles can be named in Grown-up corner. Children choose a story, read it, answer four questions, and choose a creative ending or drawing prompt. Incorrect answers and optional hints highlight the supporting paragraph. The text stays available throughout the questions. Completion awards one unique badge per story, without timers or sibling rankings.

The parent view separates first-try answers without hints from assisted answers, groups results by comprehension skill, shows recent completions, and exports JSON. Repeat story attempts are included and clearly disclosed. Names and progress are stored only in localStorage in the current browser. They do not sync between devices. No child accounts, analytics, generated chat, or external data submission. Google Fonts is optional and falls back to system fonts.

## Content and limitations

Edit `stories.js` to add passages and questions. Question tuples contain skill, prompt, three choices, correct choice index, supporting paragraph index, and explanation. Reading levels are not calibrated. There is no automatic difficulty adaptation, speech scoring, or learning diagnosis. The parent view is navigation, not password-protected access. Closing or leaving an unfinished adventure discards its answers; completed adventures persist.

## Validation

`node --check app.js` and `node --check stories.js` check syntax. `node content-check.cjs` validates content structure and answer references. Browser QA covers reading, incorrect-answer feedback, hints, completion, and profile-specific progress.
