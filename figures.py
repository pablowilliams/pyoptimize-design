"""Programmatic figures for the PyOptimize design report.

Each factory returns a reportlab Drawing that is embedded directly in the PDF.
Nothing is rasterised; everything is vector.
"""

from __future__ import annotations

from reportlab.graphics.shapes import (
    Drawing,
    Group,
    Line,
    Polygon,
    Rect,
    String,
)
from reportlab.lib import colors

# Palette -- keep in sync with build_pdf.py
NAVY = colors.HexColor("#0a1f44")
STEEL = colors.HexColor("#2a3a5e")
INK = colors.HexColor("#1c2536")
MUTED = colors.HexColor("#5c6a82")
ACCENT = colors.HexColor("#b8860b")
BG = colors.HexColor("#f4f6fb")
SOFT = colors.HexColor("#e4e8f1")
WHITE = colors.HexColor("#ffffff")
BORDER = colors.HexColor("#c7cfe0")


def _box(
    x: float,
    y: float,
    w: float,
    h: float,
    label: str,
    *,
    fill=WHITE,
    stroke=NAVY,
    text_color=INK,
    font_size: float = 9,
    bold: bool = False,
) -> Group:
    g = Group()
    g.add(Rect(x, y, w, h, fillColor=fill, strokeColor=stroke, strokeWidth=0.8, rx=3, ry=3))
    font = "Helvetica-Bold" if bold else "Helvetica"
    # Centre label; split on \n
    lines = label.split("\n")
    total_h = len(lines) * (font_size + 2)
    start_y = y + h / 2 + total_h / 2 - font_size
    for i, line in enumerate(lines):
        g.add(
            String(
                x + w / 2,
                start_y - i * (font_size + 2),
                line,
                fontName=font,
                fontSize=font_size,
                fillColor=text_color,
                textAnchor="middle",
            )
        )
    return g


def _arrow(x1: float, y1: float, x2: float, y2: float, color=STEEL) -> Group:
    g = Group()
    g.add(Line(x1, y1, x2, y2, strokeColor=color, strokeWidth=1.1))
    # Arrowhead
    import math

    angle = math.atan2(y2 - y1, x2 - x1)
    ah = 5
    aw = 3
    tip_x, tip_y = x2, y2
    left_x = tip_x - ah * math.cos(angle) + aw * math.sin(angle)
    left_y = tip_y - ah * math.sin(angle) - aw * math.cos(angle)
    right_x = tip_x - ah * math.cos(angle) - aw * math.sin(angle)
    right_y = tip_y - ah * math.sin(angle) + aw * math.cos(angle)
    g.add(
        Polygon(
            points=[tip_x, tip_y, left_x, left_y, right_x, right_y],
            fillColor=color,
            strokeColor=color,
            strokeWidth=0.5,
        )
    )
    return g


def _caption(d: Drawing, text: str) -> None:
    d.add(
        String(
            d.width / 2,
            6,
            text,
            fontName="Helvetica-Oblique",
            fontSize=8.5,
            fillColor=MUTED,
            textAnchor="middle",
        )
    )


