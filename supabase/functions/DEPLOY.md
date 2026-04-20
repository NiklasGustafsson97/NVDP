# Deploy guide — adaptive quality + feasibility update

Three edge functions have to be re-deployed for the adaptive-quality and
realism-check feature to work. All three are **single-file** (the
capacity helpers are inlined) so the Supabase dashboard editor accepts
them directly — no CLI required.

## What changed

- **`generate-plan`** — inlines the capacity module, scales quality
  sessions per phase to the athlete's tier (novice/developing/
  intermediate/advanced), injects an `ATHLETE CAPACITY & FEASIBILITY`
  block into the LLM prompt, and returns `profile` + `feasibility` in
  the response. Coaching note is also prepended to `plan.summary`.
- **`weekly-template-ai`** — inlines a lite capacity profiler (no
  feasibility), reads optional `baseline` from the request body and
  scales the standard-week quality count accordingly. Returns the
  computed `profile` in the response.
- **`assess-feasibility`** — NEW endpoint. Deterministic, no LLM call.
  Same payload shape as `generate-plan`. Returns `{ profile, feasibility }`
  in <100 ms. Used by the wizard for the pre-flight realism step.

## Step-by-step (Supabase dashboard)

1. Open https://supabase.com/dashboard → your project → **Edge Functions**.
2. For each function below, click the function name (or **+ Deploy a new
   function** for the new one), then paste the file contents into the
   editor and click **Deploy**.

   | Action  | Function name        | Source file                                                  |
   | ------- | -------------------- | ------------------------------------------------------------ |
   | Update  | `generate-plan`      | `site/supabase/functions/generate-plan/index.ts`             |
   | Update  | `weekly-template-ai` | `site/supabase/functions/weekly-template-ai/index.ts`        |
   | Create  | `assess-feasibility` | `site/supabase/functions/assess-feasibility/index.ts`        |

3. For the new `assess-feasibility` function, the dashboard will ask
   whether to verify JWT — leave the default **Verify JWT: ON** because
   the function calls `userClient.auth.getUser()` and needs the auth
   header.

## Required env vars (already set for the other functions)

The new endpoint only needs:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `APP_ORIGINS` (comma-separated, e.g.
  `https://niklasgustafsson97.github.io`)

These are project-level secrets and will be picked up automatically if
they're already configured for `generate-plan`. No new secret to set.

## Smoke test (after deploy)

1. Open the app, click **Skapa schema** to launch the wizard.
2. Walk through steps 0–3 as before.
3. After step 3 you'll land on a new **Realism-koll** step — it should
   show a risk badge (green/yellow/orange/red) and a coaching note
   within ~1 s. If you set an aggressive goal (e.g. marathon under
   3:00 with 20 km/v baseline), the badge should be orange/red and the
   primary CTA should switch to "Generera ändå".
4. Click "Generera schema" / "Generera ändå" — the loader should appear
   and a plan should be created within 15–30 s.
5. The success modal includes the coaching note.
6. Open **Hantera schema** → click your new plan to expand the preview.
   The coaching note should appear as a pink callout above the phase
   grid.

## Verify the quality-session scaling worked

In the Supabase dashboard:

- Edge Functions → `generate-plan` → **Logs**.
- Look for the line `generate-plan: retry triggered` — should be
  rare now because validation accepts the tiered counts.
- Open the most recent generated plan in the app and verify:
  - **Novice + 3 sessions/v + base phase**: 0 quality sessions/v is OK.
  - **Intermediate + 5 sessions/v + build phase**: should see 2
    quality sessions/v (threshold + VO2max).
  - **Advanced + 6+ sessions/v + peak phase**: should see 3 quality
    sessions/v.
