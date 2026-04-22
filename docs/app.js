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
// ---------------------------------------------------------------------------
const RULES = [
  {
    id: "LOOP-001",
    title: "Iteration by index where direct iteration suffices",
    description:
      "`for i in range(len(xs))` is slower and less idiomatic than `for x in xs` or `for i, x in enumerate(xs)`.",
    severity: "medium",
    weight: 4,
    pattern: /for\s+\w+\s+in\s+range\s*\(\s*len\s*\(/g,
  },
  {
    id: "LOOP-005",
    title: "String concatenation inside a loop",
    description:
      "Repeated `s += ...` or `s = s + ...` inside a loop allocates O(n²) memory; use ''.join(...) on a list.",
    severity: "high",
    weight: 6,
    pattern: /^[^\n]*\b(\w+)\s*\+=\s*(?:["'`][^"'`]*["'`])[^\n]*$/gm,
    // Additional guard applied post-match: must be inside a for/while body.
    requiresLoopContext: true,
  },
  {
    id: "PD-001",
    title: "Row-wise iteration over a DataFrame",
    description:
      "`iterrows()` and `itertuples()` are typically 10-100× slower than the vectorised equivalent.",
    severity: "high",
    weight: 6,
    pattern: /\.(iterrows|itertuples)\s*\(/g,
  },
  {
    id: "PD-002",
    title: "DataFrame .apply where a vectorised method exists",
    description:
      "`.apply(lambda x: ...)` over a column typically has a vectorised replacement. Check for `.str`, arithmetic, or `.map`.",
    severity: "medium",
    weight: 3,
    pattern: /\.apply\s*\(\s*lambda\b/g,
  },
  {
    id: "PD-004",
    title: "DataFrame append or concat inside a loop",
    description:
      "Building a DataFrame by repeated `append` / `concat` inside a loop is O(n²). Collect rows then concatenate once.",
    severity: "high",
    weight: 5,
    pattern: /\b(pd\.concat|\.append)\s*\(/g,
    requiresLoopContext: true,
  },
  {
    id: "NP-001",
    title: "Python-level iteration over a NumPy array",
    description:
      "Explicit `for x in numpy_array` loses NumPy's vectorised advantage. Express the operation with array ops.",
    severity: "medium",
    weight: 4,
    pattern: /for\s+\w+\s+in\s+np\.\w+/g,
  },
  {
    id: "DS-001",
    title: "Membership test against a list",
    description:
      "`x in some_list` is O(n). If `some_list` is reused, convert it to a set for O(1) lookups.",
    severity: "medium",
    weight: 3,
    pattern: /\bin\s+\[[^\]]{40,}\]/g,
  },
  {
    id: "IO-001",
    title: "HTTP request inside a loop",
    description:
      "`requests.get` / `requests.post` inside a loop serialises I/O. Batch, pool, or use async for concurrency.",
    severity: "high",
    weight: 5,
    pattern: /\brequests\.(get|post|put|delete|head|patch)\s*\(/g,
    requiresLoopContext: true,
  },
  {
    id: "IO-003",
    title: "JSON decoding in a hot loop",
    description:
      "`json.loads` / `json.load` in a loop with large payloads is a common hot spot. Consider streaming parsers.",
    severity: "low",
    weight: 2,
    pattern: /\bjson\.load[s]?\s*\(/g,
    requiresLoopContext: true,
  },
  {
    id: "MEM-001",
    title: "List comprehension used for immediate iteration",
    description:
      "Wrapping an iterable in `[...]` only to iterate once allocates a full list. A generator expression is cheaper.",
    severity: "low",
    weight: 1,
    pattern: /for\s+\w+\s+in\s+\[[^\[\]\n]{5,}\s+for\s+\w+\s+in\s+/g,
  },
  {
    id: "QUAL-001",
    title: "Redundant length check",
    description:
      "`len(x) == 0` can be written as `not x`; `len(x) > 0` can be written as `x`.",
    severity: "low",
    weight: 1,
    pattern: /\blen\s*\([^)]+\)\s*[=!<>]=?\s*0/g,
  },
  {
    id: "QUAL-002",
    title: "Explicit comparison to True or False",
    description:
      "`x == True` / `x == False` is both slower and less idiomatic than `x` / `not x`.",
    severity: "low",
    weight: 1,
    pattern: /\b==\s*(True|False)\b/g,
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

function renderScore(score, grade) {
  ui.scoreNumber.textContent = String(score);
  ui.gradeBadge.dataset.grade = grade.letter;
  ui.gradeLetter.textContent = grade.letter;
  ui.gradeWord.textContent = `${grade.letter} — ${grade.word}`;
  const path = GRADE_GLYPHS[grade.glyph];
  document.getElementById("grade-glyph-path").setAttribute("d", path);
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
        <span class="finding__rule">${escapeHtml(ruleId)}</span>
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
    `Analysis complete. Score ${score} out of 100, grade ${grade.letter} (${grade.word}). ${findings.length} ${findings.length === 1 ? "finding" : "findings"} detected.`,
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
