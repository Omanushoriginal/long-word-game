# Longword

A real-time word game for solo play and multiplayer rooms. Everyone in a room gets the same shuffled rack and guesses at the same time from their own device. Rooms can be public or private, host-configured for 1–20 rounds and 15 seconds–5 minutes per round, and score by word length or placement.

The browser app is hosted by GitHub Pages. Supabase provides persistent room storage and Realtime updates, while an Edge Function checks words and controls room actions. Oxford API credentials stay on the server side in Supabase secrets.

## Create a Supabase project

1. Create a project at [database.new](https://database.new). Save the database password somewhere private; it is needed when linking the CLI.
2. In the project dashboard, open **Project Settings → API Keys** and copy the **Project URL** and the publishable key named **default** (older projects may call this the `anon` key). The app's Edge Function endpoint requires the default key; a separately named publishable key will be rejected.
3. Put those two public values in `supabase-config.js`. It is safe for this file to be served publicly. Never put a secret key, service-role key, or database password in it or in GitHub.
4. Install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), then from this repository run:

   ```sh
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   supabase db push
   supabase functions deploy dynamic-worker
   ```

   The project ref is the subdomain in the Project URL, before `.supabase.co`.

5. To verify words with Oxford, set the API credentials as Supabase secrets and redeploy the function:

   ```sh
   supabase secrets set OXFORD_APP_ID=your-app-id OXFORD_APP_KEY=your-app-key
   supabase functions deploy rooms
   ```

   Without Oxford credentials, the function labels the game as sample-word mode and checks against its bundled demonstration list. Oxford API access and the English dataset are required for live Oxford verification.

## Run locally

For the original Node.js development server, use Node.js 20 or later:

```sh
npm start
```

Open [http://localhost:4173](http://localhost:4173). This local server uses in-memory rooms; it is useful for trying the interface, but it does not share rooms across separate deployments.

## Publish the website

The included GitHub Actions workflow publishes the static app to GitHub Pages whenever changes are pushed to `main`. In the repository, open **Settings → Pages** and choose **GitHub Actions** as the publishing source. The site will appear at `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/` after the workflow finishes. Supabase setup above is still needed for online multiplayer.

## Game and security notes

- Rooms support up to 12 players; all players submit simultaneously.
- Public rooms appear in the lobby. Private rooms require the room code or invite link.
- The database denies direct browser table access. The Edge Function uses the private service-role key on the server and issues each player a random room token; only its hash is stored in the database.
- Supabase Realtime broadcasts room changes. Clients fetch room state through the function using their player token.
- Each round reveals the source word when time ends. Words must be at least 8 letters and must be constructible from the rack.
- Oxford Dictionaries API data is a different product from the Oxford English Dictionary.

## License

No license is included. Add one if you want to grant others permission to reuse or modify the code.
