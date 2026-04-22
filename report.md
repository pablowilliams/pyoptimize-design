# PyOptimize: A Machine-Learning-Assisted System for Automated Detection and Remediation of Performance Inefficiencies in Python Code

**A Technical Design and Specification Report**

Author: Project Proposal
Date: 2026-04-22
Version: 1.0

---

## Abstract

This report specifies the end-to-end design of PyOptimize, a machine-learning-assisted system that reads Python source code and identifies concrete, measurable opportunities to execute that code more efficiently. The system combines three complementary signal sources: deterministic static analysis over the abstract syntax tree, runtime profile information gathered through lightweight instrumentation, and a large-language-model reasoning stage that synthesises these signals into human-readable explanations and candidate rewrites. A verification layer built on automated test execution and micro-benchmarks gates every suggested rewrite behind measured speedup and behavioural equivalence, so the system only surfaces optimizations that demonstrably hold. Two artefacts are produced for every analysed project: an academic-style written report detailing each finding with before-and-after code, measured impact, and rationale; and an interactive dashboard that allows a developer to explore findings, filter by severity, accept or reject rewrites, and track progress over time. This document defines the system architecture, component responsibilities, data contracts, evaluation methodology, risk profile, and a four-week implementation roadmap. The report is deliberately written as a design specification rather than a literature review; where external tools are referenced, only well-established, verifiable open-source projects are cited.

---

## 1. Introduction

### 1.1 Problem Statement

Python is the dominant language for data work, scripting, and increasingly for production services. Its dynamism and expressiveness come at a cost: a single idiomatic-looking line can hide an order-of-magnitude performance penalty. A DataFrame iterated with `iterrows()` is typically one to two orders of magnitude slower than a vectorised equivalent. A nested loop that performs a membership test against a list is asymptotically worse than the same loop against a set. A loop that builds a string through repeated concatenation allocates quadratically rather than linearly. These inefficiencies are well known to expert Python engineers but are not consistently caught by linters, type checkers, or standard review processes, because most such tools are oriented toward correctness, style, and typing rather than execution cost. The result is that slow Python code ships, runs, and accumulates cost in production long after it was written.

### 1.2 Motivation

There are three converging motivations for attacking this problem now. First, large language models have become genuinely competent at reading and rewriting code, and the engineering effort required to integrate them into developer tooling is small relative to the lift they provide. Second, the Python profiling ecosystem has matured to the point that extracting per-line runtime cost is a routine operation rather than a research project. Third, deterministic static analysis built on the concrete syntax tree is far stronger than it was five years ago, largely due to projects such as LibCST that preserve formatting and comments across transformations, making automated rewriting practical without destroying the reviewability of the source. When these three capabilities are combined and gated behind a verifier that requires measured improvement, the result is a tool that is both more precise than rule-based linters and more trustworthy than a standalone LLM suggestion.

### 1.3 Research Questions

The project is organised around four questions that double as evaluation criteria:

1. Can a hybrid static-plus-runtime-plus-LLM pipeline propose optimizations that yield a measurable speedup on a held-out benchmark of real Python functions?
2. What fraction of proposed rewrites preserve observable behaviour as judged by existing and property-based tests?
3. How much additional value does a runtime profile provide over pure static analysis, expressed as precision, recall, and the geometric mean speedup of accepted suggestions?
4. Can the final tool be packaged in a way that a working developer will actually adopt, measured by time-to-first-suggestion and friction of applying a rewrite?

### 1.4 Contributions and Scope

The project delivers three artefacts: a command-line tool that analyses a Python file or project; a written report generator that produces an academic-style document for each analysis run; and a web dashboard that renders the same findings interactively. The scope is deliberately narrow. PyOptimize targets single-process CPython, with a strong initial focus on numerical and data-manipulation code written against pandas, NumPy, and the standard library. It does not attempt to optimise parallel or distributed code, GPU workloads, Cython extensions, or code that depends on subprocess orchestration; those are left as future work.

---

## 2. Background and Related Work

