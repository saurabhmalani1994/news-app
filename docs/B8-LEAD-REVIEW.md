# B8: best-version leads for the owner to judge

DESIGN-bundles section 7 asks B8 to report agreement with the owner's lead pick on 20
fixture-1 bundles. There is no owner pick yet, so this is the list to judge: for each
story, the lead the section 4a fact terms choose and the runner-up (the best version
from another outlet), with every term. Reported, not gated.

**How to judge.** For each story, write the outlet you would lead with after "Owner's
pick". Agreement is the share of stories where your pick is the lead. A disagreement
names the term to change: every weight sits in one table (fetcher/best_version.py) and
the headline lists in `headline_rules.json`.

**What the fixture lacks.** Fixture 1 (`tests/fixtures/bundles/gold_2026-09-24.json`)
has no bodies and no run history. So here complete and depth read the dek only (a live
full-text version would add up to 8 for full text and 10 for depth), every paywalled
source takes the -15 paywall term, and health is 0. Trust is the device's (B5) and is not
in these sums.

**Which 20.** Of the fixture's 42 stories with 2 or more outlets, the 20 with the most
outlets, then by story id. Regenerate with
`python -m fetcher.best_version review tests/fixtures/bundles/gold_2026-09-24.json`.

Terms, in `bv` order: original (20, or 0 for a wire copy), complete (15 full text, 7
dek), depth (1 per 600 body characters, at most 10), headline (entities and numbers up,
teasers down, floor -10), locality (15 local, 8 intermediate), first (10 for the first
report, 0 at 12 h later), health (-5 after 3+ failed runs), paywall (-15 without full
text).

## 1. st-wh-media-ban-ruling (15 versions, 13 outlets)

- **Lead, 58**: Reason, "TRO Issued Ordering Reinstatement of CNN, MS NOW, and Politico White House Access" (2026-09-24T05:38:21Z)
  - original 20, complete 7, depth 0, headline 6, locality 15, first 10, health 0, paywall 0
- **Runner-up, 53**: NPR, "Judge restores journalists' White House access. And, Tucker Carlson on his MAGA split" (2026-09-24T11:10:14Z)
  - original 20, complete 7, depth 0, headline 6, locality 15, first 5, health 0, paywall 0
- Owner's pick: 

## 2. st-xi-white-house-talks (13 versions, 10 outlets)

- **Lead, 41**: Al Jazeera, "Trump-Xi summit live: Trade, AI, Iran and Taiwan top US-China talks" (2026-09-24T12:00:00Z)
  - original 20, complete 7, depth 0, headline 6, locality 0, first 8, health 0, paywall 0
- **Runner-up, 40**: CNA Singapore, "Trump-Xi summit: Trump welcomes Xi to White House for high-stakes talks" (2026-09-24T13:00:00Z)
  - original 20, complete 7, depth 0, headline 6, locality 0, first 7, health 0, paywall 0
- Owner's pick: 

## 3. st-xi-arrival (8 versions, 7 outlets)

- **Lead, 51**: Hong Kong Free Press, "China’s Xi heads to US for talks with Trump: state media" (2026-09-23T09:41:06Z)
  - original 20, complete 7, depth 0, headline 6, locality 8, first 10, health 0, paywall 0
- **Runner-up, 48**: Guardian US, "First Thing: Trump welcomes Xi to Washington amid tensions over trade, AI and Taiwan" (2026-09-24T12:24:00Z)
  - original 20, complete 7, depth 0, headline 6, locality 15, first 0, health 0, paywall 0
- Owner's pick: 

## 4. st-netanyahu-un-speech (6 versions, 6 outlets)

- **Lead, 58**: Jerusalem Post, "Netanyahu set for brief UNGA visit with limited diplomatic meetings, planned anti-Israel protests" (2026-09-24T08:07:27Z)
  - original 20, complete 7, depth 0, headline 6, locality 15, first 10, health 0, paywall 0
- **Runner-up, 54**: The Hill, "Watch live: Netanyahu to address UN amid US-Israel war in Iran" (2026-09-24T13:09:03Z)
  - original 20, complete 7, depth 0, headline 6, locality 15, first 6, health 0, paywall 0
- Owner's pick: 

## 5. st-ethiopia-fighting (3 versions, 3 outlets)

- **Lead, 40**: The Guardian World, "Fears of return to war as Tigray rebels launch offensive against Ethiopian army" (2026-09-24T13:43:09Z)
  - original 20, complete 7, depth 0, headline 4, locality 0, first 9, health 0, paywall 0
- **Runner-up, 39**: BBC World, "Ethiopia's army says it has repelled attacks in first comment on fresh fighting" (2026-09-24T12:49:32Z)
  - original 20, complete 7, depth 0, headline 2, locality 0, first 10, health 0, paywall 0
