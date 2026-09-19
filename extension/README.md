# Voice Browser (TypeSafe)

A Chrome extension that lets you drive the browser by voice: say what you
want ("open the permissions dashboard", "click create user", "type John
Smith into the name field") and it navigates, clicks, and fills things in
for you.

## How it works

- **Side panel** hosts the mic button and runs continuous speech recognition
  (Chrome's built-in Web Speech API) so it keeps listening as you navigate.
- **Content script** (`content.js`) runs on every page, lists the visible
  interactive elements (buttons, links, inputs, etc.) as numbered
  candidates, and executes actions against them (click / type / scroll /
  submit).
- **Background service worker** (`background.js`) is the only place that
  talks to the TypeSafe API — a service worker has no `window`/`document`,
  so it's the one context isolated from any web page's own JavaScript.
  For each utterance it asks TypeSafe's Jev model two things via the
  `choice` primitive: *what action does this map to*, and *which candidate
  element (if any) does the user mean*. It does **not** ask the model to
  generate text or URLs — those are handled in plain code
  (`lib/nlu.js`), per TypeSafe's own guidance to keep exact rules,
  extraction, and execution in code and reserve the model for judgment
  calls that need real language/page understanding.

## Setup

1. Get a TypeSafe API key from your TypeSafe account.
2. In Chrome, go to `chrome://extensions`, enable **Developer mode**, then
   **Load unpacked** and select this `extension/` folder.
3. Click the extension's toolbar icon to open the side panel, then the
   gear icon to open Settings, and paste in your API key. Optionally add
   named shortcuts for sites you use often (e.g. "permissions dashboard" ->
   your internal tool's URL) so you can say the name instead of a full URL.
4. Back in the side panel, click **Start listening** and grant microphone
   access when Chrome prompts you.

## Using it

Speak instructions one at a time and wait for the log entry to resolve
before the next one, e.g.:

- "Go to gmail" / "Open the permissions dashboard"
- "Click create user" / "Click sign in"
- `Type "Jane Doe" into the name field` — quoting the value is the most
  reliable way to get an exact value typed in; without quotes the
  extension falls back to stripping common command words like
  "type"/"enter"/"fill in" from the phrase.
- "Scroll to billing" / "Submit" / "Go back"

## Known limitations (first pass)

- **Value extraction is heuristic, not AI.** TypeSafe's System One model
  returns typed judgments (choice/score/yes-or-no), not generated text, so
  the exact string typed into a field comes from simple pattern matching
  in `lib/nlu.js`, not the model. Quote the value you want typed for
  reliable results.
- **One element list per turn.** The candidate list is rebuilt fresh right
  before each decision, capped at 60 visible elements, prioritizing what's
  in the current viewport. Elements that are visible but far down a very
  long page may need "scroll down" first.
- **Single active tab.** Voice commands always act on whichever tab is
  active in the current window.
- **Chrome/Chromium only**, since it relies on `webkitSpeechRecognition`
  and Manifest V3 side panels.
- Not tested against real sites/mic input yet in this session (built in a
  headless environment without a real Chrome UI or microphone) — please
  load it unpacked and try it against a couple of real pages, especially
  ones with framework-controlled inputs (React/Vue forms), and report back
  anything that misfires.

## Development

Pure logic (`lib/nlu.js`, `lib/typesafe.js`) has real unit tests, runnable
with plain Node (no build step, no browser needed):

```sh
node --test extension/test/*.test.js
```

`content.js`, `background.js`, `sidepanel.js`, and `options.js` need a real
Chrome instance to exercise (DOM, `chrome.*` APIs, microphone) and aren't
covered by these tests.
