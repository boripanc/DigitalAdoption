# Guidepost

An original digital adoption platform, sold as SaaS: authors record in-app walkthroughs on any web app with a Chrome extension, and the people in their workspace play them back as guided tooltips. A dashboard shows where people finish or drop off.

"Guidepost" is a working name.

| Part | Path | Stack |
| --- | --- | --- |
| Browser extension (recorder + player) | `apps/extension` | TypeScript, Chrome Manifest V3, esbuild |
| API | `apps/api` | TypeScript, Fastify, Postgres (or embedded PGlite for development) |
| Admin dashboard | `apps/dashboard` | TypeScript, React, Vite |
| Shared types | `packages/shared` | TypeScript |

| Player in the target app | Extension popup | Guide analytics |
| --- | --- | --- |
| ![Player](docs/screenshots/player-step2.png) | ![Popup](docs/screenshots/popup-editor.png) | ![Dashboard](docs/screenshots/dashboard-guide.png) |

## How it works

1. An **owner** creates a workspace in the dashboard and adds people as **editors** (write guides, see analytics) or **viewers** (end users who play guides).
2. An editor signs in to the extension, opens the target web app, names a guide and presses **Record**. Each click opens a small editor for the step's title and explanation instead of triggering the app; **Save & click** saves the step and performs the click so the author can keep going. Recording survives page navigation, and carries on into other web apps (see below).
3. **Finish** saves the guide to the API as a draft. Publishing it (in the popup or dashboard) makes it visible to viewers on that site.
4. Viewers press **Play** in the extension. The page dims, the element is highlighted, and a tooltip walks them through each step, across pages too. Clicking the highlighted element moves on.
5. Starts, step views, completions and exits are sent to the API, and the dashboard shows completion rates and the step where people quit.

Only the extension's background worker talks to the API; the page you're guiding never sees the token. All extension UI is drawn inside a Shadow DOM so the host app's styles can't break it.

## SAP Fiori and other SAPUI5 / OpenUI5 apps

Guidepost works on SAP Fiori apps, including apps opened from a Fiori launchpad. Three things make that work:

- **UI5-aware targets.** UI5 generates DOM ids such as `__button12` or `__xmlview0--save` that change between sessions and between launchpad and standalone starts. On UI5 pages a small script that runs in the page's own world (`apps/extension/src/ui5bridge.ts`) tells the recorder which control was clicked: its class (`sap.m.Button`), the stable part of its id when the developer gave it one (`detail--note`), its view, text, icon, tooltip, label and data bindings. Playback scores every visible control of that class against this description, then falls back to the CSS selector and the visible text. A click on text inside a table row records the row, and a click on a button's inner `<bdi>` records the button.
- **Launchpad iframes.** Newer launchpads open apps in an iframe. The recorder and player work in the top page and in every iframe, same-origin or not, and a step remembers which iframe it was in.
- **Hash routing.** Fiori apps change pages through the URL hash without reloading. When a step's element isn't there yet (route change, app still loading in the iframe), the player keeps looking and shows the step as soon as it appears. If UI5 re-renders the control, the highlight finds it again.

Not supported yet: SAP GUI for HTML (WebGUI) transactions, which are not UI5. SAP GUI for Windows and other desktop apps are out of reach for a browser extension.

| Recording in a Fiori app | Playback inside a launchpad iframe |
| --- | --- |
| ![Recording](docs/screenshots/fiori-recording.png) | ![Playback](docs/screenshots/fiori-launchpad-playback.png) |

`e2e/fiori` is a small Fiori-style OpenUI5 app (list, detail page, hash routes) plus a stand-in launchpad page that opens it in an iframe. `npm run fiori:serve` serves it at http://localhost:8766/index.html and http://localhost:8766/launchpad.html with UI5 Tooling, which downloads OpenUI5 from npm. Add `?shift=3` to change every generated id.

## Guides across applications

One guide can start in one web app and continue in others, on other domains and in other tabs: for example, start in the SAP Fiori launchpad, continue in SuccessFactors, finish in an internal app.