### 2.1 Static Analysis for Performance

Traditional Python linters such as pyflakes, pylint, and ruff are predominantly correctness and style tools. A small number of performance-oriented rules exist within these tools, but coverage is sparse and the rules tend to be narrow pattern matches. Performance-specific linters, including the perflint project and a handful of ruff plugins, extend this to more patterns but remain fundamentally rule-based, with no awareness of where the hot code actually runs. Their strength is precision on known anti-patterns; their weakness is an inability to recognise novel inefficiencies or reason about whether a match is worth acting on.

### 2.2 Machine-Learning Approaches to Code Optimization

A separate line of work uses machine learning to learn optimization transformations from data. The most directly relevant dataset is the PIE benchmark, a collection of human-written slow-to-fast Python edits harvested from competitive programming submissions. Fine-tuned and few-shot-prompted language models have been shown to reproduce a meaningful fraction of these edits. The weakness of these approaches is twofold: the benchmark distribution is skewed toward competitive-programming idioms rather than real application code, and ML suggestions, absent verification, regularly break correctness in subtle ways. PyOptimize does not train a new model at the outset; it instead uses a strong general-purpose language model as a reasoner and invests heavily in the verification layer.

### 2.3 Python Profiling

The Python profiling ecosystem is mature. The standard library ships with cProfile and tracemalloc. Third-party tools include py-spy for sampling profiling of running processes with minimal overhead, scalene for combined CPU, memory, and GPU profiling with per-line granularity, and memory_profiler for line-level heap usage. These tools produce structured output that can be consumed programmatically, which is the property PyOptimize relies upon.

### 2.4 The Gap This Project Addresses

Three classes of tool exist independently today: static analysers that are precise but blind to runtime cost, profilers that show cost but suggest no remediation, and general LLM code assistants that propose rewrites without any grounding in measurement. No widely available tool fuses all three in a pipeline that verifies each suggestion behind a closed-loop correctness and speedup gate. PyOptimize occupies that gap.

---

## 3. System Architecture

### 3.1 Design Principles

The architecture is shaped by four principles. First, deterministic-before-probabilistic: rule-based static analysis runs before any language-model call, so findings are grounded in the concrete syntax tree rather than conjured by a model. Second, no unverified suggestion ships: every rewrite must pass a semantic-equivalence check and demonstrate a measured speedup before being surfaced. Third, incremental adoption: the tool must be useful on a single file with no configuration, and progressively more useful as the user opts into profiling, test generation, and project-wide analysis. Fourth, reviewability: every suggestion is presented as a diff with a plain-English rationale, because a suggestion a developer cannot evaluate is not useful.

### 3.2 High-Level Architecture

The system is a seven-stage pipeline. Source code enters the pipeline through an ingestion stage, flows through parallel static-analysis and profiling stages, merges in a signal-fusion stage that ranks candidate findings, proceeds to a language-model reasoning stage that produces rewrites, passes through a rewrite engine that ensures syntactic and structural safety, and finally reaches a verifier that confirms behavioural equivalence and measures impact. The output is written to a report generator and persisted to a data store that the dashboard reads from.

[FIGURE:pipeline]

### 3.3 Component Responsibilities

The ingestion stage is responsible for locating source files, parsing them with LibCST, and optionally exercising them through a user-supplied entry point to produce runtime profiles. The static analyser owns a plugin-based catalogue of pattern detectors, each of which returns a structured finding with a location, a pattern identifier, and a confidence score. The profiler integration normalises output from cProfile and scalene into a uniform per-line cost dictionary keyed by file path and line number. Signal fusion combines static findings with runtime costs into a prioritised candidate list, using a scoring function described in section 4.4. The language-model reasoner classifies each candidate as genuine or a false positive, explains the optimization in plain language, and proposes a rewrite as a structured diff. The rewrite engine applies the proposed diff through LibCST codemods, preserving formatting and comments, and runs a set of structural safety checks. The verifier executes the project's test suite against the rewritten code, supplements it with property-based tests where coverage is absent, and runs micro-benchmarks to measure speedup and memory impact. The reporting subsystem renders findings to an academic PDF report and writes structured records to the dashboard data store.

