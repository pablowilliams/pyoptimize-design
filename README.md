# PyOptimize — Design and Specification

Design and specification repository for **PyOptimize**, a machine-learning-assisted system that reads Python source code and identifies measurable opportunities to execute it more efficiently.

This repo contains the academic-style design report that specifies the full system: a seven-stage pipeline that combines deterministic static analysis, runtime profiling, and language-model reasoning behind a strict verifier, together with a dashboard for reviewing and triaging findings.

## Contents

| File | Description |
|---|---|
| [`PyOptimize_Design_Report.pdf`](PyOptimize_Design_Report.pdf) | The primary deliverable — a 14-page, ~5,200-word technical design and specification report. |
| [`report.md`](report.md) | Markdown source for the report. |
| [`build_pdf.py`](build_pdf.py) | Reportlab-based build script that renders `report.md` to PDF. |

## Rebuilding the PDF

```bash
python3 -m pip install reportlab
python3 build_pdf.py
```

The script writes `PyOptimize_Design_Report.pdf` next to itself.

## Report structure

1. Abstract
2. Introduction — problem statement, motivation, research questions, scope
3. Background and related work — static analysis, ML-for-code, Python profiling, the gap
4. System architecture — design principles, pipeline, data flow
5. Component specifications — ingestion, static analyser, profiler integration, signal fusion, LLM reasoner, rewrite engine, verifier, reporting
6. Dashboard design — views, technical stack, accessibility
7. Evaluation methodology — datasets, metrics, regression gates
8. Implementation roadmap — four-week plan
9. Risk analysis
10. Ethical considerations
11. Conclusion
12. Appendices — pattern catalogue, data contracts, deployment, development conventions, glossary

## Two artefacts per analysis run

Every run of PyOptimize produces:

- An **academic-style PDF report** documenting each finding, the proposed rewrite, the rationale, and the measured speedup and memory impact.
- An **interactive dashboard** (Next.js + Tailwind) with five views: Overview, Findings, Suggestion Detail, History, and Settings.

See section 5 of the report for the full dashboard specification, including accessibility requirements that target WCAG AA.

## Status

This repository currently contains the design specification only. Implementation follows the four-week roadmap described in section 7 of the report.
