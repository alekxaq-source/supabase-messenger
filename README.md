# Messenger (Supabase)

A real-time messenger built with plain HTML, CSS and JS and backed by Supabase.

## Features
- Sign up and log in with email and password
- Search users by username or display name
- Direct chats (1:1) and group chats
- Real-time message delivery through Supabase Realtime
- Edit and delete your own messages
- File and image attachments (Supabase Storage, bucket `attachments`)
- Unread message counters
- Online status (Presence) and "typing…" indicator (Broadcast)
- Browser notifications
- Mobile layout

## Run locally
There is no build step. Serve the folder with any static server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open http://localhost:8080 (or the address `serve` prints).

> Opening `index.html` directly as a file (`file://`) will not work, because ES modules need to be served over http.

## Deploy
This is a static site, so it works on GitHub Pages, Vercel, Netlify or Cloudflare Pages.
For GitHub Pages: Settings → Pages → Deploy from branch → `main` / root.

After deploying, add your site's URL in Supabase:
**Authentication → URL Configuration → Site URL / Redirect URLs**.
The email-confirmation links use these URLs.

## Backend (already set up)
Supabase project `messenger` (ref `ubyfjnwplxavuirzejad`, eu-central-1). It contains:

**Tables**
- `profiles`
- `conversations`
- `conversation_members`
- `messages`

**Access control**
- RLS: users can only see chats they are a member of.

**RPC functions**
- `get_or_create_dm(other_user)`
- `create_group(group_title, member_ids)`

**Triggers**
- Create a profile when a user signs up
- Update `last_message_at` when a message is sent

**Realtime**
- Enabled on `messages`, `conversations` and `conversation_members`

The keys are in `config.js`. The publishable key is safe to expose in the browser, because data access is controlled by RLS.

## Quick testing
By default, Supabase requires email confirmation. To test quickly, turn it off:
**Authentication → Sign In / Providers → Email → Confirm email = off**.