### 3.4 Data Flow

A typical run proceeds as follows. The user invokes the command-line tool against a directory. The ingestion stage discovers Python files and parses each into a LibCST module. If a profiler entry point has been provided, the profiler runs the user's code under cProfile or scalene and constructs a cost map. The static analyser walks each module, emitting findings. Signal fusion joins findings with the cost map and orders the list by a priority score. For each top-ranked finding, the reasoner is called to confirm the pattern and produce a rewrite. The rewrite is applied through the rewrite engine to a scratch copy of the source. The verifier runs tests and benchmarks against the rewritten copy, and if both checks pass with a meaningful speedup, the suggestion is retained. The report and dashboard artefacts are generated from the retained set.

---

## 4. Component Specifications

### 4.1 Ingestion

Ingestion accepts three input modes: a single file, a directory, or a repository root. For each input mode the component enumerates Python files that are not in standard exclusion paths such as virtual environments, build directories, and generated stubs. Each file is parsed with LibCST into a module tree; parse failures are logged but do not abort the run. The component also captures file-level metadata including size, last-modified time, and a content hash, which is used later for change detection so that re-runs only re-analyse files that have changed.

### 4.2 Static Analyser

The static analyser is organised around a PatternDetector base class. Each detector is a self-contained module that receives a LibCST node and yields zero or more Finding records. A Finding is a typed record containing the file path, start and end line and column, a pattern identifier from a fixed enumeration, a human-readable short description, a confidence score between zero and one, and a context window of up to ten lines before and after the match. The initial detector catalogue, which the project aims to ship on day one, is listed in Appendix A. Categories include loop anti-patterns, pandas anti-patterns, NumPy anti-patterns, data-structure misuse, input and output patterns, and memory anti-patterns. The catalogue is explicitly designed to be extended: adding a new detector is a matter of subclassing, registering, and writing a matcher, with no changes required elsewhere in the pipeline.

### 4.3 Profiler Integration

Profiler integration is optional but strongly recommended. The component supports two modes. In attached mode the user provides an entry-point callable or a script path; the profiler runs that entry point under cProfile and tracemalloc, and the resulting statistics are transformed into a per-line cost map. In sample mode the user attaches py-spy to a running process and dumps a profile, which is parsed and transformed into the same cost map. Scalene output is supported as an alternative high-fidelity source. The output of this component is a dictionary keyed by the tuple of file path and line number, containing cumulative runtime, self-time, call count, and peak memory attribution. If no profile is available the cost map is empty and later stages fall back to static-only scoring.

### 4.4 Signal Fusion

Signal fusion takes the list of Findings and the cost map and produces a prioritised candidate list. The priority score for a finding is the product of three factors. The first factor is the pattern confidence reported by the detector. The second factor is the logarithm of the runtime share attributable to the finding's lines, defaulting to a small constant when no profile data is available. The third factor is a coverage multiplier that rewards findings in regions covered by the project's existing tests, because those regions are safer to rewrite. Findings below a configurable minimum score are dropped. This stage exists to prevent the tool from spending tokens asking a language model to optimise cold code, which is a common failure mode of naive LLM-first approaches.

[FIGURE:priority]

### 4.5 Language-Model Reasoner

The reasoner communicates with an Anthropic API endpoint, currently targeting Claude Sonnet 4.6, through two calls per finding. The first call is a classification call: the model receives the finding, the surrounding context, the pattern description, and the profile data, and returns a structured response with fields for validity, rationale, estimated speedup category, and any prerequisites for the rewrite. The second call, conditional on the first, is a generation call: the model receives the same context and is asked to produce a minimal rewrite as a unified diff, constrained to preserve the function signature, module-level names, and behaviour. Both calls use structured-output schemas so that parsing does not rely on freeform text. Prompt caching is enabled on the system prompt and pattern catalogue to keep cost per finding low when the same run covers many files.

