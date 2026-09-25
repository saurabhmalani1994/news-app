"""D1 proof: deks lose wire datelines, credits and CMS trailers, keep their own words,
and end on a whole sentence that fits the tier, never mid thought. Samples are written
in the shapes the live pool carries, not copied from it."""
import re

import pytest

from app.build import CHARS_PER_LINE, DEK_LINES, render
from app.dek import ELLIPSIS, EN_DASH, fit_dek, sentences, strip_wire_junk
from app.frontpage import clean_dek
from tests.test_render import _parse

EM_DASH = chr(0x2014)


@pytest.mark.parametrize("raw, clean", [
    ("WASHINGTON -- The president met the premier at an air base on Wednesday.",
     "The president met the premier at an air base on Wednesday."),
    ("LONDON (Reuters) - Britain's central bank held rates steady on Thursday.",
     "Britain's central bank held rates steady on Thursday."),
    ("(AP) - A wildfire forced hundreds from their homes overnight.",
     "A wildfire forced hundreds from their homes overnight."),
    ("(AP) " + EM_DASH + " Rescuers reached the village by boat.",
     "Rescuers reached the village by boat."),
    ("NAGOYA, Japan, Sept. 24 (Yonhap) -- South Korea took the gold in the relay.",
     "South Korea took the gold in the relay."),
    ("BEIRUT, Lebanon " + EM_DASH + " Talks resumed after a week of strikes.",
     "Talks resumed after a week of strikes."),
    ("GAZA CITY - Aid trucks crossed at dawn.", "Aid trucks crossed at dawn."),
    ("[Relief Agency] New York/Nairobi/Khartoum -- Drone strikes hit two warehouses.",
     "Drone strikes hit two warehouses."),
    ("[Radio Desk] Eastern Chad / Darfur -- Refugees in the camps called for a truce.",
     "Refugees in the camps called for a truce."),
    ("New York -- the council meets again on Friday.", "The council meets again on Friday."),
])
def test_leading_datelines_and_credits_are_stripped(raw, clean):
    assert strip_wire_junk(raw) == clean


@pytest.mark.parametrize("raw, clean", [
    ("The storm turned north overnight. Continue reading...", "The storm turned north overnight."),
    ("Rates were held. The post Bank holds rates as inflation cools appeared first on Daily Ledger .",
     "Rates were held."),
    ("Markets rose for a third day. Read full story here", "Markets rose for a third day."),
    ("He said the plan would pass. The vote is [" + ELLIPSIS + "]", "He said the plan would pass. The vote is"),
    ("He said the plan would pass. The vote is [...]", "He said the plan would pass. The vote is"),
])
def test_trailing_cms_lines_are_stripped(raw, clean):
    assert strip_wire_junk(raw) == clean


@pytest.mark.parametrize("raw", [
    "US President Donald Trump greeted Chinese President Xi Jinping on Wednesday.",
    "Republican National Committee (RNC) Chair said Wednesday he expects gains.",
    "iPhone sales slowed in the quarter, the company said.",
    "A Vance-led task force drops 760,000 enrollments - citing fraud.",
    "Scammers use a two-step trick: first a retailer, then the regulator.",
    "BREAKING NEWS: Japan to closely monitor the summit",
])
def test_ordinary_deks_are_untouched(raw):
    assert strip_wire_junk(raw) == raw


def test_leftover_double_hyphen_becomes_a_spaced_en_dash_and_never_an_em_dash():
    out = strip_wire_junk("The summit -- the third this year -- ended early. Talks--again--stalled.")
    assert out == (f"The summit {EN_DASH} the third this year {EN_DASH} ended early. "
                   f"Talks {EN_DASH} again {EN_DASH} stalled.")
    assert EM_DASH not in out
    # A censored word keeps its hyphens.
    assert strip_wire_junk("A sign read NO F---ING WAY.") == "A sign read NO F---ING WAY."


def test_dateline_only_dek_is_dropped_and_title_repeat_still_dropped():
    assert clean_dek({"title": "Rates held", "dek": "LONDON (Reuters) - "}) == ""
    assert clean_dek({"title": "Rates held", "dek": "WASHINGTON -- Rates held, again"}) == ""
    assert clean_dek({"title": "Rates held", "dek": "WASHINGTON -- The Fed paused."}) == "The Fed paused."


def test_sentences_do_not_split_on_abbreviations_or_initials():
    text = ("Eight U.S. sailors were hurt, Gen. Smith said. Mr. Lee of Washington, D.C. "
            "disagreed. The inquiry opens Friday.")
    assert sentences(text) == [
        "Eight U.S. sailors were hurt, Gen. Smith said.",
        "Mr. Lee of Washington, D.C. disagreed.",
        "The inquiry opens Friday.",
    ]


def test_fit_ends_on_the_last_whole_sentence_inside_the_budget():
    text = ("Lawyers for three outlets asked a judge to restore their access. "
            "The White House says access is a privilege. A ruling is expected next week.")
    assert fit_dek(text, 114) == ("Lawyers for three outlets asked a judge to restore their access. "
                                  "The White House says access is a privilege.")
    assert fit_dek(text, 70) == "Lawyers for three outlets asked a judge to restore their access."
    assert fit_dek(text, 500) == text


