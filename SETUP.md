# Setting up "Our Farm Story"

Three things to do, in this order. None of them need coding — just clicking through a couple of Google/Vercel screens. Budget ~20 minutes total.

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
   - Under **Authorized JavaScript origins**, you'll add your real web address from Step 3 below (you can come back and edit this after deploying).
   - Copy the **Client ID** — paste it into the app as `GOOGLE_CLIENT_ID`.

## 3. Get an Anthropic API key (powers the "clean this up" step)
1. Go to https://console.anthropic.com, sign in, go to **API Keys**, create one.
2. Copy it — paste it into the app as `ANTHROPIC_API_KEY`.
3. This key will be visible in the page's source code. That's fine for a private, sign-in-gated family app — just don't share the link publicly. You can regenerate the key anytime if needed.

## 4. Fill in the config and deploy
1. Open `index.html`, find the `CONFIG` block near the bottom, and paste in the three values above.
2. Deploy it for free with **Vercel** (easiest):
   - Go to https://vercel.com, sign up, click **Add New > Project > Deploy without a Git repo** (drag-and-drop the `index.html` file), or push it to a GitHub repo and import it.
   - You'll get a URL like `https://our-farm-story.vercel.app`.
3. Go back to Google Cloud Console → your OAuth Client ID → add that exact URL under **Authorized JavaScript origins**. Save.
4. Reload the app at that URL and sign in.

## 5. Add it to your dad's home screen
- **iPhone:** open the link in Safari → tap the Share icon → **Add to Home Screen**.
- **Android:** open the link in Chrome → tap the ⋮ menu → **Add to Home screen**.

From then on it opens like a regular app, full-screen, no browser bar.

## Notes
- Everyone signs in with their own Google account (once added as a test user in Step 2). All entries and files land in the same shared Drive folder.
- Voice-to-text works best in Chrome (Android, desktop) and Safari (iPhone). If a browser doesn't support it, the app just falls back to typing.
- If Google shows an "unverified app" warning during sign-in, that's expected for a small private app — click **Advanced > Go to Our Farm Story (unsafe)**. It's safe; it's just not been through Google's public app review, which isn't needed for a family tool.
- When adding a memory, there's a **Year** field alongside the Date on the review screen (and on Edit) — that's what actually controls where the entry lands on the timeline. The AI's guess pre-fills it, but fix it if it's wrong or blank; the Date field next to it is just the text shown on the page.