### 4.6 Rewrite Engine

The rewrite engine is the safety layer between a language-model suggestion and the source tree. A proposed diff is first parsed with LibCST to confirm it produces a syntactically valid module. The engine then runs a set of structural equivalence checks: the set of top-level public names must match, the signatures of modified functions must match, and no import is added that introduces a new external dependency unless explicitly whitelisted. If any check fails, the rewrite is rejected and the finding is recorded as unresolved. If the checks pass, the engine emits a codemod that applies the change while preserving original formatting and comments. Nothing is written to the user's source tree at this stage; the modified tree lives in a scratch working directory managed by the pipeline.

### 4.7 Verifier

The verifier is the most consequential component in the pipeline, because it is the one that decides whether a suggestion is surfaced to the user. Verification proceeds in three phases. The first phase is correctness: the project's existing pytest suite is run against the rewritten source. If no tests exist for the affected function, Hypothesis is used to generate property-based tests from the function signature, using type hints when available and shallow strategies when not. The second phase is performance: pytest-benchmark is used to measure execution time on representative inputs, and memory_profiler is used to measure peak memory. The benchmark inputs are drawn from the profiler's recorded call arguments when available and from Hypothesis strategies otherwise. The third phase is decision: a suggestion is accepted only if all tests pass, the runtime improvement is at least ten percent on the measured inputs, and the memory footprint is not materially worse. Accepted suggestions are recorded with full measurement data. Rejected suggestions are recorded with the reason so that the reporter can surface near-misses.

[FIGURE:verifier]

### 4.8 Reporting Subsystem

The reporting subsystem renders two artefacts from the run. The first is a structured record written to a local SQLite database that the dashboard reads from, consisting of a Run table, a Finding table, a Suggestion table, and a Measurement table. The second is an academic-style PDF report generated through the same reportlab pipeline used to produce this document, with a title page, an abstract summarising total findings and aggregate speedup, and a body section per accepted suggestion consisting of the finding, the diff, the rationale, and the measured impact. A machine-readable JSON export mirrors the database contents for downstream tooling.

---

## 5. Dashboard Design

### 5.1 Purpose

The PDF report is the archival artefact; the dashboard is the operational one. A developer reviewing a large run wants to filter, sort, and triage; a team lead wants to see trends across runs; a reviewer wants to accept or reject suggestions in bulk. The dashboard serves these interaction modes.

### 5.2 Views

The dashboard ships with five views. The Overview view shows the most recent run with a headline number for total accepted speedup, a distribution of findings by pattern, and a list of highest-impact suggestions. The Findings view is a filterable table with one row per finding, sortable by severity, runtime share, pattern, and file. The Suggestion Detail view shows the full before-and-after diff for a single suggestion, with benchmark results, memory measurements, and the rationale produced by the reasoner. The History view plots aggregate run metrics over time, including total findings, total accepted speedup, and coverage of the project by the detector set. The Settings view exposes the pattern catalogue with per-pattern enable and disable toggles, the minimum priority threshold, and the model selection.

[FIGURE:dashboard]

### 5.3 Technical Stack

The dashboard is a Next.js application using React Server Components where possible and plain client components where interaction demands it. Styling is handled through Tailwind CSS with a small set of design tokens that enforce contrast and spacing. Charts are rendered with a declarative charting library that outputs accessible SVG with proper ARIA labelling. State that does not require server coordination lives in URL search parameters, so every view is shareable as a link. The dashboard reads from the local SQLite store through a thin API route and from a remote deployment of the same schema in Postgres when configured for team use.

### 5.4 Accessibility Considerations

The dashboard is a first-class accessibility citizen. Every interactive control has an accessible name, every diff is presented as semantic HTML rather than an image, colour is never the sole carrier of meaning, keyboard navigation is continuous through the findings table with a visible focus ring, data tables use proper headers and scope attributes, and dynamic status changes such as accept-reject are announced through an ARIA live region. Contrast targets WCAG AA at minimum. The diff viewer supports a high-contrast mode and respects the operating system's reduced-motion preference.

