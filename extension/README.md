# Voice Browser (TypeSafe)

A Chrome extension that lets you drive the browser by voice: say what you
want ("open the permissions dashboard", "click create user", "type John
Smith into the name field") and it navigates, clicks, and fills things in
for you.

## How it works

- **Side panel** hosts the mic button and runs continuous speech recognition
  (Chrome's built-in Web Speech API) so it keeps listening as you navigate.
  It also speaks results back (Speech Synthesis) so you don't have to
  watch the panel, and can record a sequence of spoken commands as a
  reusable **macro**.
- **Content script** (`content.js`) runs in every frame of every page
  (including open shadow roots), lists the visible interactive elements as
  numbered candidates, and executes actions against them (click / type /
  scroll / submit).
- **Background service worker** (`background.js`) is the only place that
  holds API keys — a service worker has no `window`/`document`, so it's the
  one context isolated from any web page's own JavaScript. For each
  utterance it asks TypeSafe's Jev model, via the `choice` primitive,
  *what action does this map to* and *which candidate element (if any) does
  the user mean* — across every frame on the page, aggregated with
  frame-routed ids so an iframe'd element can be targeted like any other.
  It does **not** ask Jev to generate text or URLs — that's handled either
  in plain code (`lib/nlu.js`) or, when a typed value genuinely needs
  composing rather than extracting, by a small fallback call to Claude
  Haiku (`lib/anthropic.js`).

### Confirmation before risky actions

Before acting, `assessRisk()` (`lib/nlu.js`) checks the target element's
label and the transcript against a list of destructive-sounding keywords
(delete, revoke, cancel, charge, ...) and the model's own reported
confidence. If either looks risky, the extension asks out loud ("Just to
confirm — click 'Delete user'? Say yes or no.") instead of acting
immediately, and only proceeds on a clear "yes". Pending confirmations are
kept in `chrome.storage.session` rather than in-memory, so they survive the
background service worker being recycled while you're deciding.

### Macros

Tap **Record macro** in the side panel, speak each step, tap again to stop,
and give it a name. Saying that name later replays every step through the
same decide-then-act pipeline, waiting for each page to finish loading
before the next step. If a step needs confirmation mid-macro, it pauses and
asks — the macro resumes from wherever it left off once you answer.

### Undo

"Undo" restores the previous value of the last field you typed into
(tracked in the content script independent of the per-turn candidate ids,
so it survives the "undo" utterance's own state refresh) or, if nothing was
typed, falls back to going back in browser history.

### Push-to-talk

A keyboard shortcut (default `Ctrl+Shift+Space` / `Cmd+Shift+Space` on Mac,
changeable at `chrome://extensions/shortcuts`) opens the side panel and
toggles listening without touching the mouse.

## Setup

1. Get a TypeSafe API key from your TypeSafe account, and (optionally, for
   the Haiku text-composition fallback) an Anthropic API key.
2. In Chrome, go to `chrome://extensions`, enable **Developer mode**, then
   **Load unpacked** and select this `extension/` folder.
3. Click the extension's toolbar icon to open the side panel, then the
   gear icon to open Settings, and paste in your key(s). Optionally add
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
  reliable way to get an exact literal typed in; without quotes, the
  extension first tries pattern matching, and if that doesn't yield a
  clean value and an Anthropic key is configured, asks Haiku to compose
  one from the field's label and what you said.
- "Scroll to billing" / "Submit" / "Go back" / "Undo"
- Say a saved macro's name to replay every step you recorded for it.
- On a risky-sounding action, answer the spoken confirmation with "yes" or
  "no" — anything else is treated as cancelling and a fresh instruction.

## Known limitations

- **Exact value extraction without Haiku is heuristic.** TypeSafe's System
  One model returns typed judgments (choice/score/yes-or-no), not
  generated text, so without an Anthropic key configured, the exact string
  typed into a field comes from simple pattern matching in `lib/nlu.js`.
  Quote the value you want typed for guaranteed-reliable results either way.
- **Closed shadow roots are invisible.** Open shadow roots are traversed;
  closed ones have no way to be reached from outside the component.
- **Cross-origin iframes without a reachable content script** (rare, but
  possible under strict CSPs) are skipped when aggregating candidates.
- **Undo only covers the last typed value** (or falls back to browser
  back); it doesn't generically reverse a click's side effects.
- **One element list per turn.** The candidate list is rebuilt fresh right
  before each decision, capped at 60 visible elements across all frames,
  prioritizing what's in the current viewport. Elements far down a very
  long page may need "scroll down" first.
- **Single active tab.** Voice commands always act on whichever tab is
  active in the current window.
- **Chrome/Chromium only**, since it relies on `webkitSpeechRecognition`
  and Manifest V3 side panels.
- Not tested against real sites/mic input yet in this session (built in a
  headless environment without a real Chrome UI or microphone) — please
  load it unpacked and try it against a couple of real pages, especially
  ones with framework-controlled inputs (React/Vue forms) and any iframes
  or shadow DOM, and report back anything that misfires.

## Development

Pure logic (`lib/nlu.js`, `lib/typesafe.js`, `lib/anthropic.js`) has real
unit tests, runnable with plain Node (no build step, no browser needed):

```sh
node --test extension/test/*.test.js
```

`content.js`, `background.js`, `sidepanel.js`, and `options.js` need a real
Chrome instance to exercise (DOM, `chrome.*` APIs, microphone, speech
synthesis) and aren't covered by these tests.
