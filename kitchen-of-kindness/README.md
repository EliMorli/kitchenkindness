# Kitchen of Kindness - Volunteer Delivery Sign-Up

A simple web app for volunteers to sign up for food delivery slots.

## Features

- 📅 Weekly calendar view of delivery slots
- ✅ Click to claim open delivery slots
- 👥 See who's signed up for each slot
- 📊 Stats dashboard showing slots filled/open
- 🔒 Simple password protection for volunteers
- 💾 Persistent storage with Supabase

## Setup

### 1. Create Supabase Database

Go to [supabase.com](https://supabase.com) and create a new project (or use an existing one).

Run this SQL in the Supabase SQL Editor to create the table:

```sql
-- Create the delivery_assignments table
CREATE TABLE delivery_assignments (
  id BIGSERIAL PRIMARY KEY,
  slot_key TEXT UNIQUE NOT NULL,
  delivery_date DATE NOT NULL,
  family_id INTEGER NOT NULL,
  volunteer_name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create an index for faster lookups
CREATE INDEX idx_delivery_date ON delivery_assignments(delivery_date);
CREATE INDEX idx_family_id ON delivery_assignments(family_id);

-- Enable Row Level Security (optional but recommended)
ALTER TABLE delivery_assignments ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows all operations (since we have password protection)
CREATE POLICY "Allow all operations" ON delivery_assignments
  FOR ALL USING (true) WITH CHECK (true);
```

### 2. Get Your Supabase Credentials

1. Go to your Supabase project dashboard
2. Click **Settings** → **API**
3. Copy the **Project URL** and **anon public** key

### 3. Configure Environment Variables

Create a `.env.local` file in the project root:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
NEXT_PUBLIC_SITE_PASSWORD=your-chosen-password
```

### 4. Deploy to Vercel

1. Push this code to a GitHub repository
2. Go to [vercel.com](https://vercel.com)
3. Import your repository
4. Add the environment variables in Vercel's dashboard
5. Deploy!

Or use the Vercel CLI:

```bash
npm i -g vercel
vercel
```

## Local Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Customization

### Change the Password

Update `NEXT_PUBLIC_SITE_PASSWORD` in your environment variables.

### Update Families/Addresses

Edit the `families` array in `app/page.js`:

```javascript
const families = [
  { id: 350, address: "...", instructions: "...", contact: "...", people_count: 3 },
  // Add more families...
];
```

### Change Date Range

Update the `generateDeliveryDates()` function in `app/page.js` to change the start/end dates.

## Tech Stack

- Next.js 14 (App Router)
- Supabase (PostgreSQL database)
- Vanilla CSS (no framework needed)


## Printing delivery labels (kitchen PC)

Labels are printed from `/admin/print-labels?date=YYYY-MM-DD` as ONE multi-page job
(one 4x6 in page per label). Silent, dialog-free printing relies on three things:

1. Chrome/Edge started from a shortcut with `--kiosk-printing --no-first-run
   --no-default-browser-check` and its own `--user-data-dir` under
   `C:\Users\Public\KitchenPrint-<browser>` (so the flag always applies, normal
   browsing never changes the remembered printer, and no environment variable has to
   expand inside the shortcut arguments). The admin's Sign-ups tab has a "Printer
   setup" panel with copyable shortcut targets. In Chromium `window.print()` blocks
   until the preview closes and `afterprint` fires even on Cancel, so the page
   measures how long the call blocked to tell a silent print from a dialog.
2. The JADENS set as the Windows default printer with 4x6 in as its default paper
   (Printing preferences AND Printer properties → Advanced → Printing Defaults).
   CSS cannot choose physical paper.
3. `@page { size: 4in 6in; margin: 0 }` in the label page, which makes each page box
   exactly one label and suppresses the browser header/footer. Keep it that way —
   re-adding page margins brings the URL/date header back.

Do not switch to a per-label `window.print()` loop: Chromium throttles repeated
scripted prints and drops labels. `?test=1&silent=1` prints a single sample label
for verifying the setup; `?pdf=1` renders without printing.

## Kitchen Live (`/admin/live`)

A phone-first, game-style view of one kitchen day for the admin (same admin
password). A small 3D island shows the kitchen, a bag pile per delivery group,
a van per group and the houses around the ring road. The day moves through four
steps, stored per date in the `kitchen_days` table
(`supabase-migrations/2026-10-13-add-kitchen-days.sql`):

1. **Cooking**: the default; bags show as ghosts.
2. **Packing**: recorded by the print tab as each print job starts, whichever
   **Print labels** button opened it (kitchen page, admin panel or Kitchen
   Live), with the label count (`printed_at`, `printed_labels`). It counts even
   if the print dialog is cancelled or the browser never reports back; days
   with nothing to print are never marked.
3. **Delivering**: recorded by itself the first time the list is copied for the
   volunteers' WhatsApp group, from Kitchen Live or the kitchen view (`copied_at`).
   Volunteers claim groups in WhatsApp, so this stands in for sign-ups.
4. **Delivered**: the admin taps **Delivered** (`delivered_at`).

The big **Copy list** button copies the same text as the kitchen view's Copy
list and sends the vans out. Any step can be marked or undone from the
"Today's run" tracker. The page updates live (Supabase Realtime) when another
device prints or copies; if the live connection drops it re-checks every 10
seconds, and catches up as soon as it reconnects. `?date=YYYY-MM-DD` opens a given day. three.js loads
only on this page.