---

## 6. Evaluation Methodology

Evaluation is built into the project from day one rather than deferred. Three datasets underpin the evaluation. The first is a curated subset of the PIE dataset, which supplies paired slow-and-fast Python functions with human-verified speedups. The second is a corpus of internally written pandas- and NumPy-heavy scripts collected from representative data-science projects, used to test the pandas and NumPy detectors against realistic code. The third is a small set of open-source Python utilities with public test suites, used as end-to-end verification targets because they have the tests the verifier needs to run. For each dataset three metrics are reported: the fraction of cases in which PyOptimize proposes any valid accepted suggestion, the geometric mean speedup across accepted suggestions, and the rate at which suggestions are rejected by the verifier for broken tests. A fourth metric tracks false positives, defined as findings raised by the static analyser that the reasoner classifies as invalid; this metric is important because a high false-positive rate signals that detector rules are too loose and erodes user trust. Results are reported per pattern category so that weak detectors can be identified and tuned. Evaluation is re-run on every release, and regression gates prevent merging a change that reduces any headline metric by more than a configured threshold.

---

## 7. Implementation Roadmap

Week one is dedicated to the deterministic core. The ingestion stage, static-analyser framework, and the first five pattern detectors are implemented. A minimal command-line entry point prints findings to the terminal. No language model is involved yet; the goal is to prove the static-analysis spine is reliable. Week two adds the reasoner and the rewrite engine. Structured-output prompts are written, the two-call reasoning pattern is wired up, and LibCST codemods applied. The verifier is introduced in skeletal form, running only the existing test suite without property-based augmentation. Week three adds profiler integration, signal fusion, property-based test generation, and the reporting subsystem, producing the first end-to-end run that yields an academic PDF. Week four is the dashboard week: the Next.js application is built, the database schema is finalised, and the five views are implemented. A stretch goal for week five is fine-tuning a small model on accepted suggestion data, but this is explicitly outside the critical path. Each week ends with a checkpoint: a tagged release, an updated README, and a re-run of the evaluation suite.

[FIGURE:roadmap]

---

## 8. Risk Analysis

The project has five principal risks. The first is semantic breakage: a rewrite appears to pass tests because the tests are weak, and ships a bug. Mitigation is property-based test generation and an explicit coverage reward in the signal-fusion score. The second is benchmark deception: a micro-benchmark shows a speedup that does not survive realistic input sizes. Mitigation is deriving benchmark inputs from the profiler's recorded call arguments and requiring benchmark stability across multiple input shapes. The third is model drift: a model upgrade changes the distribution of suggestions, silently regressing quality. Mitigation is a pinned model identifier in the release, with upgrades gated behind the full evaluation suite. The fourth is dependency fragility: pandas and NumPy evolve, and an optimization that was faster in one version is neutral or slower in another. Mitigation is version-pinned benchmarking and environment detection before suggesting version-specific rewrites. The fifth is over-optimization at the cost of readability: a rewrite is faster but harder to understand, trading one form of debt for another. Mitigation is a readability check that rejects rewrites exceeding a complexity budget.

---

## 9. Ethical Considerations

Two ethical considerations are worth explicit treatment. The first concerns the provenance of the training corpus for any future fine-tuning. The PIE dataset and any open-source code used for evaluation must be sourced from permissively licensed projects and attributed appropriately, and any human contributions to the dataset must be properly consented. The second concerns automated code change: tools that rewrite code without human oversight can introduce subtle defects at a scale that manual review cannot catch. PyOptimize commits to a human-in-the-loop posture at all times. No rewrite is ever applied to the user's source tree without an explicit accept action, and every accepted rewrite is recorded with a full audit trail so that a later reviewer can reconstruct why the change was proposed.

---

## 10. Conclusion