- **The guide's progress lives in the extension**, not in the page. The background worker keeps the recording or the current step (in `chrome.storage.session`), so it survives page loads, moves to another domain in the same tab, and the service worker going to sleep.
- **It follows the user into new tabs.** A tab opened from the guide's tab while the guide runs (a link with `target=_blank`, `window.open`) takes the guide over when it becomes active, and the old tab takes its UI down. During playback, switching to a tab that is already on the app of the current step does the same. Each step stores the page URL it belongs to.
- **"Take me there"** on a step in another app switches to a tab that has that app open, or opens it in a new tab.
- **The popup** shows a guide that's running in another tab (or whose tab was closed) with **Continue in this tab** and **Stop**.
- **Cross-origin iframes.** The content script runs in every frame. The top page draws all the UI and reaches same-origin iframes directly. In an iframe on another origin the script runs as an agent (`apps/extension/src/agent.ts`): it records and finds elements there and reports positions to the top page by `postMessage`, each frame adding its iframe's offset on the way up (`chain.ts`); commands go down to it through the background worker. Steps in such an iframe store its origin (`frameOrigin`), and only an iframe on that origin looks for them.

A flow is listed in the popup on the host it starts on.

| Recording continues in the second app | "Take me there" to the other app | Playback inside a cross-origin iframe |
| --- | --- | --- |
| ![Recording](docs/screenshots/crossapp-recording.png) | ![Take me there](docs/screenshots/crossapp-take-me-there.png) | ![Cross-origin iframe](docs/screenshots/crossapp-iframe-playback.png) |

`e2e/crossapp` has the two test apps: an employee portal (served on http://localhost:8771) and an expenses app (served on http://127.0.0.1:8772, another origin), plus a portal page that embeds the expenses app in a cross-origin iframe.

## Run it locally

Requires Node 20+.

```bash
npm install
npm run dev:api          # API on http://localhost:4000 (embedded database in apps/api/.pglite)
npm run dev:dashboard    # dashboard on http://localhost:5173
npm run build -w @guidepost/extension
```

Then in Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `apps/extension/dist`. Create a workspace at http://localhost:5173/#/signup and sign in to the extension with the same account. A demo app to try it on is in `e2e/demo/index.html`.

To use a real Postgres instead of the embedded database: `docker compose up -d`, then copy `apps/api/.env.example` to `apps/api/.env`.

## Tests

```bash
npm run typecheck
npm test             # API tests on an in-memory database
TEST_DATABASE_URL=postgres://… npm test -w @guidepost/api   # same tests on real Postgres
npm run build && npm run test:e2e   # full flow in Chromium: sign up, record, publish, play, analytics
npm run test:e2e:fiori              # record and play on the OpenUI5 app: standalone, in a launchpad iframe, and in a launchpad on another domain
npm run test:e2e:crossapp           # one guide across two apps on different origins: new tab, "Take me there", cross-origin iframe
```

The end-to-end test saves screenshots to `e2e/screenshots/`.

## API

All routes except `/auth/*` and `/health` need `Authorization: Bearer <token>`.

| Method | Path | Who | What |
| --- | --- | --- | --- |
| POST | `/auth/signup` | anyone | Create a workspace and its owner |
| POST | `/auth/login` | anyone | Get a token |
| GET | `/me` | member | Current user and workspace |
| GET / POST | `/members` | owner (GET: editors too) | List or add people |
| PATCH / DELETE | `/members/:id` | owner | Change role, remove |
| GET | `/flows?host=` | member | Guides (viewers see published ones only) |
| POST | `/flows` | editor | Create a guide |
| GET / PATCH / DELETE | `/flows/:id` | editor (GET: viewers for published) | Read, edit, publish, delete |
| POST | `/events` | member | Record up to 200 analytics events |
| GET | `/analytics` | editor | Starts, completions, views and exits per step |

## Roadmap

- **Now (MVP):** workspaces and roles, recorder, player, publish, analytics.
- **Next (pilot):** auto-start rules (first visit, URL match), invite links and password reset, flow versioning, Chrome Web Store listing, hosted deployment.
- **Later:** onboarding checklists, smart tips, announcements, a resource center, billing.
