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