PyOptimize is a deliberately narrow, deliberately verifiable approach to a well-known problem. By combining deterministic static analysis, runtime profiling, and a language-model reasoner behind a strict verifier, the system can surface optimization suggestions that are both precise and trustworthy. The four-week roadmap delivers an end-to-end pipeline and a dashboard, and the evaluation methodology ensures that claims of speedup are backed by measurement rather than assertion. The two artefacts produced by every analysis run, an academic-style report and an interactive dashboard, serve the archival and operational needs of developers and reviewers respectively. The project is scoped to avoid the common failure modes of ML-for-code work: it does not over-promise, it does not train a model before it has to, and it does not surface anything it cannot measure.

---

## References and Tooling

This document is a design specification rather than a literature review. The following open-source tools and resources are referenced as concrete, verifiable dependencies of the proposed system.

- LibCST, a concrete syntax tree library for Python: https://github.com/Instagram/LibCST
- cProfile and tracemalloc, Python standard library profilers: https://docs.python.org/3/library/profile.html
- py-spy, a sampling profiler for Python: https://github.com/benfred/py-spy
- scalene, a high-precision CPU, GPU, and memory profiler: https://github.com/plasma-umass/scalene
- memory_profiler, line-by-line memory profiling: https://pypi.org/project/memory-profiler/
- pytest and pytest-benchmark, test framework and benchmarking plugin: https://docs.pytest.org/ and https://pytest-benchmark.readthedocs.io/
- Hypothesis, property-based testing: https://hypothesis.readthedocs.io/
- Anthropic Python SDK and Claude model family: https://docs.anthropic.com/
- Next.js, React, and Tailwind CSS for the dashboard: https://nextjs.org/, https://react.dev/, https://tailwindcss.com/
- Reportlab, the PDF generation library used to produce this document: https://www.reportlab.com/opensource/

The PIE dataset, referenced in section 2.2 as a source of paired slow-and-fast Python code, is used only as an evaluation resource. The authoritative description of that dataset and its licensing terms should be consulted by anyone who uses it.

---

## Appendix A: Initial Pattern Catalogue

The following patterns constitute the initial detector catalogue. Each pattern has a unique identifier used throughout the system.

Loop anti-patterns: LOOP-001 iteration by index where direct iteration would work, LOOP-002 manual accumulation where a built-in would apply, LOOP-003 repeated attribute or method lookup inside a loop body, LOOP-004 nested loops over the same collection admitting a sweep, LOOP-005 string concatenation in a loop.

Pandas anti-patterns: PD-001 use of iterrows or itertuples where vectorised operations apply, PD-002 apply over a column where a vectorised method exists, PD-003 chained filtering that scans the frame twice, PD-004 append or concat inside a loop, PD-005 groupby followed by apply where agg would suffice, PD-006 dtype mismatches that force object columns.

NumPy anti-patterns: NP-001 Python-level iteration over an array, NP-002 use of math module functions on arrays, NP-003 unnecessary copies through advanced indexing, NP-004 broadcastable operations expressed as loops, NP-005 wrong dtype causing upcasts.

Data-structure misuse: DS-001 membership test against a list where a set would be constant time, DS-002 repeated dict lookups where a local binding would cache, DS-003 use of list where deque is the appropriate structure, DS-004 sorted inside a loop body where the sort could be hoisted.

Input and output: IO-001 synchronous HTTP requests in a loop where batching or async would apply, IO-002 unbuffered file reads, IO-003 JSON decoding in a hot loop where a streaming parser would suffice.

Memory: MEM-001 construction of a full list where a generator would be consumed immediately, MEM-002 unbounded caches, MEM-003 large intermediate objects that could be released earlier, MEM-004 repeated allocation inside a loop where preallocation is feasible.

This catalogue is a starting point. The detector framework is designed so that adding a pattern requires writing only the matcher; the rest of the pipeline treats new patterns uniformly.

---

## Appendix B: Data Contracts

The dashboard and the reporting subsystem share a single data model, described here in schema-level prose rather than code.

