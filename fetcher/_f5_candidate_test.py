"""F5 temporary candidate verification script. Uses the real fanout fetch code
(fetch_feed, parse_xml, item iteration, _published_at) so results match production
behavior exactly, including the item vs entry (Atom) distinction. Removed after F5 lands.

Usage: python -m fetcher._f5_candidate_test
"""
import concurrent.futures
import json
import sys
from collections import Counter
from datetime import datetime, timezone

from fetcher.fetch import fetch_feed, parse_xml, _published_at, _text, _plain, FeedError

CANDIDATES = {
    "france24_france": "https://www.france24.com/en/france/rss",
    "euronews_en": "https://www.euronews.com/rss?level=theme&name=news",
    "le_monde_en": "https://www.lemonde.fr/en/rss/une.xml",
    "al_monitor": "https://www.al-monitor.com/rss.xml",
    "ynet_news": "https://www.ynetnews.com/Integration/StoryRss3082.xml",
    "daily_maverick": "https://www.dailymaverick.co.za/dmrss/",
    "premium_times": "https://www.premiumtimesng.com/feed",
    "allafrica_general": "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf",
    "buenos_aires_times": "https://www.batimes.com.ar/feed",
    "mercopress": "https://en.mercopress.com/rss/",
    "rest_of_world": "https://restofworld.org/feed/",
    "dawn_pk": "https://www.dawn.com/feeds/home",
    "abc_australia": "https://www.abc.net.au/news/feed/51120/rss.xml",
    "guardian_australia": "https://www.theguardian.com/australia-news/rss",
    "ft_home": "https://www.ft.com/rss/home",
    "bloomberg_markets": "https://feeds.bloomberg.com/markets/news.rss",
    "semafor": "https://www.semafor.com/rss.xml",
    "nyt_world": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    "science_news": "https://www.sciencenews.org/feed",
    "quanta_magazine": "https://www.quantamagazine.org/feed/",
    "propublica": "https://www.propublica.org/feeds/propublica/main",
    "global_voices": "https://globalvoices.org/feed/",
    "crunchbase_news": "https://news.crunchbase.com/feed/",
    "green_queen": "https://www.greenqueen.com.hk/feed/",
    "food_dive": "https://www.fooddive.com/feeds/news/",
    "canary_media": "https://www.canarymedia.com/feed",
    "latitude_media": "https://www.latitudemedia.com/feed",
    "trellis_greenbiz": "https://www.trellis.net/feed",
    "ctvc": "https://www.ctvc.co/rss/",
    "biofuels_digest": "https://www.biofuelsdigest.com/feed/",
    "sifted": "https://sifted.eu/feed",
    "techcrunch_climate": "https://techcrunch.com/category/climate/feed/",
}


def test_one(name, url):
    leniency = Counter()
    try:
        data = fetch_feed(url, timeout=20)
    except Exception as e:
        return name, url, f"FETCH_ERR:{type(e).__name__}:{e}", None
    try:
        root = parse_xml(data, leniency)
    except FeedError as e:
        return name, url, f"PARSE_ERR:{e}", None
    items = list(root.iter("item"))
    if not items:
        return name, url, "EMPTY(0 <item> elements - may be Atom-only)", None
    newest = None
    has_desc = 0
    has_img = 0
    max_desc = 0
    for it in items:
        pub = _published_at(_text(it, "pubDate"), leniency)
        if pub and (newest is None or pub > newest):
            newest = pub
        desc = _plain(_text(it, "description"))
        if desc:
            has_desc += 1
            max_desc = max(max_desc, len(desc))
        xml_str = "".join(it.itertext())
        if "media:content" in "".join(it.itertext()) or it.find("enclosure") is not None:
            has_img += 1
    # crude image check via serialization
    import xml.etree.ElementTree as ET
    raw = ET.tostring(root, encoding="unicode")
    return name, url, "OK", {
        "items": len(items),
        "newest": newest,
        "has_desc": has_desc,
        "max_desc": max_desc,
        "img_signal": ("media:content" in raw) or ("media:thumbnail" in raw) or ("<enclosure" in raw),
        "leniency": dict(leniency),
    }


def main():
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=15) as ex:
        futs = {ex.submit(test_one, n, u): n for n, u in CANDIDATES.items()}
        for fut in concurrent.futures.as_completed(futs):
            results.append(fut.result())
    results.sort(key=lambda r: r[0])
    now = datetime.now(timezone.utc)
    for name, url, status, info in results:
        if status != "OK":
            print(f"{name:22s} {status}")
            continue
        newest = info["newest"]
        age_days = None
        if newest:
            age_days = (now - datetime.strptime(newest, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)).days
        keep = "KEEP" if info["items"] >= 5 and age_days is not None and age_days < 7 else "REJECT"
        print(
            f"{name:22s} {status:6s} {keep:6s} items={info['items']:4d} "
            f"newest={newest} age_days={age_days} has_desc={info['has_desc']}/{info['items']} "
            f"max_desc={info['max_desc']:6d} img={info['img_signal']}"
        )


if __name__ == "__main__":
    main()
