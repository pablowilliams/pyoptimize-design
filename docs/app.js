/*
 * PyOptimize Code Quality Scorer — client-side analyser.
 *
 * Flow:
 *   1. User picks a PDF via <input type="file">.
 *   2. pdf.js extracts text with page+line preservation.
 *   3. A regex-based rule set scans the text.
 *   4. Score is computed (100 minus severity-weighted deductions).
 *   5. Score, findings list, and highlighted code are rendered.
 *   6. State changes are announced via the existing polite live region.
 *
 * Accessibility decisions map to the handoff spec from accessibility-lead:
 *   - pdf.js text layer is never shown; we render our own <pre><code>.
 *   - Severity is conveyed by text + shape/border-style + colour.
 *   - Focus moves to #results-h after analysis (tabindex="-1"), not to
 *     individual findings; users choose what to explore.
 *   - Errors use the role="alert" region; non-error status uses role="status".
 *   - prefers-reduced-motion is honoured by CSS; no JS animations run.
 */

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

// ---------------------------------------------------------------------------
// Rule catalogue. Each rule is a regex plus metadata. Severity weights drive
// scoring and the visual treatment (solid / dashed / double border).
//
// Rules are adapted from patterns detected by established Python tooling:
//   perflint (W83xx, W84xx), ruff PERF rules, flake8-comprehensions (C4xx),
//   refurb (FURBxxx), flake8-bugbear (B0xx), pycodestyle (E721), and pylint
//   performance conventions. Source tools are named in each description so
//   readers can cross-reference the original documentation.
// ---------------------------------------------------------------------------
const RULES = [
  {
    id: "LOOP-001",
    title: "Iteration by index where direct iteration suffices",
    description:
      "`for i in range(len(xs))` is slower and less idiomatic than `for x in xs` or `for i, x in enumerate(xs)`. Same pattern as pylint C0200.",
    severity: "medium",
    weight: 4,
    pattern: /for\s+\w+\s+in\s+range\s*\(\s*len\s*\(/g,
  },
  {
    id: "LOOP-002",
    title: "try/except inside a loop",
    description:
      "A `try`/`except` in the loop body pays setup cost on every iteration. Move the guard around the loop, or use `contextlib.suppress`. Inspired by ruff PERF203 and perflint W8301.",
    severity: "medium",
    weight: 3,
    pattern: /^\s+try\s*:\s*$/gm,
    requiresLoopContext: true,
  },
  {
    id: "LOOP-003",
    title: "Unnecessary `list()` cast feeding an aggregator",
    description:
      "`sum(list(...))`, `any(list(...))`, `max(list(...))` materialise the sequence just to throw it away. Pass the generator directly. Inspired by ruff PERF101 and perflint W8401.",
    severity: "medium",
    weight: 2,
    pattern: /\b(sum|any|all|min|max|sorted|set|tuple|frozenset|len|next|"\s*"\.join|'\s*'\.join)\s*\(\s*list\s*\(/g,
  },
  {
    id: "LOOP-004",
    title: "Manual list-append loop where a comprehension fits",
    description:
      "A `for` loop whose only body is `result.append(expr)` can usually be rewritten as `result = [expr for ... in ...]`, which is faster and reads at a glance. Inspired by ruff PERF401.",
    severity: "low",
    weight: 2,
    pattern: /for\s+\w+\s+in\s+[^:\n]+:\s*\n\s+\w+\.append\s*\(/g,
  },
  {
    id: "LOOP-005",
    title: "String concatenation inside a loop",
    description:
      "Repeated `s += ...` or `s = s + ...` inside a loop allocates O(n²) memory; use `''.join(...)` on a list. Same class of issue as pylint W8203.",
    severity: "high",
    weight: 6,
    pattern: /^[^\n]*\b(\w+)\s*\+=\s*(?:["'`][^"'`]*["'`])[^\n]*$/gm,
    requiresLoopContext: true,
  },
  {
    id: "LOOP-006",
    title: "Redundant `range(0, n)`",
    description:
      "`range(0, n)` is equivalent to `range(n)`. The explicit zero adds noise with no effect on behaviour.",
    severity: "low",
    weight: 1,
    pattern: /\brange\s*\(\s*0\s*,\s*(?!len\s*\()[\w.]+\s*\)/g,
  },
  {
    id: "LOOP-007",
    title: "Loop-invariant call to `len()` inside the loop body",
    description:
      "Recomputing `len(xs)` every iteration is wasteful. Bind it to a local before the loop: `n = len(xs)`.",
    severity: "low",
    weight: 1,
    pattern: /while\s+\w+\s*<\s*len\s*\(/g,
  },
  {
    id: "PD-001",
    title: "Row-wise iteration over a DataFrame",
    description:
      "`iterrows()` and `itertuples()` are typically 10–100× slower than the vectorised equivalent. Reach for column arithmetic, `.str`, or `.map` first.",
    severity: "high",
    weight: 6,
    pattern: /\.(iterrows|itertuples)\s*\(/g,
  },
  {
    id: "PD-002",
    title: "DataFrame `.apply(lambda ...)` where a vectorised method exists",
    description:
      "`.apply(lambda x: ...)` over a column almost always has a vectorised replacement. Check for `.str`, arithmetic, `.map`, or `.where`.",
    severity: "medium",
    weight: 3,
    pattern: /\.apply\s*\(\s*lambda\b/g,
  },
  {
    id: "PD-004",
    title: "DataFrame append or concat inside a loop",
    description:
      "Building a DataFrame by repeated `append` / `concat` inside a loop is O(n²). Collect rows in a list, then `pd.concat` once.",
    severity: "high",
    weight: 5,
    pattern: /\b(pd\.concat|\.append)\s*\(/g,
    requiresLoopContext: true,
  },
  {
    id: "PD-005",
    title: "DataFrame `.loc` / `.iloc` / `.at` / `.iat` access inside a loop",
    description:
      "Row-by-row positional or label access in a Python loop is a common hot spot. Prefer vectorised assignment or bulk `.values` access.",
    severity: "medium",
    weight: 4,
    pattern: /\b\w+\.(loc|iloc|at|iat)\s*\[/g,
    requiresLoopContext: true,
  },
  {
    id: "PD-006",
    title: "`.groupby(...).apply(lambda ...)`",
    description:
      "`.apply` with a lambda on a groupby is usually slower than a named aggregation, `.agg({...})`, or a vectorised transform.",
    severity: "medium",
    weight: 3,
    pattern: /\.groupby\s*\([^)]*\)\s*\.\s*apply\s*\(\s*lambda\b/g,
  },
  {
    id: "NP-001",
    title: "Python-level iteration over a NumPy array",
    description:
      "Explicit `for x in numpy_array` loses NumPy's vectorised advantage. Express the operation with array ops, `np.where`, or `np.vectorize` (as a last resort).",
    severity: "medium",
    weight: 4,
    pattern: /for\s+\w+\s+in\s+np\.\w+/g,
  },
  {
    id: "DS-001",
    title: "Membership test against a list literal",
    description:
      "`x in some_list` is O(n). If the collection is large or reused, convert it to a set or frozenset for O(1) lookups.",
    severity: "medium",
    weight: 3,
    pattern: /\bin\s+\[[^\]]{40,}\]/g,
  },
  {
    id: "DS-002",
    title: "`list.count(...)` usage",
    description:
      "`list.count(x)` scans the whole list every call. If you count more than once, build a `collections.Counter` and read from it.",
    severity: "low",
    weight: 1,
    pattern: /\b\w+\.count\s*\(\s*[^)]*\)/g,
  },
  {
    id: "COMP-001",
    title: "Generator passed to `list` / `set` / `dict` constructor",
    description:
      "`list(x for x in xs)` can be the comprehension `[x for x in xs]`; the same applies to `set(...)` and `dict(...)`. Inspired by flake8-comprehensions C400–C402.",
    severity: "low",
    weight: 2,
    pattern: /\b(list|set|dict)\s*\(\s*(?:\w+|\([^)]+\))\s+for\s+\w+\s+in\s+/g,
  },
  {
    id: "COMP-002",
    title: "Unnecessary list literal inside `set()` / `dict()`",
    description:
      "`set([...])` / `dict([...])` allocates a throwaway list. Use a set/dict comprehension or a set literal instead. Inspired by flake8-comprehensions C403/C404.",
    severity: "low",
    weight: 2,
    pattern: /\b(set|dict)\s*\(\s*\[/g,
  },
  {
    id: "COMP-003",
    title: "Empty collection constructor where a literal is cheaper",
    description:
      "`dict()`, `list()`, `tuple()` with no arguments is slower than `{}`, `[]`, `()`. Inspired by flake8-comprehensions C408.",
    severity: "low",
    weight: 1,
    pattern: /\b(dict|list|tuple)\s*\(\s*\)/g,
  },
  {
    id: "COMP-004",
    title: "Redundant wrapping of an already-iterable result",
    description:
      "`list(sorted(...))`, `tuple(tuple(...))`, `set(set(...))` do extra work without adding value. Inspired by flake8-comprehensions C414.",
    severity: "low",
    weight: 1,
    pattern: /\b(list|tuple|set)\s*\(\s*(sorted|list|tuple|set)\s*\(/g,
  },
  {
    id: "IO-001",
    title: "HTTP request inside a loop",
    description:
      "`requests.get` / `requests.post` inside a loop serialises I/O. Batch the calls, reuse a `Session`, or use `asyncio`/`httpx` for concurrency.",
    severity: "high",
    weight: 5,
    pattern: /\brequests\.(get|post|put|delete|head|patch)\s*\(/g,
    requiresLoopContext: true,
  },
  {
    id: "IO-002",
    title: "File opened without a context manager",
    description:
      "`f = open(...)` risks leaking the file handle if an exception is raised before `close()`. Use `with open(...) as f:` instead.",
    severity: "medium",
    weight: 2,
    pattern: /(?<![=!<>])=\s*\bopen\s*\(/g,
  },
  {
    id: "IO-003",
    title: "JSON decoding in a hot loop",
    description:
      "`json.loads` / `json.load` in a loop with large payloads is a common hot spot. Consider `orjson`, `ujson`, or a streaming parser.",
    severity: "low",
    weight: 2,
    pattern: /\bjson\.load[s]?\s*\(/g,
    requiresLoopContext: true,
  },
  {
    id: "RE-001",
    title: "Regex call with a literal pattern inside a loop",
    description:
      "`re.search` / `re.match` cache compiled patterns, but the cache is small. For hot loops, call `re.compile(...)` once above the loop and reuse the returned object.",
    severity: "medium",
    weight: 3,
    pattern: /\bre\.(match|search|findall|finditer|sub|subn|split)\s*\(\s*r?["']/g,
    requiresLoopContext: true,
  },
  {
    id: "LOG-001",
    title: "Logging call uses f-string formatting",
    description:
      "f-string arguments to `logger.info(...)` are always evaluated, even when the log level is disabled. Prefer the lazy form `logger.info('msg %s', value)`. Detected by pylint W1203.",
    severity: "medium",
    weight: 2,
    pattern: /\b(?:logger|logging|log|self\.logger|self\.log)\.(debug|info|warning|warn|error|critical|exception)\s*\(\s*f["']/g,
  },
  {
    id: "MEM-001",
    title: "List comprehension used for immediate iteration",
    description:
      "Wrapping an iterable in `[...]` only to iterate once allocates a full list. A generator expression is cheaper for one-shot consumption.",
    severity: "low",
    weight: 1,
    pattern: /for\s+\w+\s+in\s+\[[^\[\]\n]{5,}\s+for\s+\w+\s+in\s+/g,
  },
  {
    id: "MEM-002",
    title: "`copy.deepcopy` inside a loop",
    description:
      "`deepcopy` is expensive and usually unnecessary. If you only need a shallow copy, use `.copy()` or a slice; otherwise hoist the copy out of the loop.",
    severity: "medium",
    weight: 3,
    pattern: /\bcopy\.deepcopy\s*\(/g,
    requiresLoopContext: true,
  },
  {
    id: "MEM-003",
    title: "Mutable default argument",
    description:
      "`def f(x=[])` or `def f(x={})` shares the default across calls, leading to subtle bugs. Use `None` as the default and assign inside the body. Detected by flake8-bugbear B006.",
    severity: "medium",
    weight: 3,
    pattern: /def\s+\w+\s*\([^)]*=\s*(?:\[\s*\]|\{\s*\}|\[[^\]\n]+\]|\{[^\}\n]+\})[^)]*\)/g,
  },
  {
    id: "FURB-001",
    title: "Lambda returning attribute access",
    description:
      "`lambda x: x.attr` can be replaced by `operator.attrgetter('attr')`, which is faster in hot paths. Inspired by refurb FURB118.",
    severity: "low",
    weight: 1,
    pattern: /\blambda\s+(\w+)\s*:\s*\1\.\w+(?!\s*\()/g,
  },
  {
    id: "IMPORT-001",
    title: "`import` statement inside a function body",
    description:
      "Imports inside a hot function add per-call overhead and hide dependencies. Move them to the top of the module unless there is a cycle or startup-cost reason.",
    severity: "low",
    weight: 1,
    pattern: /^\s+(?:import\s+[\w.]+|from\s+[\w.]+\s+import\s+)/gm,
  },
  {
    id: "GLOBAL-001",
    title: "`global` keyword inside a function",
    description:
      "Reading a global is slower than a local, and writing to a global in a hot function hurts both performance and testability.",
    severity: "low",
    weight: 1,
    pattern: /^\s+global\s+\w+/gm,
  },
  {
    id: "QUAL-001",
    title: "Redundant length check",
    description:
      "`len(x) == 0` is `not x`; `len(x) > 0` is `x`. Detected by pylint C1801.",
    severity: "low",
    weight: 1,
    pattern: /\blen\s*\([^)]+\)\s*[=!<>]=?\s*0/g,
  },
  {
    id: "QUAL-002",
    title: "Explicit comparison to True or False",
    description:
      "`x == True` / `x == False` is both slower and less idiomatic than `x` / `not x`. Detected by pylint C0121.",
    severity: "low",
    weight: 1,
    pattern: /\b==\s*(True|False)\b/g,
  },
  {
    id: "QUAL-003",
    title: "Using `type(x) == ...` instead of `isinstance`",
    description:
      "`type(x) == Cls` fails for subclasses and is slower than `isinstance(x, Cls)`. Detected by pycodestyle E721.",
    severity: "low",
    weight: 1,
    pattern: /\btype\s*\(\s*[^)]+\)\s*(?:==|!=)\s*/g,
  },
];

// ---------------------------------------------------------------------------
// DOM helpers and globals.
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

const ui = {
  fileInput: $("#pdf-upload"),
  resetBtn: $("#reset-btn"),
  themeToggle: $("#theme-toggle"),
  status: $("#status"),
  errorRegion: $("#error"),
  resultsSection: $("#results-section"),
  resultsHeading: $("#results-h"),
  scoreNumber: $("#score-number"),
  scoreSr: $("#score-sr"),
  scoreTitle: $("#score-title"),
  ringFg: $("#ring-fg"),
  gradeBadge: $("#grade-badge"),
  gradeLetter: $("#grade-letter"),
  gradeWord: $("#grade-word"),
  scoreSummary: $("#score-summary"),
  findingsSection: $("#findings-section"),
  findingsList: $("#findings-list"),
  findingsEmpty: $("#findings-empty"),
  codeSection: $("#code-section"),
  codeDisplay: $("#code-display"),
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // matches r=52 in SVG

// ---------------------------------------------------------------------------
// Theme toggle. Respects prefers-color-scheme on first load; persists choice.
// ---------------------------------------------------------------------------
function initTheme() {
  const stored = localStorage.getItem("pyoptimize-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const initial = stored ?? (prefersDark ? "dark" : "light");
  applyTheme(initial);
  ui.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme ?? "light";
    applyTheme(current === "dark" ? "light" : "dark");
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  ui.themeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  ui.themeToggle.querySelector(".theme-toggle__label").textContent =
    theme === "dark" ? "Light mode" : "Dark mode";
  localStorage.setItem("pyoptimize-theme", theme);
}

// ---------------------------------------------------------------------------
// Status announcements. A single polite live region receives every update;
// errors route to the assertive alert region.
// ---------------------------------------------------------------------------
function announce(message, { state = "idle" } = {}) {
  ui.status.textContent = message;
  ui.status.dataset.state = state;
}

function showError(message) {
  ui.errorRegion.textContent = message;
  ui.errorRegion.hidden = false;
  announce("", { state: "idle" });
}

function clearError() {
  ui.errorRegion.textContent = "";
  ui.errorRegion.hidden = true;
}

// ---------------------------------------------------------------------------
// PDF text extraction. Each page's items are joined with newlines preserved.
// ---------------------------------------------------------------------------
async function extractText(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let currentY = null;
    let line = "";
    const lines = [];
    for (const item of content.items) {
      // pdf.js items include a transform; tx[5] is the y offset.
      const y = item.transform ? item.transform[5] : null;
      if (currentY !== null && y !== null && Math.abs(y - currentY) > 2) {
        lines.push(line);
        line = "";
      }
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
      currentY = y;
    }
    if (line) lines.push(line);
    pages.push(lines.join("\n"));
  }
  return pages.join("\n\n");
}

// ---------------------------------------------------------------------------
// Rule engine.
// ---------------------------------------------------------------------------
function findLoopRanges(text) {
  // Collect [start, end] character ranges for blocks that follow `for`/`while`
  // statements. Treats the block as running until a dedent below the loop's
  // indent. Good enough for regex-level analysis of extracted PDF text.
  const ranges = [];
  const lines = text.split("\n");
  let offset = 0;
  const lineStarts = [];
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(for|while)\b/);
    if (!m) continue;
    const indent = m[1].length;
    let endLine = i + 1;
    while (endLine < lines.length) {
      if (lines[endLine].trim() === "") {
        endLine++;
        continue;
      }
      const ind = lines[endLine].match(/^(\s*)/)[1].length;
      if (ind <= indent) break;
      endLine++;
    }
    const start = lineStarts[i];
    const end = endLine < lineStarts.length ? lineStarts[endLine] : text.length;
    ranges.push([start, end]);
  }
  return ranges;
}

function inAnyRange(position, ranges) {
  for (const [s, e] of ranges) if (position >= s && position < e) return true;
  return false;
}

function analyse(text) {
  const loopRanges = findLoopRanges(text);
  const findings = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (rule.requiresLoopContext && !inAnyRange(start, loopRanges)) continue;
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        description: rule.description,
        severity: rule.severity,
        weight: rule.weight,
        start,
        end,
        excerpt: m[0],
      });
      if (!rule.pattern.global) break;
    }
  }
  // Sort by position.
  findings.sort((a, b) => a.start - b.start);
  findings.forEach((f, i) => (f.id = `finding-${i + 1}`));
  return findings;
}

function computeScore(findings) {
  let score = 100;
  for (const f of findings) score -= f.weight;
  return Math.max(0, score);
}

function gradeFromScore(score) {
  if (score >= 90) return { letter: "A", word: "Excellent", glyph: "check" };
  if (score >= 80) return { letter: "B", word: "Good", glyph: "circle" };
  if (score >= 70) return { letter: "C", word: "Needs improvement", glyph: "triangle" };
  if (score >= 60) return { letter: "D", word: "Poor", glyph: "square" };
  return { letter: "F", word: "Critical", glyph: "cross" };
}

const GRADE_GLYPHS = {
  check: "M6 12l4 4 8-8",
  circle: "M12 7a5 5 0 100 10 5 5 0 000-10z",
  triangle: "M12 5l8 14H4z",
  square: "M6 6h12v12H6z",
  cross: "M7 7l10 10M17 7L7 17",
};

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function renderScore(score, grade) {
  // Visual elements are aria-hidden on the ring container; update them freely.
  ui.gradeBadge.dataset.grade = grade.letter;
  ui.gradeBadge.setAttribute(
    "aria-label",
    `Grade ${grade.letter}, ${grade.word.toLowerCase()}`,
  );
  ui.gradeLetter.textContent = grade.letter;
  ui.gradeWord.textContent = `${grade.letter} — ${grade.word}`;
  ui.scoreTitle.textContent = `${grade.word} — Grade ${grade.letter}`;
  const path = GRADE_GLYPHS[grade.glyph];
  document.getElementById("grade-glyph-path").setAttribute("d", path);

  // Score ring: set dashoffset so the gradient stroke fills proportionally.
  const targetOffset =
    RING_CIRCUMFERENCE - (Math.max(0, Math.min(100, score)) / 100) * RING_CIRCUMFERENCE;

  if (prefersReducedMotion()) {
    // Render final state immediately — no counter animation, no ring transition.
    ui.ringFg.style.transition = "none";
    ui.ringFg.setAttribute("stroke-dashoffset", String(targetOffset));
    ui.scoreNumber.textContent = String(score);
  } else {
    // First paint: start from empty ring + 0, then flip to final in the next frame
    // so the CSS transition on stroke-dashoffset runs.
    ui.ringFg.style.transition = "";
    ui.ringFg.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE));
    ui.scoreNumber.textContent = "0";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ui.ringFg.setAttribute("stroke-dashoffset", String(targetOffset));
        animateCounter(0, score, 700);
      });
    });
  }

  // One-shot accessible announcement of the final value, separate from the
  // visual counter. This updates once and is in an sr-only span that is read
  // by the Results heading focus + status live region.
  ui.scoreSr.textContent = `Score ${score} out of 100`;
}

function animateCounter(from, to, durationMs) {
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    // Ease-out cubic
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(from + (to - from) * eased);
    ui.scoreNumber.textContent = String(value);
    if (t < 1) requestAnimationFrame(step);
    else ui.scoreNumber.textContent = String(to);
  };
  requestAnimationFrame(step);
}

function renderFindings(findings) {
  ui.findingsList.innerHTML = "";
  if (findings.length === 0) {
    ui.findingsEmpty.hidden = false;
    return;
  }
  ui.findingsEmpty.hidden = true;

  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.ruleId)) byRule.set(f.ruleId, []);
    byRule.get(f.ruleId).push(f);
  }

  for (const [ruleId, group] of byRule) {
    const first = group[0];
    const li = document.createElement("li");
    li.className = "finding";
    li.dataset.severity = first.severity;

    const locationLinks = group
      .map(
        (f, idx) =>
          `<a href="#${f.id}">occurrence ${idx + 1}</a>`,
      )
      .join(", ");

    li.innerHTML = `
      <div class="finding__head">
        <h3 class="finding__title">${escapeHtml(first.title)}</h3>
        <span class="severity-tag" data-severity="${first.severity}">${first.severity.toUpperCase()}</span>
        <code class="finding__rule">${escapeHtml(ruleId)}</code>
      </div>
      <p class="finding__desc">${escapeHtml(first.description)}</p>
      <p class="finding__locations">Occurrences: ${locationLinks}</p>
    `;
    ui.findingsList.appendChild(li);
  }
}

function renderCode(text, findings) {
  // Walk findings in order, interleaving plain text and <mark> elements.
  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const f of findings) {
    if (f.start > cursor) {
      frag.appendChild(document.createTextNode(text.slice(cursor, f.start)));
    }
    const mark = document.createElement("mark");
    mark.className = "flag";
    mark.id = f.id;
    mark.dataset.severity = f.severity;
    mark.tabIndex = 0;
    mark.setAttribute(
      "aria-label",
      `${f.ruleId}: ${f.title}. Severity ${f.severity}. Activate to jump to explanation.`,
    );
    mark.textContent = text.slice(f.start, f.end);
    mark.addEventListener("click", () => focusFinding(f.ruleId));
    mark.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        focusFinding(f.ruleId);
      }
    });
    frag.appendChild(mark);
    cursor = f.end;
  }
  if (cursor < text.length) {
    frag.appendChild(document.createTextNode(text.slice(cursor)));
  }
  ui.codeDisplay.innerHTML = "";
  ui.codeDisplay.appendChild(frag);
}

function focusFinding(ruleId) {
  const items = ui.findingsList.querySelectorAll(".finding");
  for (const item of items) {
    if (item.querySelector(`.finding__rule`)?.textContent === ruleId) {
      item.scrollIntoView({ block: "start" });
      const title = item.querySelector(".finding__title");
      if (title) {
        title.setAttribute("tabindex", "-1");
        title.focus();
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Main pipeline.
// ---------------------------------------------------------------------------
async function handleFile(file) {
  clearError();
  if (!file) return;
  if (file.type && file.type !== "application/pdf") {
    showError("That file is not a PDF. Please upload a file with the .pdf extension.");
    return;
  }

  announce(`PDF received (${formatSize(file.size)}). Analysing code…`, {
    state: "analysing",
  });

  let text = "";
  try {
    text = await extractText(file);
  } catch (err) {
    console.error(err);
    showError(
      "Could not read that PDF. It may be corrupted, password-protected, or otherwise unreadable.",
    );
    return;
  }

  if (!text.trim()) {
    showError(
      "No selectable text was found in that PDF. Scanned or image-only PDFs cannot be analysed.",
    );
    return;
  }

  const findings = analyse(text);
  const score = computeScore(findings);
  const grade = gradeFromScore(score);

  renderScore(score, grade);
  renderFindings(findings);
  renderCode(text, findings);

  ui.resultsSection.hidden = false;
  ui.findingsSection.hidden = false;
  ui.codeSection.hidden = false;
  ui.resetBtn.hidden = false;

  ui.scoreSummary.textContent = buildSummary(score, grade, findings);

  announce(
    `Analysis complete. Score ${score} out of 100, grade ${grade.letter} (${grade.word}). ${summariseFindings(findings)}`,
    { state: "idle" },
  );

  // Focus management: per the a11y spec, move focus to the Results heading,
  // letting the user choose what to explore next.
  ui.resultsHeading.focus({ preventScroll: false });
}

function buildSummary(score, grade, findings) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  if (findings.length === 0) {
    return `No anti-patterns detected. Grade ${grade.letter} (${grade.word}).`;
  }
  const parts = [];
  if (counts.high) parts.push(`${counts.high} high`);
  if (counts.medium) parts.push(`${counts.medium} medium`);
  if (counts.low) parts.push(`${counts.low} low`);
  return `${findings.length} findings — ${parts.join(", ")} severity. Review each finding below and the highlighted sections in the extracted code.`;
}

function summariseFindings(findings) {
  if (findings.length === 0) {
    return "No anti-patterns detected.";
  }
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  const parts = [];
  if (counts.high) parts.push(`${counts.high} high`);
  if (counts.medium) parts.push(`${counts.medium} medium`);
  if (counts.low) parts.push(`${counts.low} low`);
  const word = findings.length === 1 ? "finding" : "findings";
  return `${findings.length} ${word}: ${parts.join(", ")}.`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function reset() {
  ui.fileInput.value = "";
  ui.resultsSection.hidden = true;
  ui.findingsSection.hidden = true;
  ui.codeSection.hidden = true;
  ui.resetBtn.hidden = true;
  ui.findingsList.innerHTML = "";
  ui.codeDisplay.innerHTML = "";
  ui.scoreNumber.textContent = "—";
  ui.scoreSr.textContent = "";
  ui.scoreTitle.textContent = "Awaiting upload";
  ui.gradeBadge.dataset.grade = "pending";
  ui.gradeBadge.removeAttribute("aria-label");
  ui.gradeLetter.textContent = "—";
  ui.gradeWord.textContent = "Awaiting upload";
  ui.ringFg.style.transition = "none";
  ui.ringFg.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE));
  clearError();
  announce("", { state: "idle" });
  ui.fileInput.focus();
}

// ---------------------------------------------------------------------------
// Wire-up.
// ---------------------------------------------------------------------------
initTheme();
ui.fileInput.addEventListener("change", (ev) => {
  const file = ev.target.files?.[0];
  if (file) handleFile(file);
});
ui.resetBtn.addEventListener("click", reset);