- Owner's pick: 

## 6. st-games-organisers-criticised (3 versions, 3 outlets)

- **Lead, 45**: Korea Herald, "Top S. Korean sports official blasts organizers for shoddy operations" (2026-09-24T14:58:52Z)
  - original 20, complete 7, depth 0, headline 2, locality 15, first 1, health 0, paywall 0
- **Runner-up, 37**: Bangkok Post, "Thailand slams ‘chaotic’ Asian Games organisation" (2026-09-24T04:45:00Z)
  - original 20, complete 7, depth 0, headline 0, locality 0, first 10, health 0, paywall 0
- Owner's pick: 

## 7. st-israel-election-panel (6 versions, 3 outlets)

- **Lead, 56**: Times of Israel, "Election panel disqualifies all Arab parties, in move likely to be overturned; Balad leader also barred - The Times of Israel" (2026-09-23T13:29:00Z)
  - original 20, complete 7, depth 0, headline 4, locality 15, first 10, health 0, paywall 0
- **Runner-up, 48**: Jerusalem Post, "Election panel clears Otzma Yehudit for October vote after barring Arab slates day earlier" (2026-09-24T14:44:50Z)
  - original 20, complete 7, depth 0, headline 6, locality 15, first 0, health 0, paywall 0
- Owner's pick: 

## 8. st-jobless-claims (3 versions, 3 outlets)

- **Lead, 40**: Mint (Livemint), "US weekly jobless claims fall to 197,000, near historic lows as layoffs stay low" (2026-09-24T14:07:04Z)
  - original 20, complete 7, depth 0, headline 4, locality 0, first 9, health 0, paywall 0
- **Runner-up, 35**: PBS NewsHour Headlines, "Claims for unemployment benefits drop to 197,000, the lowest since mid-July as layoffs remain rare" (2026-09-24T14:20:15Z)
  - original 0, complete 7, depth 0, headline 4, locality 15, first 9, health 0, paywall 0
- Owner's pick: 

## 9. st-nene-royal-agt (3 versions, 3 outlets)

- **Lead, 58**: Bangkok Post, "Nene Royal triumphs on America's Got Talent" (2026-09-24T03:01:00Z)
  - original 20, complete 7, depth 0, headline 6, locality 15, first 10, health 0, paywall 0
- **Runner-up, 40**: BBC World, "Teen rocker Nene Royal becomes first Thai to win America's Got Talent" (2026-09-24T06:47:12Z)
  - original 20, complete 7, depth 0, headline 6, locality 0, first 7, health 0, paywall 0
- Owner's pick: 

## 10. st-openai-agent-breach (3 versions, 3 outlets)

- **Lead, 41**: Axios, "OpenAI agents breached Australian portal, attempted other hacks in routine data collection." (2026-09-24T05:46:26Z)
  - original 20, complete 7, depth 0, headline 4, locality 0, first 10, health 0, paywall 0
- **Runner-up, 40**: BBC World, "Rogue OpenAI agent 'infiltrated' Australian government website in world first" (2026-09-24T07:10:58Z)
  - original 20, complete 7, depth 0, headline 4, locality 0, first 9, health 0, paywall 0
- Owner's pick: 

## 11. st-overton-fda-hearing (3 versions, 3 outlets)

- **Lead, 54**: The Hill, "Watch live: Trump’s pick to lead FDA faces Senate confirmation hearing" (2026-09-24T13:57:42Z)
  - original 20, complete 7, depth 0, headline 6, locality 15, first 6, health 0, paywall 0
- **Runner-up, 41**: Washington Post Politics, "Trump’s FDA pick to face scrutiny on vaccines, abortion pill" (2026-09-24T09:00:00Z)
  - original 20, complete 7, depth 0, headline 4, locality 15, first 10, health 0, paywall -15
- Owner's pick: 

## 12. st-antisemitism-rally-un (2 versions, 2 outlets)

- **Lead, 56**: Times of Israel, "Hundreds rally against antisemitism outside UN headquarters in New York - The Times of Israel" (2026-09-23T22:00:55Z)
  - original 20, complete 7, depth 0, headline 4, locality 15, first 10, health 0, paywall 0
- **Runner-up, 38**: Haaretz, "New York rally against antisemitism features criticism of Mamdani, UN" (2026-09-24T01:52:59Z)
  - original 20, complete 7, depth 0, headline 4, locality 15, first 7, health 0, paywall -15
- Owner's pick: 

## 13. st-ballroom-architect (2 versions, 2 outlets)

- **Lead, 54**: Mother Jones, "Trump to Ballroom Architect: “I Am the Code”" (2026-09-23T17:18:45Z)
  - original 20, complete 7, depth 0, headline 2, locality 15, first 10, health 0, paywall 0