# ---------------------------------------------------------------------------
# Figure 1 -- System architecture pipeline
# ---------------------------------------------------------------------------
def figure_pipeline() -> Drawing:
    d = Drawing(460, 230)
    # Frame
    d.add(Rect(0, 0, 460, 230, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Row 1 -- inputs
    d.add(_box(15, 160, 78, 34, "Source code", fill=SOFT, bold=True))
    d.add(_box(15, 105, 78, 34, "Profiler\nentry point", fill=SOFT))

    # Static + Profiler stages
    d.add(_box(115, 160, 78, 34, "Static\nAnalyser", fill=WHITE))
    d.add(_box(115, 105, 78, 34, "Profiler\nIntegration", fill=WHITE))

    # Merge
    d.add(_box(215, 130, 80, 34, "Signal\nFusion", fill=NAVY, text_color=WHITE, stroke=NAVY, bold=True))

    # Reasoner -> Rewrite -> Verifier chain
    d.add(_box(317, 160, 70, 34, "LLM\nReasoner", fill=WHITE))
    d.add(_box(317, 105, 70, 34, "Rewrite\nEngine", fill=WHITE))
    d.add(_box(317, 50, 70, 34, "Verifier", fill=WHITE))

    # Reporting
    d.add(_box(217, 50, 80, 34, "Reporting", fill=NAVY, text_color=WHITE, stroke=NAVY, bold=True))

    # Outputs
    d.add(_box(110, 20, 90, 26, "PDF Report", fill=SOFT))
    d.add(_box(10, 20, 90, 26, "Dashboard DB", fill=SOFT))

    # Arrows
    d.add(_arrow(93, 177, 115, 177))
    d.add(_arrow(93, 122, 115, 122))
    d.add(_arrow(193, 177, 215, 160))
    d.add(_arrow(193, 122, 215, 140))
    d.add(_arrow(295, 147, 317, 177))
    d.add(_arrow(352, 160, 352, 139))
    d.add(_arrow(352, 105, 352, 84))
    d.add(_arrow(317, 67, 297, 67))
    d.add(_arrow(217, 55, 200, 40))
    d.add(_arrow(217, 62, 100, 40))

    _caption(d, "Figure 1. The seven-stage PyOptimize pipeline. Two input sources feed signal fusion, which drives a linear verify-and-report chain.")
    return d


# ---------------------------------------------------------------------------
# Figure 2 -- Signal fusion priority score
# ---------------------------------------------------------------------------
def figure_priority_score() -> Drawing:
    d = Drawing(460, 150)
    d.add(Rect(0, 0, 460, 150, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Three input factors
    d.add(_box(25, 65, 95, 40, "Pattern\nconfidence", fill=WHITE))
    d.add(_box(25, 15, 95, 40, "log(runtime\nshare)", fill=WHITE))
    d.add(_box(25, 115, 95, 30, "Test coverage\nmultiplier", fill=WHITE))

    # Multiplier node
    d.add(_box(180, 60, 70, 45, "×", fill=NAVY, text_color=WHITE, stroke=NAVY, font_size=18, bold=True))

    # Output
    d.add(_box(305, 60, 130, 45, "priority\nscore", fill=SOFT, bold=True))

    # Arrows from inputs
    d.add(_arrow(120, 130, 180, 95))
    d.add(_arrow(120, 85, 180, 85))
    d.add(_arrow(120, 35, 180, 72))
    # Out
    d.add(_arrow(250, 82, 305, 82))

    # Threshold note
    d.add(
        String(
            230,
            110,
            "findings below threshold are dropped before the reasoner is called",
            fontName="Helvetica-Oblique",
            fontSize=8,
            fillColor=MUTED,
            textAnchor="middle",
        )
    )

    _caption(d, "Figure 2. Signal-fusion priority score. The reasoner is only invoked on findings that clear the threshold.")
    return d


# ---------------------------------------------------------------------------
# Figure 3 -- Verifier decision gate
# ---------------------------------------------------------------------------
def figure_verifier() -> Drawing:
    d = Drawing(460, 320)
    d.add(Rect(0, 0, 460, 320, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Start
    d.add(_box(160, 275, 140, 28, "Candidate rewrite", fill=NAVY, text_color=WHITE, stroke=NAVY, bold=True))

    # Decision 1
    d.add(_box(160, 215, 140, 34, "Tests pass?", fill=WHITE))
    d.add(_box(320, 215, 125, 34, "Reject\n(behaviour)", fill=SOFT, text_color=INK))
    d.add(_arrow(230, 275, 230, 249))
    d.add(_arrow(300, 232, 320, 232))
    d.add(String(312, 237, "No", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))

    # Decision 2
    d.add(_box(160, 150, 140, 34, "Speedup ≥ 10%?", fill=WHITE))
    d.add(_box(320, 150, 125, 34, "Reject\n(performance)", fill=SOFT, text_color=INK))
    d.add(_arrow(230, 215, 230, 184))
    d.add(_arrow(300, 167, 320, 167))
    d.add(String(312, 172, "No", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))
    d.add(String(238, 204, "Yes", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))

    # Decision 3
    d.add(_box(160, 85, 140, 34, "Memory within\nbudget?", fill=WHITE))
    d.add(_box(320, 85, 125, 34, "Reject\n(memory)", fill=SOFT, text_color=INK))
    d.add(_arrow(230, 150, 230, 119))
    d.add(_arrow(300, 102, 320, 102))
    d.add(String(312, 107, "No", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))
    d.add(String(238, 139, "Yes", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))

    # Accept
    d.add(_box(160, 30, 140, 34, "Accept suggestion", fill=NAVY, text_color=WHITE, stroke=NAVY, bold=True))
    d.add(_arrow(230, 85, 230, 64))
    d.add(String(238, 74, "Yes", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))

    _caption(d, "Figure 3. Verifier decision gate. A suggestion is surfaced only if it clears all three checks in order.")
    return d


# ---------------------------------------------------------------------------
# Figure 4 -- Dashboard overview wireframe
# ---------------------------------------------------------------------------
def figure_dashboard() -> Drawing:
    d = Drawing(460, 270)
    d.add(Rect(0, 0, 460, 270, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Browser chrome
    d.add(Rect(15, 15, 430, 235, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.8, rx=3, ry=3))
    d.add(Rect(15, 225, 430, 25, fillColor=SOFT, strokeColor=BORDER, strokeWidth=0.6, rx=3, ry=3))
    # Traffic dots
    for i, col in enumerate([colors.HexColor("#d97757"), colors.HexColor("#d7b56d"), colors.HexColor("#6ea97a")]):
        d.add(Rect(25 + i * 12, 234, 7, 7, fillColor=col, strokeColor=col, rx=3.5, ry=3.5))
    d.add(
        String(
            85,
            234,
            "pyoptimize.local / Overview",
            fontName="Helvetica",
            fontSize=8,
            fillColor=MUTED,
        )
    )

    # Sidebar nav
    d.add(Rect(25, 30, 80, 185, fillColor=SOFT, strokeColor=BORDER, strokeWidth=0.5))
    for i, item in enumerate(["Overview", "Findings", "Detail", "History", "Settings"]):
        fill = NAVY if i == 0 else SOFT
        text = WHITE if i == 0 else INK
        d.add(Rect(30, 195 - i * 26, 70, 20, fillColor=fill, strokeColor=BORDER, strokeWidth=0.3, rx=2, ry=2))
        d.add(
            String(
                65,
                200 - i * 26,
                item,
                fontName="Helvetica-Bold" if i == 0 else "Helvetica",
                fontSize=8,
                fillColor=text,
                textAnchor="middle",
            )
        )

    # Metric cards
    labels = [
        ("Accepted", "127"),
        ("Geo-mean", "2.8×"),
        ("Reject", "18%"),
        ("Runs", "42"),
    ]
    for i, (label, value) in enumerate(labels):
        x = 115 + i * 82
        d.add(Rect(x, 170, 72, 45, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.5, rx=2, ry=2))
        d.add(String(x + 36, 200, value, fontName="Helvetica-Bold", fontSize=12, fillColor=NAVY, textAnchor="middle"))
        d.add(String(x + 36, 180, label, fontName="Helvetica", fontSize=7.5, fillColor=MUTED, textAnchor="middle"))

    # Chart area with bars
    d.add(Rect(115, 80, 320, 80, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.5, rx=2, ry=2))
    d.add(String(125, 148, "Findings by pattern category", fontName="Helvetica-Bold", fontSize=8, fillColor=INK))
    heights = [45, 30, 55, 22, 38, 18]
    pattern_labels = ["LOOP", "PD", "NP", "DS", "IO", "MEM"]
    for i, (h, lab) in enumerate(zip(heights, pattern_labels)):
        x = 135 + i * 45
        d.add(Rect(x, 90, 28, h, fillColor=NAVY, strokeColor=NAVY))
        d.add(String(x + 14, 83, lab, fontName="Helvetica", fontSize=7, fillColor=MUTED, textAnchor="middle"))

    # Findings list sketch
    d.add(Rect(115, 30, 320, 42, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.5, rx=2, ry=2))
    d.add(String(125, 62, "Top suggestions", fontName="Helvetica-Bold", fontSize=8, fillColor=INK))
    for i in range(2):
        d.add(Rect(125, 44 - i * 10, 300, 7, fillColor=SOFT, strokeColor=BORDER, strokeWidth=0.3, rx=1, ry=1))

    _caption(d, "Figure 4. Dashboard Overview wireframe -- sidebar navigation, metric cards, pattern histogram, and suggestion list.")
    return d


# ---------------------------------------------------------------------------
# Figure 5 -- Roadmap timeline
# ---------------------------------------------------------------------------
def figure_roadmap() -> Drawing:
    d = Drawing(460, 210)
    d.add(Rect(0, 0, 460, 210, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Axis
    axis_y = 30
    d.add(Line(70, axis_y, 440, axis_y, strokeColor=MUTED, strokeWidth=0.6))
    for i, label in enumerate(["Week 1", "Week 2", "Week 3", "Week 4"]):
        x = 70 + i * 92.5 + 46
        d.add(Line(70 + i * 92.5, axis_y - 3, 70 + i * 92.5, axis_y + 3, strokeColor=MUTED, strokeWidth=0.6))
        d.add(String(x, axis_y - 14, label, fontName="Helvetica-Bold", fontSize=9, fillColor=INK, textAnchor="middle"))
    d.add(Line(440, axis_y - 3, 440, axis_y + 3, strokeColor=MUTED, strokeWidth=0.6))

    # Bars
    rows = [
        ("Static analyser + detectors", 0, 1, NAVY),
        ("LLM reasoner + rewrite engine", 1, 1, STEEL),
        ("Profiler + signal fusion + reporting", 2, 1, NAVY),
        ("Dashboard (Next.js + 5 views)", 3, 1, STEEL),
        ("Evaluation suite + CI integration", 0, 4, ACCENT),
    ]
    for i, (label, start, span, col) in enumerate(rows):
        y = 170 - i * 25
        x = 70 + start * 92.5 + 4
        w = span * 92.5 - 8
        d.add(Rect(x, y, w, 16, fillColor=col, strokeColor=col, rx=2, ry=2))
        # Label left of bar
        d.add(
            String(
                65,
                y + 4,
                label,
                fontName="Helvetica",
                fontSize=8,
                fillColor=INK,
                textAnchor="end",
            )
        )

    # Legend note
    d.add(
        String(
            230,
            15,
            "Continuous deliverable shown in gold spans all four weeks.",
            fontName="Helvetica-Oblique",
            fontSize=8,
            fillColor=MUTED,
            textAnchor="middle",
        )
    )

    _caption(d, "Figure 5. Implementation roadmap. Core pipeline is built week by week; evaluation runs alongside throughout.")
    return d


# ---------------------------------------------------------------------------
# Figure 6 -- Data model entity relationships
# ---------------------------------------------------------------------------
def figure_data_model() -> Drawing:
    d = Drawing(460, 200)
    d.add(Rect(0, 0, 460, 200, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    def entity(x: float, y: float, title: str, fields: list[str]) -> Group:
        g = Group()
        h = 24 + len(fields) * 13
        g.add(Rect(x, y, 95, h, fillColor=WHITE, strokeColor=NAVY, strokeWidth=0.8, rx=2, ry=2))
        g.add(Rect(x, y + h - 20, 95, 20, fillColor=NAVY, strokeColor=NAVY, rx=2, ry=2))
        g.add(
            String(
                x + 47.5,
                y + h - 14,
                title,
                fontName="Helvetica-Bold",
                fontSize=9,
                fillColor=WHITE,
                textAnchor="middle",
            )
        )
        for i, f in enumerate(fields):
            g.add(
                String(
                    x + 6,
                    y + h - 34 - i * 13,
                    f,
                    fontName="Helvetica",
                    fontSize=7.5,
                    fillColor=INK,
                )
            )
        return g, h

    run, run_h = entity(25, 90, "Run", ["id", "started_at", "target", "model", "config_hash"])
    finding, f_h = entity(140, 90, "Finding", ["id", "run_id", "file", "pattern", "score"])
    sug, s_h = entity(255, 90, "Suggestion", ["id", "finding_id", "diff", "status"])
    meas, m_h = entity(370, 90, "Measurement", ["id", "suggestion_id", "t_before", "t_after"])

    d.add(run)
    d.add(finding)
    d.add(sug)
    d.add(meas)

    # 1-to-many lines
    mid_y = 90 + run_h / 2
    d.add(Line(120, mid_y, 140, 90 + f_h / 2, strokeColor=STEEL, strokeWidth=0.8))
    d.add(Line(235, 90 + f_h / 2, 255, 90 + s_h / 2, strokeColor=STEEL, strokeWidth=0.8))
    d.add(Line(350, 90 + s_h / 2, 370, 90 + m_h / 2, strokeColor=STEEL, strokeWidth=0.8))

    # Relationship labels
    d.add(String(130, 105, "1..N", fontName="Helvetica-Oblique", fontSize=7, fillColor=MUTED, textAnchor="middle"))
    d.add(String(245, 105, "1..N", fontName="Helvetica-Oblique", fontSize=7, fillColor=MUTED, textAnchor="middle"))
    d.add(String(360, 105, "1..N", fontName="Helvetica-Oblique", fontSize=7, fillColor=MUTED, textAnchor="middle"))

    _caption(d, "Figure 6. Data model. Four tables support every view in the dashboard and every section in the generated report.")
    return d


# ---------------------------------------------------------------------------
# Registry used by the markdown renderer
# ---------------------------------------------------------------------------
FIGURES = {
    "pipeline": figure_pipeline,
    "priority": figure_priority_score,
    "verifier": figure_verifier,
    "dashboard": figure_dashboard,
    "roadmap": figure_roadmap,
    "data_model": figure_data_model,
}