def test_fit_never_keeps_a_fragment_the_feed_cut_short():
    text = "The letter came in reply to a senator. It said conditions aboard the " + ELLIPSIS
    assert fit_dek(text, 500) == "The letter came in reply to a senator."
    cut = strip_wire_junk("The yard ships a hull a year. The prolonged time at sea sparked [...]")
    assert fit_dek(cut, 500) == "The yard ships a hull a year."


def test_only_an_over_long_first_sentence_ends_on_an_ellipsis_at_a_clause_or_word():
    long_first = ("The president greeted the premier in a rare welcome at a military base near "
                  "the capital on Wednesday, as the premier began a three day visit. Short.")
    assert fit_dek(long_first, 114) == (
        "The president greeted the premier in a rare welcome at a military base near "
        "the capital on Wednesday" + ELLIPSIS)
    no_clause = ("Lawyers representing the White House and the three media outlets banned from the "
                 "property sparred over the constitutional questions at the heart of the case.")
    shown = fit_dek(no_clause, 114)
    assert shown.endswith("sparred over the" + ELLIPSIS) and len(shown) <= 114
    assert no_clause.startswith(shown[:-1])  # whole words only
    assert fit_dek("", 114) == ""


def _pool_with_deks(deks):
    articles = [
        {"id": f"a{i}", "source_id": "s", "title": f"Headline number {i}", "dek": d,
         "url": f"https://example.com/{i}", "published_at": f"2026-09-24T0{i}:00:00Z"}
        for i, d in enumerate(deks)
    ]
    return {"generated_at": "2026-09-24T09:00:00Z", "sources": [{"id": "s", "name": "Wire"}],
            "articles": articles, "clusters": []}


def test_rendered_deks_are_clean_and_end_on_a_sentence():
    wire = ("WASHINGTON -- The president greeted the premier at an air base. The two sides then met "
            "for talks on trade. A dinner followed at the residence. The premier leaves Friday "
            "for two more stops. Continue reading...")
    parsed = _parse(render(_pool_with_deks([wire, wire, wire])))
    shown = [(d, t) for d, t in zip(parsed.deks, parsed.tiers) if d]
    assert {t for _, t in shown} == {"hero", "secondary"}
    for dek, tier in shown:
        assert not dek.startswith("WASHINGTON")
        assert "Continue reading" not in dek and EM_DASH not in dek
        assert re.search(r"[.!?]$", dek), dek
        assert len(dek) <= DEK_LINES[tier] * CHARS_PER_LINE
    hero = next(d for d, t in shown if t == "hero")
    lead = next(d for d, t in shown if t == "secondary")
    assert len(hero) > len(lead)  # four lines hold more than three


# R2: a fitted dek must also wrap inside its tier's line clamp, measured in the dek face
# (app/dek_widths.py). Three shapes a character budget alone let through on a real pool
# (u1_check.mjs: 3 of 515 Today summaries met the clamp), written here, not copied.
CJK = "".join(chr(0x6771 + i % 40) for i in range(90)) + chr(0x3002)


def test_dek_lines_counts_wide_text_and_whole_words():
    from app.dek import dek_lines
    assert dek_lines("") == 0
    assert dek_lines("A short dek.") == 1
    # One em a CJK character: 64 of them never fit two lines of a 280px box at 16.5px.
    assert dek_lines(CJK[:64]) >= 4
    # A word never splits at a hyphen or mid word: the same letters wrap later as one.
    assert dek_lines("x " * 30) <= dek_lines("x" * 59)
    # Capitals are wider than lowercase.
    assert dek_lines("W" * 40) > dek_lines("i" * 40)


@pytest.mark.parametrize("tier, text", [
    ("text_only", "In Walvis Bay, the African Development Bank Group will provide loans."),
    ("secondary", "Several newly elected assembly members protest at an event led by an anti-war veterans "
                  "group alongside Hernandez, a former mayor. The rest follows."),
    ("text_only", CJK),
    ("hero", "WWWW MMMM " * 30),
])
def test_fitted_deks_wrap_inside_the_clamp(tier, text):
    from app.dek import dek_lines
    from app.frontpage import dek_budget, dek_clamp
    from app.typography import smart_quotes
    assert dek_lines(smart_quotes(fit_dek(text, dek_budget(tier)))) > dek_clamp(tier)  # the old fit overflowed
    fitted = fit_dek(text, dek_budget(tier), dek_clamp(tier))
    assert fitted and len(fitted) <= dek_budget(tier)
    assert dek_lines(smart_quotes(fitted)) <= dek_clamp(tier)
    assert fitted.endswith(ELLIPSIS) or text.startswith(fitted)


def test_the_clamp_only_ever_shortens_the_character_fit():
    text = ("Lawyers for three outlets asked a judge to restore their access. "
            "The White House says access is a privilege. A ruling is expected next week.")
    for tier in ("hero", "secondary", "river", "text_only"):
        from app.frontpage import dek_budget, dek_clamp
        plain, clamped = fit_dek(text, dek_budget(tier)), fit_dek(text, dek_budget(tier), dek_clamp(tier))
        assert plain.startswith(clamped.rstrip(ELLIPSIS)) or clamped == plain