- **Runner-up, 35**: Washington Post Politics, "Current White House ballroom architect weighs in on the building’s safety" (2026-09-23T22:00:00Z)
  - original 20, complete 7, depth 0, headline 2, locality 15, first 6, health 0, paywall -15
- Owner's pick: 

## 14. st-cambodia-casinos (2 versions, 2 outlets)

- **Lead, 24**: Straits Times Asia, "Cambodia to target casinos in next phase of anti-scam sweep" (2026-09-24T08:59:00Z)
  - original 20, complete 7, depth 0, headline 2, locality 0, first 10, health 0, paywall -15
- **Runner-up, 24**: Japan Times, "Cambodia to target casinos in next phase of anti-scam sweep" (2026-09-24T09:31:00Z)
  - original 20, complete 7, depth 0, headline 2, locality 0, first 10, health 0, paywall -15
- Owner's pick: 

## 15. st-chuseok-traffic (2 versions, 2 outlets)

- **Lead, 56**: Yonhap News, "(LEAD) Traffic eases on 1st night of Chuseok as people head home" (2026-09-24T10:31:17Z)
  - original 20, complete 7, depth 0, headline 4, locality 15, first 10, health 0, paywall 0
- **Runner-up, 50**: Korea Herald, "Highways jammed as Chuseok holiday travel begins" (2026-09-24T15:29:12Z)
  - original 20, complete 7, depth 0, headline 2, locality 15, first 6, health 0, paywall 0
- Owner's pick: 

## 16. st-collins-pay-to-play (2 versions, 2 outlets)

- **Lead, 56**: Guardian US, "Democrats accuse Susan Collins of corruption after bombshell ‘pay-to-play’ report" (2026-09-23T21:12:39Z)
  - original 20, complete 7, depth 0, headline 4, locality 15, first 10, health 0, paywall 0
- **Runner-up, 37**: PBS NewsHour Headlines, "Maine Dems hammer Collins over report of pay-to-play probe. GOP senator calls it 'completely false'" (2026-09-23T22:17:35Z)
  - original 0, complete 7, depth 0, headline 6, locality 15, first 9, health 0, paywall 0
- Owner's pick: 

## 17. st-el-sayed-iran (2 versions, 2 outlets)

- **Lead, 54**: Fox News Politics, "Michigan student confronts El-Sayed over Iran stance in tense exchange: ‘Do you stand with us?’" (2026-09-24T00:55:00Z)
  - original 20, complete 7, depth 0, headline 2, locality 15, first 10, health 0, paywall 0
- **Runner-up, 33**: Jerusalem Post, "US Senate candidate El-Sayed evades audience request to denounce IRGC, break silence on Iran" (2026-09-24T16:00:02Z)
  - original 20, complete 7, depth 0, headline 6, locality 0, first 0, health 0, paywall 0
- Owner's pick: 

## 18. st-f35-parts-investigation (2 versions, 2 outlets)

- **Lead, 39**: Kyodo News, "Pentagon investigates after China obtains parts from F-35 stealth fighter jet" (2026-09-24T07:00:00Z)
  - original 20, complete 7, depth 0, headline 2, locality 0, first 10, health 0, paywall 0
- **Runner-up, 33**: Al Jazeera, "Has China received US F-35 parts by diverting an Australian shipment?" (2026-09-24T13:36:22Z)
  - original 20, complete 7, depth 0, headline 2, locality 0, first 4, health 0, paywall 0
- Owner's pick: 

## 19. st-fbi-shinyhunters (2 versions, 2 outlets)

- **Lead, 56**: Ars Technica, "FBI rushes to investigate if ShinyHunters hack of thousands of employees is real" (2026-09-23T21:46:36Z)
  - original 20, complete 7, depth 0, headline 4, locality 15, first 10, health 0, paywall 0
- **Runner-up, 33**: PBS NewsHour Headlines, "News Wrap: FBI investigating hacking group's claim it breached jobs website" (2026-09-23T22:45:42Z)
  - original 0, complete 7, depth 0, headline 2, locality 15, first 9, health 0, paywall 0
- Owner's pick: 

## 20. st-fury-joshua (2 versions, 2 outlets)

- **Lead, 39**: Al Jazeera, "Tyson Fury to face British rival Anthony Joshua in Cardiff on December 11" (2026-09-24T12:48:26Z)
  - original 20, complete 7, depth 0, headline 2, locality 0, first 10, health 0, paywall 0
- **Runner-up, 30**: CNA Singapore, "Joshua and Fury to face off in Cardiff on December 11" (2026-09-24T12:42:18Z)
  - original 20, complete 0, depth 0, headline 0, locality 0, first 10, health 0, paywall 0
- Owner's pick: 

