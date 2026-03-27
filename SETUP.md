# N&L Training App — Setup Guide

## 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in (free tier)
2. Click "New Project"
3. Choose a name (e.g. "nl-training"), set a database password, pick region EU West
4. Wait for the project to provision (~2 min)

## 2. Run the Database Schema

1. In your Supabase dashboard, go to **SQL Editor** (left sidebar)
2. Click "New Query"
3. Paste the entire contents of `sql/schema.sql`
4. Click "Run" — this creates tables, RLS policies, triggers, and seeds period plans

## 3. Configure the App

1. In Supabase dashboard, go to **Project Settings > API**
2. Copy the **Project URL** and the **anon / public** key
3. Open `js/config.js` and replace the placeholders:
   ```
   const SUPABASE_URL = 'https://xxxx.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGc...';
   ```

## 4. Create User Accounts

1. Open the app in a browser (double-click `index.html` or serve via Netlify)
2. Click "Skapa konto" and register with name **Niklas**
3. Log out, then register again with name **Love**

Both profiles are auto-created by the database trigger.

## 5. Seed Historical Data

1. Log in as **Niklas**
2. Open browser DevTools console (F12)
3. Run: `seedAll()`
4. This migrates 4 weeks of workout data from the Excel for both users

## 6. Deploy to Netlify

The `site/` folder is self-contained. Deploy it to Netlify:
- Drag and drop the `site/` folder at [app.netlify.com/drop](https://app.netlify.com/drop)
- Or connect a Git repo and set the publish directory to `site/`
