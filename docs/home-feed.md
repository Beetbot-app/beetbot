# How Home is generated

The Home feed is assembled per request in `home_handler`
(`src-tauri/src/server/mod.rs`). This document describes what it does today, and
— where the code makes a choice — why. It was written by reading the
implementation, not from a prior design; anything stated here as intent is
inferred from the code and its comments unless marked otherwise.

It exists because the design was previously implicit in one very large file, with
its tuning constants inline. That made it impossible to tell a deliberate choice
from an accident, and impossible to know whether a change made the feed better.

---

## The shape of a request

Five stages, in order:

| # | stage | cost | freshness |
|---|---|---|---|
| 1 | Local shelves (SQL) | cheap | rebuilt **every request** |
| 2 | Discovery shelves (catalog APIs) | expensive | cached **6h** per (profile, day) |
| 3 | Per-visit item selection | cheap | every request |
| 4 | Shelf arrangement | free | every request |
| 5 | Curation (dedup / caps / pruning) | free | every request |

Stage 5 is a *filter*, not a generator. `curate_home_shelves` is the last thing
that runs and only ever removes.

### Final order

```
greeting
  lead_top   — win-back (if dormant), daypart, recently played
  external   — the discovery lineup (stage 4 decides which, and in what order)
  lead_more  — on repeat, sounds like
  trail      — top songs, genre mixes, decade mixes, from your past
```

Discovery sits **above** the deeper library shelves deliberately: Home leads
with new music instead of burying it under the user's own catalogue.

---

## Two seeds

This is the central trick and worth understanding before changing anything.

- **Day seed** — `(profile_id, local date)`. Drives the expensive cached build:
  which artist gets the Mix, which three artists seed the fusion. Stable per day
  so the cache key stays honest.
- **Visit seed** — profile + date + a client-supplied nonce. Drives which slice
  of each cached pool is shown, and which shelves appear in which order.

So **every visit looks different without a single extra catalog call.** Older
clients that send no nonce fall back to an hour bucket.

---

## Stage 1 — local shelves (pure SQL, always fresh)

| shelf | basis |
|---|---|
| Welcome back | hoisted to the top only when the profile has been dormant (`DORMANT_DAYS = 14`) |
| Good morning / afternoon / evening / Late night | tracks with genuine time-of-day *character*, not merely all-day favourites that happen to play now |
| Recently played | ranked; order is information |
| On repeat | ranked |
| More of this sound | audio-feature distance from the most-played downloaded track; absent until the analysis pass runs |
| Top songs | rotating |
| Your {genre} mix | coarse `tracks.genre` bucket, top ~2, excludes the `Unknown` sentinel |
| Your {decade} | `tracks.release_year`, top ~2; NULL until the enrich pass runs |
| From your past | in the trail — unless dormant, when it becomes "Welcome back" at the top |

The rotating shelves take the **visit** seed; the ranked ones don't, because
their order carries meaning.

---

## Stage 2 — discovery shelves (catalog, cached)

Thirteen builders fan out concurrently via `tokio::join!`. Each is tagged with
an **intent lane**, which is what stage 4 balances on.

| shelf | lane | basis |
|---|---|---|
| More like your favourites | Familiar | listening history; `None` if too thin |
| Your top artists | Familiar | most-played artists as catalog cards |
| {Artist} Mix | Familiar | top artist woven with similar artists (ListenBrainz) |
| More like {artist} | Familiar | Deezer related artists, rotated daily rather than pinned to your #2 forever |
| More like {artist} (mixed row) | Discover | related artists + albums *by neighbours* + one on-seed playlist — explicitly **not** the seed's own catalog |
| Release Radar | Fresh | releases in the last ~120 days from artists you actually **play** |
| New releases | Fresh | Deezer editorial, global, not personalised |
| New for you | Discover | fresh releases from artists you have **not** played — the deliberate inverse of Release Radar, excluded so the two never collide |
| More {tag} for you | Discover | Last.fm dominant-tag seeded; no-op without a key |
| Under the radar | Discover | fusion engine seeded from your top artists with **popularity inverted** |
| Because you played {artist} | Discover | reacts to *recent* listening — an artist you finished a song by in the last week — not all-time taste |
| Weekly finds | Discover | mostly-unheard tracks, materialised once per ISO week so it genuinely holds still Mon→Sun |
| Editorial playlists | Editorial | curated playlists for your top ~3 genre buckets: filtered *to* your taste, not generated *from* your history |

