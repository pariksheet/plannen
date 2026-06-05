# Mailbox Sync Classifier Fixtures

A by-hand regression suite for `/plannen-mailbox-sync` Step B (event-worthy classification). The LLM classifier isn't gated by CI; this file is what someone editing the prompt runs through manually.

Each row lists the email summary the classifier sees and the expected verdict:
- `skip` — should be Skip-outright
- `create-high` — should create with high confidence (no `#review`)
- `create-review` — should create with `#review` tag (personally addressed but missing one of the four high-confidence criteria)

| # | Subject | From | Snippet excerpt | Expected | Why |
|---|---|---|---|---|---|
| 1 | "NT2 Festival 2026 — Programme Released" | `noreply@nt2festival.be` | "Discover this year's lineup. Book your seat now." | `skip` | Mass marketing, public ticketed festival, generic greeting, brand "discover" CTA. |
| 2 | "EVCO Xperience Days — Test drive the X9" | `events@evco-experiences.com` | "Hi there, our test drive days are coming to your city." | `skip` | Commercial product launch / experience day; greets "Hi there"; sender on brand events subdomain. |
| 3 | "Acme Life Insurance Policy Renewal — Ensure Acc..." | `notification@e.acmelife.com` | "Dear customer, your policy is due for renewal on 15-Jun-2026." | `skip` | Transactional renewal reminder; "Dear customer" greeting; subject "renewal"; sender on bulk subdomain. |
| 4 | "Quick intro? — Senior Backend Eng role" | `cyriel@somerecruiter.com` | "Hi Pari, I came across your profile and I'm reaching out about an opportunity..." | `skip` | Cold recruiter pitch; no prior thread; generic intro framing. Greets by name but is a cold outreach. |
| 5 | "Confirmed: Treehouse build with Riya, June 12" | `parent@example.com` | "Hi Pari — we're confirmed for the 12th. Bring snacks!" | `create-high` | Personally addressed by name; concrete date; specific commitment from a friend. |
| 6 | "Your appointment confirmed — June 15, 10:00 at Dr. Smith" | `noreply@meddesk.com` | "Booking #ABC123 is confirmed for June 15." | `create-high` | Booking confirmation with ID; subject unambiguously personal. |
| 7 | "Open Day at Roberts Academy — All families welcome" | `info@robertsacademy.school` | "Dear families, join us on Saturday June 1 for our annual open day." | `skip` | Generic public invite; "Dear families"; no personal addressing. |
| 8 | "School trip on June 20 — please sign permission slip" | `office@kidsclassroom.school` | "Hi Pari, please return Riya's signed slip by Monday." | `create-high` | Personally addressed; references child by name; concrete date. |
| 9 | "Reminder: tickets are still available for the gala" | `news@somefoundation.org` | "Hi! We still have spots for the gala — secure yours today." | `skip` | Mass marketing dressed as a reminder; bulk newsletter sender; no personal addressing. |
| 10 | "Are you free Thu 18:00 for coffee?" | `aFriend@example.com` | "Hey Pari, want to grab coffee Thursday at 6? Same place as last time." | `create-review` | Personally addressed by name; thread-style; concrete day but ambiguous date (Thursday) and venue ("same place as last time"). Routes to `#review`. |
| 11 | "Supabase Data API changes deadline" | `announcements@supabase.com` | "Heads up — the Data API behaviour you rely on changes on 2027-01-15. Migrate before then to avoid breakage." | `skip` | Developer platform deprecation notice. Has a concrete date but it's a chore reminder, not an attendable event. Sender is a SaaS platform, not a venue. |

## Known classifier issues to revisit

- **Truncated title from compound subject (2026-05-27).** A "Badminton - City Arena" booking confirmation appeared in the app with the title shortened to just "Badminton" and the time mis-parsed. Suspected causes: (a) the classifier extracted only the first noun from the subject as title rather than preserving the whole "Badminton - City Arena" string; (b) the time field was read in the wrong timezone (Brussels-local interpreted as UTC, or vice versa). Reproduce by re-sending the original Gmail thread through `/plannen-mailbox-sync` after the prompt is iterated — the title should round-trip verbatim and the time should land in Brussels local time. Add the actual Gmail thread excerpt to the fixture table once captured.

## How to run this suite

1. Open Gmail; tag 10 messages that approximate these fixtures (or use your own representative set; the categories matter more than the exact strings).
2. Run a sync iteration:
   ```bash
   bash scripts/mailbox/sync-wrapper.sh
   ```
3. Open `~/.plannen/logs/mailbox-sync.log`; check the final JSON for `created` / `skipped` counts and the classified rows in the log body.
4. For each fixture, confirm the classifier's verdict matches the expected column. If it diverges, the prompt needs another iteration.

This is the regression net, not CI. Run it when you edit `plugin/skills/plannen-mailbox-sync.md`.