A Run record contains a run identifier, a start and end timestamp, the target path, the tool version, the model identifier used for reasoning, and a configuration hash. A Finding record references its parent Run, and contains a finding identifier, a file path, a start and end line, a pattern identifier, a confidence score, a context window, and a priority score produced by signal fusion. A Suggestion record references its parent Finding, and contains a suggestion identifier, the proposed unified diff, the rationale text produced by the reasoner, and a status field with one of four values: accepted, rejected-behaviour, rejected-performance, or rejected-structural. A Measurement record references its parent Suggestion and contains runtime before and after, memory before and after, benchmark identifiers, and the wallclock measurement timestamps. These four tables are sufficient to reproduce every view in the dashboard and every section in the generated PDF.

[FIGURE:data_model]

---

## Appendix C: Deployment and Distribution

PyOptimize is distributed in three forms. The core command-line tool is published to PyPI as a standard Python package, installable through pip or pipx. The dashboard is published as a Docker image on GitHub Container Registry, runnable locally against a SQLite database or in a team deployment against Postgres. A GitHub Action is published to the GitHub Marketplace that runs the tool on every pull request, posts findings as review comments, and blocks the merge if a regression threshold is exceeded. Releases follow semantic versioning, with a pinned model identifier recorded in the release notes and the evaluation-suite results attached as a release artefact.

---

## Appendix D: Development Environment and Engineering Conventions

The project is developed against Python 3.11 as the minimum supported runtime, with continuous integration matrix runs against 3.11, 3.12, and 3.13. Dependency management uses a pyproject.toml with PEP 621 metadata, pinned development dependencies in a lockfile, and a strict separation between runtime and development dependencies so that end users do not pull in testing or evaluation tooling. The source tree is organised into five top-level packages: pyoptimize.ingest for file discovery and parsing, pyoptimize.detect for the static-analyser framework and pattern catalogue, pyoptimize.profile for profiler adaptors, pyoptimize.reason for the reasoner and prompt templates, and pyoptimize.verify for the verification pipeline. The dashboard lives in a sibling directory rather than inside the Python package so that it can be released and versioned independently.

Type checking uses pyright in strict mode on the entire Python package; any module failing strict checks is considered broken. Formatting is enforced by ruff with an explicit configuration committed to the repository. Commit messages follow Conventional Commits so that release notes can be generated automatically. Every pull request runs the full evaluation suite as a required check, and the aggregate metrics are posted back to the pull request as a comment so that reviewers can see at a glance whether the change regresses any headline number. A pre-commit hook runs the formatter and the fast subset of the linter to keep the repository consistent locally.

Test layout follows a mirrored tree: every module in pyoptimize has a corresponding test module in tests that shares the dotted path. Integration tests that exercise the full pipeline end-to-end live in a separate tests/integration directory and are marked with a pytest marker so that they can be opted out of during fast local iteration. A small set of fixture repositories, stored as tarballs in the repository, supplies realistic Python code for integration and end-to-end testing without requiring network access to external repositories at test time.

---

## Appendix E: Glossary

Accepted suggestion: a suggestion that has passed all verifier gates and is presented to the user as actionable.
Candidate finding: a Finding that has survived signal fusion and is about to be submitted to the reasoner.
Codemod: a structured code transformation expressed at the level of the concrete syntax tree.
Cost map: a dictionary keyed by file and line number that records runtime and memory cost at that location, produced by the profiler integration.
Detector: a plugin in the static analyser that emits Findings for a single pattern category.
False positive: a Finding that the reasoner rejects as not matching the claimed pattern.
Finding: a structured record representing one location in one file that matches one pattern.
Reasoner: the language-model component that classifies findings and produces rewrites.
Reviewability: the property that a suggestion can be evaluated by a human reader, which is treated as a first-class requirement alongside speedup.
Rewrite: a unified diff produced by the reasoner, parsed through the rewrite engine, and verified against tests and benchmarks before being surfaced.
Signal fusion: the stage that joins static findings with runtime profile data into a prioritised candidate list.
Suggestion: a Finding together with its associated rewrite and verification outcome.
Verifier: the component that runs tests and benchmarks to accept or reject a suggestion.

---

End of report.