### Cold start

Everything above seeds off `seed_artists` → `top_played_artists`, falling back to
saved artists when there are fewer than `MIN_SEEDS = 3`. `station_ready` is
simply "is there at least one seed artist". When false, `build_cold_start_shelves`
fills the page from the cached global Browse feed, and disappears the moment
listening begins.

### Serving cost

A cold cache (typically the first load after a date rollover) does **not** block
the request. The full build is spawned in the background behind an in-flight lock
(so only one runs), and the request is served a partial bounded by an **8-second
hard timeout** — past which it serves local shelves only rather than making the
user wait on a slow provider. A partial is never written to the cache, so it
cannot shadow the real feed for the full TTL.

---

## External sources — who knows what

The discovery builders draw on four outside services, each with one job. None of
them receives listening data; the only thing that flows out is lookups (artist
names, tag names). Nothing is scrobbled anywhere.

| source | job | key needed |
|---|---|---|
| **Deezer** | the catalog: search, albums, artists, covers, previews. Every external `(title, artist)` pair from any other source is resolved through Deezer to become playable | no |
| **ListenBrainz** | artist-to-artist similarity (`similar-artists` by MBID) — feeds the Artist Mix and radio | no |
| **Last.fm** | *vibe*: community tags. Four read-only endpoints (tag top-tracks, artist top-tags, similar-artists, track-similar) | yes — free key |
| **Apple Music RSS** | one clean global most-played feed for the charts / cold start | no |

### Last.fm in detail — five roles, one visible

1. **The tag enrichment sweep** (`tags/mod.rs`, runs at startup, incremental,
   rate-limited) fetches top tags once per distinct library artist into
   `artist_tags`. This is the infrastructure role: it builds the library's vibe
   graph. Everything below reads that table.
2. **"More {tag} for you"** — the one visible Home shelf (Discover lane). Your
   top artists' tags are summed into a taste-weighted profile (generic tags
   filtered), the shelf rotates across your top-3 tags by the day seed, and the
   tag's Last.fm chart is resolved through Deezer minus what you already own.
3. **Radio blending** — `tag_similar_artists` ranks *your own library's* artists
   by tag overlap with a station seed, alongside ListenBrainz, Deezer related,
   and playlist co-occurrence. It works even when ListenBrainz has nothing for a
   seed, and reflects your graph rather than a global one.
4. **Genre pages** — the tag's community chart plus an "all-time classics" row;
   cold-start Home inherits these through the cached Browse feed.
5. **Song→song similarity in radio** — `track.getsimilar`, the only *track-level*
   (not artist-level) signal in the app. When the queue runs dry, autoplay calls
   `/api/radio/similar?artist=X&title=<current song>`, and the exact playing
   track seeds one of the four candidate lists that `fuse_rank` blends (the
   others: Deezer smart-radio, artist-graph deep cuts, the seed's own top
   tracks). Co-listening data over the exact song — the most granular
   recommendation signal available anywhere in the codebase.

### Song-level similarity never reaches Home

Role 5 stops at radio. The comment on `gather_candidates` says it directly:
*"`exclude_title` seeds the song→song source (empty without a title, e.g. on
Home)."* Every Home shelf is artist-, tag- or chart-level; there is also a
practical reason — artist-level candidates are cached per (artist, ISO-week),
and a per-track fan-out cannot be cached that way, so it runs only where it's
worth paying fresh.

