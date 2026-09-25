# Messenger (Supabase)

A real-time messenger built with plain HTML, CSS and JS and backed by Supabase.

## Features

**Profile**
- Change your avatar (upload or remove a photo)
- Change your display name and your **ID (@username)**; availability is checked live as you type
- Add an "About" bio
- Copy your internal account ID
- View other people's profiles: avatar, bio, online status and "last seen"

**Chats**
- Direct chats (1:1) and group chats
- Group settings: rename the group, add members, leave the group
- Delete a direct chat from your own list
- Search users by name or @id
- Unread counters, including a counter in the browser tab title

**Messages**
- Real-time delivery
- Replies (quote a message and jump to the original)
- Emoji reactions: 👍 ❤️ 😂 😮 😢 🔥 👎 🎉
- Read receipts: ✓ sent, ✓✓ read
- Edit your messages (or press ↑ in an empty input to edit the last one), delete them, copy text
- Files and images: attach button, drag and drop, or paste with Ctrl+V
- Links are clickable
- Search messages inside a chat, with highlighting
- Multi-line messages: Enter sends, Shift+Enter adds a new line

**Other**
- Online status and "typing…" indicator
- Browser notifications
- Light and dark themes
- Mobile layout (tap a message to show its actions)

## Run locally

Serve the folder with any static server:

```bash
python3 -m http.server 8080
```

Then open **http://localhost:8080**. Don't use 0.0.0.0: Chrome blocks it.

## Backend

Supabase project `messenger` (ref `ubyfjnwplxavuirzejad`).

**Tables**
- `profiles`
- `conversations`
- `conversation_members`
- `messages`
- `message_reactions`

**Storage buckets**
- `attachments`
- `avatars`

**Access control**
- RLS is enabled on every table.

**RPC functions**
- `get_or_create_dm`
- `create_group`
- `add_group_members`
- `username_available`
