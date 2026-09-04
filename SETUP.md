# Setting up "Our Farm Story"

Four things to do, in this order. None of them need coding — just clicking through a couple of Google/Vercel screens. Budget ~25 minutes total.

## 1. Create the shared Drive folder
1. In Google Drive, make a new folder — e.g. "Farm Story".
2. Share it with everyone in the family who should be able to add memories (Editor access).
3. Open the folder, look at the URL: `https://drive.google.com/drive/folders/THIS_PART_IS_THE_ID`
4. Copy that ID — you'll paste it into the app as `DRIVE_FOLDER_ID`.

## 2. Get a Google OAuth Client ID (lets people sign in with Google)
1. Go to https://console.cloud.google.com and create a new project (any name, e.g. "Farm Story").
2. In the search bar, go to **APIs & Services > Library**, search "Google Drive API", click **Enable**.
3. Go to **APIs & Services > OAuth consent screen**.
   - User type: External.
   - Fill in app name ("Our Farm Story"), your email, save through the steps.
   - Under **Test users**, add the Gmail address of every family member who'll use the app. (This keeps it private — only these people can sign in, and you skip Google's app-review process.)
4. Go to **APIs & Services > Credentials > Create Credentials > OAuth client ID**.
   - Application type: **Web application**.
   - Under **Authorized JavaScript origins**, you'll add your real web address from Step 4 below (you can come back and edit this after deploying).
   - Copy the **Client ID** — paste it into `index.html`'s `CONFIG` block as `GOOGLE_CLIENT_ID`.

   A Client ID is safe to leave in the page's source — it's meant to be public. Google enforces access by the "Authorized JavaScript origins" list and the Test users list, not by keeping the ID secret.

## 3. Get an Anthropic API key (powers the "clean this up" step)
1. Go to https://console.anthropic.com, sign in, go to **API Keys**, create one.
2. **Do not paste it into `index.html`.** Unlike the Google Client ID, this key is a real secret — anyone who got it could rack up charges on your account. It goes into Vercel's environment variables in Step 4 instead, where the browser never sees it. The app calls a small server function (`/api/cleanup.js`) that holds the key and talks to Anthropic on the app's behalf.

## 4. Deploy on Vercel — and this is also how you get a preview
Because the app now includes that small server function, it has to be deployed as a real Vercel *project* connected to this GitHub repo (not a drag-and-drop of a single file — that only works for pure static files).

1. Go to https://vercel.com and sign up/log in (GitHub login is easiest).
2. **Add New… → Project → Import Git Repository**, and pick this repo (`hello-world`).
3. Before clicking Deploy, expand **Environment Variables** and add:
   - `ANTHROPIC_API_KEY` = the key from Step 3.
4. Click **Deploy**. You'll get a URL like `https://our-farm-story.vercel.app` — that's your live app.
5. Go back to Google Cloud Console → your OAuth Client ID → add that exact URL under **Authorized JavaScript origins**. Save.
6. Open `index.html` in this repo, fill in `GOOGLE_CLIENT_ID` and `DRIVE_FOLDER_ID` in the `CONFIG` block, commit, and push. Vercel redeploys automatically in about a minute.

**This is also your answer for "how do I see a preview":** once the repo is connected to Vercel (step 2 above), *every* push — including this pull request — automatically gets its own live preview URL. Vercel posts it as a check/comment right on the PR, and it's listed under the "Deployments" tab of your Vercel project. You don't need to do anything extra per-change; just push, wait ~30-60 seconds, and open the preview link. The `ANTHROPIC_API_KEY` environment variable you set in step 3 above applies to preview deployments too, so the "clean this up" step works in previews, not just the production URL.

Until `GOOGLE_CLIENT_ID` / `DRIVE_FOLDER_ID` are filled in, any preview will load fine but show a "Not set up yet" note on the sign-in screen — that's expected, not a bug.

## 5. Add it to your dad's home screen
- **iPhone:** open the link in Safari → tap the Share icon → **Add to Home Screen**.
- **Android:** open the link in Chrome → tap the ⋮ menu → **Add to Home screen**.

From then on it opens like a regular app, full-screen, no browser bar.

## Notes
- Everyone signs in with their own Google account (once added as a test user in Step 2). All entries and files land in the same shared Drive folder.
- Voice-to-text works best in Chrome (Android, desktop) and Safari (iPhone). If a browser doesn't support it, the app just falls back to typing.
- If Google shows an "unverified app" warning during sign-in, that's expected for a small private app — click **Advanced > Go to Our Farm Story (unsafe)**. It's safe; it's just not been through Google's public app review, which isn't needed for a family tool.
- When adding a memory, there's a **Year** field alongside the Date on the review screen (and on Edit) — that's what actually controls where the entry lands on the timeline. The AI's guess pre-fills it, but fix it if it's wrong or blank; the Date field next to it is just the text shown on the page.
- Local development (optional, only if you want to run it on your own machine before pushing): install the Vercel CLI (`npm i -g vercel`), copy `.env.example` to `.env.local` and fill in your real key there, then run `vercel dev`. `.env.local` is already git-ignored so it can never get committed by accident.