The near-miss worth recording: `Because you played {artist}` finds its artist by
walking recent plays — **the code already holds the specific song** — then
discards the title and seeds at artist level. A song-level variant ("Because you
played {song}", seeding `track.getsimilar`) would be the most granular shelf on
the page, and every piece of plumbing already exists: the recent-play query, the
endpoint, Deezer resolution, `fuse_rank`. Cost: one uncached ~20-track fan-out
per day per profile. It also lands where the psychology section points —
discoveries stick via re-exposure of *specific tracks*, and song-level seeding
is where a specific track someone loved produces specific neighbours instead of
blurring to artist level.

### The key is a silent dependency

The Last.fm key is a Settings override, else a **build-time** value baked in via
`option_env!("BEETBOT_LASTFM_KEY")` — the same pattern as the relay token. A
build made without that env var silently loses every Last.fm feature: no tag
shelf, no enrichment sweep, thinner radio. Nothing in the app surfaces why. (The
same class of stale-input problem that motivated `pre-build.sh` staging; worth
remembering when a build's Home looks inexplicably thin.)

`artist_tags` is also the most under-used asset here: it is the closest thing to
a taste *texture* model beyond play counts, and it currently powers one rotating
shelf. The re-exposure and adaptive-discovery ideas in the psychology section
would both benefit from it as a similarity space.

---

## Stage 3 — fatigue

`home_impressions` records what each profile was actually **shown**, after
curation, so items dropped by dedup or bans don't count:

```sql
home_impressions(profile_id, item_kind, item_key,
                 first_shown, last_shown, shown_days)
```

`load_fatigue` reads rows whose `last_shown` is **before today**, so impressions
accruing during a session can't shift ranking between two serves on the same day.
Demotion is deliberately coarse — three tiers, not a strict ordering:

| `shown_days` | tier |
|---|---|
| 0–2 | fresh enough to anchor |
| 3–6 | getting stale |
| 7+ | last-resort backfill |

Within a tier the visit-seeded shuffle still rotates, so ranking isn't flattened
into a brittle most-unseen-first order.

**Known limitation:** this measures *exposure only*. A shelf the user skips past
every day is demoted identically to one they love. There is no signal anywhere in
Home from skips, plays, or dismissals.

---

## Stage 4 — arrangement

The builders produce more shelves than a page should show, so `arrange_shelves`
picks a bounded, balanced, rotating subset.

- **Rail shelves** (the mixes) are pulled out of the rotation and the page budget
  entirely — they're a separate visual surface, and otherwise the artist-mix tile
  would blink in and out visit to visit.
- **Friday** promotes the highest-ranked release shelf to the top as "New this
  Friday". Release rank: Release Radar (3) > New for you (2) > New releases (1).
- **Non-Friday** guarantees Release Radar a slot by pulling it out of the lane
  rotation, so a busy rotation can never push it off the page.
- Remaining shelves are bucketed by lane, shuffled **within** each lane by a
  per-lane salted seed (so lanes don't permute together), capped, then
  round-robined with a seed-rotated start lane.

---

## Stage 5 — curation

Applied to every shelf, in display order, first-claimant-wins:

- Banned artists stripped from every shelf kind
- Cross-shelf de-duplication in two independent identity spaces — local library
  tracks by `track_id`, discovery items by `(source, source_id)`. A local file and
  a catalog recommendation of the same song are **not** de-duped against each
  other; that's a knowing trade.
- Per-artist cap within a shelf
- Shelves falling below the minimum are dropped entirely rather than shown thin
- Track rows are trimmed to display size **after** dedup, so a dropped shelf
  doesn't steal items from a later one

---

## Every tuning constant

These are currently inline. They are the whole tuning surface of the feed.

| constant | value | effect |
|---|---|---|
| `HOME_TTL` | 6h | discovery cache lifetime |
| `TOTAL_MAX` | 7 | discovery shelves per page |
| `PER_INTENT_MAX` | 2 | shelves per lane, so one lane can't dominate |
| `PER_ARTIST` | 2 | items per artist within a shelf |
| `MIN_SHELF` | 5 | below this a shelf is dropped |
| `DORMANT_DAYS` | 14 | quiet period that triggers the win-back shelf |
| `MIN_SEEDS` | 3 | seed artists before falling back to saved artists |
| cold-start timeout | 8s | ceiling on a cold request before serving local only |
| fatigue tiers | 0–2 / 3–6 / 7+ | demotion bands |

---

## Shelf labelling

Everything above this line was read out of the implementation. This section is
different: it is **external research**, gathered Aug 2026, about how other
products name and explain their rows. It is here because the labels are the only
part of the feed a user actually sees, and because the naming currently in the
code borrows from a competitor without a reason.

### Three strategies in the market

| product | approach | example |
|---|---|---|
| Netflix | **explain it** — the row title is itself personalised | "Because you watched The Crown" |
| Spotify | **brand it**, then add controls | "Discover Weekly", "Release Radar" |
| Apple Music | **describe it** — functional, unbranded | "New Music Mix", "Discovery Station" |

Netflix's is a deliberate position, not an accident of copy: they found that hard
mechanistic personalisation *unsettles* people, and that disclosing some of the
reasoning reassures them — with the side effect of reading as a friend rather
than a calculating machine.

Spotify went the other way, and recently doubled down on it. As of July 2026,
Release Radar carries session controls at the top of the playlist — pick up to
five of *Discover new artists*, *Editors' picks*, *Pop*, and so on. The
announcement is about sharper personalisation and new cover art. **There is no
explainability feature in it.** They chose controls instead of explanations.

### What the research finds

> Labels like "Because you watched X" or "Trending in Drama" outperform opaque
> labels, as users want to see the algorithm's reasoning; vague rows feel
> manipulative.

The risk of an unexplained row is not clutter. It is that it reads as something
being done *to* the user.

Also relevant to stage 2's cold-start behaviour:

> recommendation "personality shifts" between cold start and personalised modes
> can erode trust without smoothing

That is exactly what this feed does today — the page changes character the moment
`station_ready` flips. See open question 3.

### What follows for Beetbot

**Borrowed brand names are the one option with no argument for it.** Branded
names work for Spotify because Spotify owns the brand. "Release Radar" is theirs:
using it, we take the downside (a label that means nothing to someone who has
never used Spotify) and none of the upside (no equity accrues to us). Either
describe the shelf plainly, or coin something of our own.

**We can explain honestly, and a payola-funded service structurally cannot.**
The code already knows this — see `build_under_the_radar`, "our zero-payola
freedom makes championing the un-popular honest". Every shelf here has a true,
statable reason. That is a product position available to us and not to Spotify.

### Which shelves actually need work

**Correction (2 Aug), and an instructive one.** The first version of this audit
claimed the `eyebrow` was used by exactly two shelves. Wrong twice over: a grep
for `.eyebrow =` assignments missed the constructor parameter, and a grep of the
wrong directories missed the rendering in `shared/components/HomeScreen.tsx`.
In fact **most shelves already carry honest, well-written eyebrows and the
client renders all of them** — "New from artists you play" (Release Radar),
"Barely-known picks from your taste" (Under the radar), "Because you played
{seed}" (More of this sound), "Fresh picks, refreshed every Monday" (Weekly
finds), "Because you love {bucket}" (editorial). The transparency system this
document's research argued for already existed, unlabelled, in the codebase.

What was genuinely missing — shipped as phase 0 (`feat/home-says-why`):

| shelf | gap | fix |
|---|---|---|
| Top songs | ambiguous next to global charts: mine or everyone's? | retitled "Your top songs" (+ `HOME_FEED_VERSION` bump — a retitle changes the client's append-by-title key) |
| Trending now (cold start) | eyebrow said *what* ("What everyone's playing"), not *why the page is generic* | now "Until we know your taste" — the cheap smoothing for open question 3 |

Still open, deliberately: whether to keep the borrowed name "Release Radar".
With its eyebrow rendered, the ambiguity is already resolved on screen, so the
remaining question is purely brand (a competitor's vocabulary as a shelf title)
— a naming decision, not a clarity fix, and one to make once rather than churn.

The lesson for the next auditor: this file's claims about *the code* were made
by grepping, and two of them were wrong until checked against the running
surface. Verify render paths end to end before concluding a field is unused.

---

## What the psychology says

Also external research (Aug 2026), on what makes discovery feel rewarding rather
than merely present. Three separate literatures — exposure psychology, music
cognition, and a large-scale streaming study — converge on one shape.

### Liking is an inverted U

- **Familiarity.** The mere exposure effect is robust in music: repeated hearing
  increases liking — up to a peak, after which overexposure tips into satiation.
  Liking rises with repetition, crests, then falls.
- **Surprise.** Preference peaks at *medium* predictability. Too ordered is
  boring; too random is noise. The reward system responds both to confirmed
  expectations and to their clever violation (Huron, *Sweet Anticipation*: musical
  pleasure is fundamentally anticipatory).
- **Adoption.** The Discovery Dynamics study of streaming behaviour finds
  discoveries take hold through *properly spaced repeated exposures* — not one
  encounter, not a barrage — and that people differ in **discovery velocity**,
  their individual capacity to absorb new music.

Same curve at three levels. The pleasurable zone is the middle, and the
mechanism is anticipation.

### The ethics line

Variable reward schedules — unpredictable payoffs — are the most habit-forming
mechanic known; slot machines, infinite scroll and engagement feeds all run on
them. A home page that reshuffles unpredictably *is* one, intended or not.

The ethics literature draws the line at **alignment**: the same mechanic is
legitimate when it serves the user's stated goal and manipulative when it serves
an engagement metric. Beetbot has no engagement metric — nobody here profits
from the app being opened more often. That means anticipation mechanics can be
used honestly, in service of the user's actual goal (love more music), and the
honest form is: **transparent schedule, surprising contents.** A thing you await
whose contents you can't predict — not a page that churns under you.

### Held against this implementation

The architecture already matches the prescription surprisingly well: the lanes
are a novelty/familiarity balancer, fatigue implements "not too often", the
per-visit rotation gives fresh-but-not-random. Three genuine gaps:

1. **Discoveries are shown once, never nurtured.** Fatigue only ever pushes
   down. If a shelf plays someone a track and they finish it, nothing brings it
   back days later — which is precisely when spaced re-exposure would convert a
   good first meeting into a lasting favourite. Re-surfacing *played* discoveries
   on a spaced schedule is the single most research-backed feature available
   here. It requires the play/impression join (open question 1): re-expose only
   what got a positive reaction.
2. **The discovery dose is fixed for everyone.** Two Discover shelves per page,
   always. Discovery velocity is personal; the lane caps could respond to
   whether discovery shelves actually get played from. (This is also open
   question 2 wearing different clothes.)
3. **Anticipation is underused — and it is the ethical reward mechanic.** One
   shelf holds still all week (Weekly finds); the Friday lead is half of a
   ritual. A deliberate weekly rhythm — something that lands Monday, something
   Friday — gives a reason to return that doesn't depend on reshuffling.
   Spotify's two strongest products (Discover Weekly, Release Radar) are exactly
   this shape.

Ranked by research support over effort: (1) re-expose played discoveries,
(3) name the weekly ritual, (2) adaptive lane caps. All three stand on the same
play/impression join.

---

## Build order

The research sections above accumulated eleven ideas across four passes. Laid
side by side, they are not eleven pieces of work — most share one foundation,
and several should not be built until data exists to justify them. This section
is the consolidation, so the doc reads as a plan rather than an archive.

### The structural facts

**Four ideas are secretly one table join.** Re-exposing played discoveries,
adaptive lane caps, skip/play signals, and measuring the constants all reduce to
crossing `home_impressions` with play history. One SQL query, written once.

**The same join is the measurement instrument.** Today, if any feed change
shipped, nothing could say whether it worked. Plays-per-impression by shelf and
lane is the baseline — which means it must exist *before* the features it
justifies, not after.

**The copy changes have no dependencies at all**, and the song-seeded shelf
needs no foundation — every piece of its plumbing already exists (see open
question 6).

### Phases

| phase | what | why this order |
|---|---|---|
| 0 | **Words**: retitle the opaque shelves, the cold-start line, one eyebrow on Under the radar | zero risk, no dependencies, shippable immediately |
| 1 | **The join**, surfaced as a read-only report (plays-per-impression by shelf and lane) | baselines the feed as-is; unlocks phases 3+ and the constants question |
| 2 | **The song-seeded shelf** ("Because you played {song}", `track.getsimilar`) | the visible win; independent of phase 1; best effort-to-impact ratio in the doc |
| 3 | **Re-exposure of played discoveries**, spaced | the most research-backed feature here, but it needs phase 1's data to pick what to re-expose |

### Deliberately deferred, with reasons

- **Adaptive lane caps** — tuning without behavioural data is folklore; revisit
  once phase 1 has weeks of history.
- **Cold-start blend** — every current user already has taste; this matters at
  public launch, not now. The cold-start *line* (phase 0) is the cheap interim.
- **"Less like this" control** — only if the implicit signal from phase 1 proves
  insufficient. Explicit controls are the fallback, not the plan.
- **A/B-ing the constants** — at the current user count, per-user statistics are
  noise. The join still answers the directional question ("this shelf is never
  played from") at any N; that is the honest scope of open question 4 for now.

### A note on evidence quality

The sources list below mixes two tiers and decisions should weight them
accordingly. Peer-reviewed or primary: the negative-feedback paper (the 37–50%
coverage numbers), Discovery Dynamics (spaced exposure), the PNAS and PMC
exposure studies, the explainability survey, Huron, and Spotify's own newsroom
post. Blog-tier: the "vague rows feel manipulative" phrasing, the cold-start
"personality shift" claim, and the variable-reward ethics framing — their
substance is echoed by the stronger sources, but the quotes themselves are from
SEO/agency content. Nothing in phases 0–3 rests on blog-tier evidence alone; the
two deferred ideas that lean on it hardest (cold-start blend, weekly ritual) are
deferred anyway.

### Data-source posture

The five-signal similarity blend in radio is deliberate diversity, not waste,
and the weekly candidate cache bounds its cost. The real inefficiency is
**under-use**: `track.getsimilar` (phase 2 fixes) and `artist_tags` (the richest
taste model in the app, currently one shelf). The real risk is the **Last.fm
key** — a single free-tier, build-time-baked dependency that silently degrades
four features when absent, while every other source is keyless. A one-line
health surface ("Last.fm: configured / absent") is worth adding before any new
feature deepens that dependency.

---

## Open questions

Things the code does not answer, recorded so the next person doesn't have to
re-derive them:

1. **No reaction signal.** Fatigue is exposure-only (see stage 3). Skips, plays
   and dismissals feed nothing on Home.
2. **The lanes are an unexposed control.** `PER_INTENT_MAX` per lane is
   effectively a discovery-vs-familiar dial. The backlog item "let users
   influence their recommendations" is scoped as vague, but the mechanism it
   needs already exists here.
3. **The cold-start → personalised transition is a cliff, not a blend.** An
   earlier note proposed blending global charts into the personalised feed as
   taste accrues; what shipped flips entirely on the first seed artist. The
   labelling research above names this specifically as trust-eroding, so a
   cold-start line is worth having as cheap smoothing until a real blend exists.
4. **None of these constants has a recorded rationale.** They read as reasonable,
   but no one has measured whether 7 shelves beats 6 or 8, or whether a 6-hour
   TTL is right.
6. **The most granular signal in the app is confined to autoplay.** Song→song
   similarity (Last.fm `track.getsimilar`) exists, works, and never reaches
   Home — see "Song-level similarity never reaches Home" above. The
   `Because you played {artist}` builder already holds the exact song it found
   and throws the title away. A song-seeded shelf is the shortest path from
   this doc's research sections to something a user would notice.
5. **Skips are ambiguous and need lane-relative baselines.** If (1) is ever
   built: the published work on music personalisation finds skips sit between
   positive and negative rather than being a clean rejection, and must be
   weighted by surface — a skip while browsing new releases means little, the
   same skip inside a focused context means a lot. Our four lanes are that
   context. An absolute play-rate threshold would demote Under the radar, New for
   you and Weekly finds first, which is precisely backwards. The larger prize is
   coverage rather than accuracy: adding skips as an *input* raised user coverage
   by roughly 37–50% in published results, by giving the system something to work
   with for people who never save anything.

---

## Sources

The implementation sections are read from the code. The labelling and psychology
sections and open question 5 draw on:

Psychology of discovery:

- [Discovery Dynamics: leveraging repeated exposure](https://arxiv.org/pdf/2210.16226) — spaced exposure, discovery velocity
- [Mere exposure effect in music](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3324153/) — repetition increases liking
- [Repeated listening increases liking regardless of complexity](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5374342/)
- [Predictability and the pleasure of music (PNAS)](https://www.pnas.org/doi/10.1073/pnas.2516635122) — the inverted-U on surprise
- [Neurobiology of sensation and reward: music](https://www.ncbi.nlm.nih.gov/books/NBK92781/)
- David Huron, *Sweet Anticipation: Music and the Psychology of Expectation* (OUP, 2006)
- [Variable reinforcement and ethical growth loops](https://buildbetterhq.substack.com/p/variable-reinforcement-why-infinite-wins) — where the ethics line sits
- [Ethical UX patterns](https://uxpamagazine.org/ethical-ux-patterns-building-trust-without-manipulation/)

Labelling:

- [Negative feedback for music personalization](https://arxiv.org/html/2406.04488) — skip ambiguity, coverage gains
- [Inside Spotify's recommendation system](https://music-tomorrow.com/blog/how-spotify-recommendation-system-works-complete-guide) — context-dependent skip weighting
- [Spotify discovery playlist controls, July 2026](https://newsroom.spotify.com/2026-07-10/discovery-playlists-release-radar-control-updates/) — controls chosen over explanations
- [Netflix, behavioral science, and personalization](https://www.psychologytoday.com/us/blog/emotional-behavior-behavioral-emotions/202408/netflix-behavioral-science-and-personalization) — disclosure as reassurance
- [Spotify vs Apple Music playlists](https://imusician.pro/en/resources/blog/apple-music-vs-spotify-playlists) — branded vs descriptive naming
- [Streaming app UX best practices](https://www.forasoft.com/blog/article/streaming-app-ux-best-practices) — explanatory labels outperform opaque ones
- [Cold start in recommender systems](https://aicompetence.org/cold-start-problem-in-recommendation-systems/) — personality shift without smoothing
- [Explainability in music recommender systems](https://arxiv.org/pdf/2201.10528) — trust and forgiveness

Self-hosted context: Navidrome, Jellyfin and Plex users consistently report that
their servers have no discovery at all
([one](https://jellywatch.app/blog/jellyfin-vs-navidrome-best-self-hosted-music-server-2026),
[two](https://www.xda-developers.com/single-music-app-plex-jellyfin-navidrome/)).
Beetbot having a real discovery feed at all is the differentiator; explaining it
honestly is what a payola-funded competitor cannot copy.
