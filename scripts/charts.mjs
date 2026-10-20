// Draws the charts in docs/how-it-works.md as static SVG, one light and one
// dark file each, since GitHub shows Markdown images but runs no scripts.
// Run it again after changing a number: npm run charts

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'docs', 'assets');

// GitHub's own page colors, so the charts sit on the page like they belong.
const THEMES = {
  light: {
    surface: '#ffffff',
    ink: '#1f2328',
    ink2: '#59636e',
    grid: '#d1d9e0',
    series: ['#2a78d6', '#eb6834', '#1baf7a'],
  },
  dark: {
    surface: '#0d1117',
    ink: '#f0f6fc',
    ink2: '#9198a1',
    grid: '#3d444d',
    series: ['#3987e5', '#d95926', '#199e70'],
  },
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;

// Measured: the first call of a fresh interactive session, at 4 characters per token.
const SYSTEM = 4094;
const TOOLS = 8010;
const MESSAGE = 147;
const BASE = SYSTEM + TOOLS + MESSAGE;

// boisestate.ai's rates in dollars per million tokens.
const OPUS = { in: 4, out: 20 };
const SONNET = { in: 2, out: 10 };
const OUT_TOKENS = 300;
const callCost = (tokensIn, rate, tokensOut = OUT_TOKENS) => (tokensIn * rate.in + tokensOut * rate.out) / 1e6;

const tokens = (v) => Math.round(v).toLocaleString('en-US');
const dollars = (v) => `$${v.toFixed(2)}`;
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;');

function attrs(map) {
  return Object.entries(map)
    .map(([key, value]) => `${key}="${esc(value)}"`)
    .join(' ');
}

const text = (x, y, body, more = {}) => `<text ${attrs({ x, y, ...more })}>${esc(body)}</text>`;

/** A rough text width, good enough to decide if a label fits inside a bar. */
const textWidth = (s, size) => s.length * size * 0.56;

function svg(width, height, theme, title, body) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" font-family="${FONT}">`,
    `<title>${esc(title)}</title>`,
    `<rect width="${width}" height="${height}" rx="8" fill="${theme.surface}"/>`,
    body,
    '</svg>',
    '',
  ].join('\n');
}

function legend(theme, items, y, line = false) {
  let x = 24;
  const parts = [];
  for (const [index, name] of items.entries()) {
    const color = theme.series[index];
    parts.push(
      line
        ? `<rect x="${x}" y="${y - 6}" width="14" height="3" rx="1.5" fill="${color}"/>`
        : `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="3" fill="${color}"/>`,
    );
    parts.push(text(x + 20, y, name, { fill: theme.ink2, 'font-size': 13 }));
    x += 20 + textWidth(name, 13) + 24;
  }
  return parts.join('\n');
}

/** A bar segment with 4px rounded corners on its right end only. */
function segment(x, y, w, h, color, roundEnd) {
  if (!roundEnd || w < 8) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`;
  }
  const r = 4;
  return `<path d="M${x} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x} Z" fill="${color}"/>`;
}

function stackedBars(theme, spec) {
  const width = 760;
  const left = spec.labelWidth;
  const right = 90;
  const barH = 28;
  const rowGap = 46;
  const calloutRoom = spec.callouts ? 34 : 0;
  const top = 64;
  const plotW = width - left - right;
  const x = (v) => left + (v / spec.max) * plotW;
  const height = top + spec.rows.length * rowGap + calloutRoom + 40;
  const parts = [];

  parts.push(text(24, 28, spec.title, { fill: theme.ink, 'font-size': 16, 'font-weight': 600 }));
  parts.push(legend(theme, spec.series, 52));

  const axisY = top + spec.rows.length * rowGap + calloutRoom + 8;
  for (const t of spec.ticks) {
    parts.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${axisY - 14}" stroke="${theme.grid}" stroke-width="1"/>`);
    parts.push(text(x(t), axisY + 4, spec.format(t), { fill: theme.ink2, 'font-size': 12, 'text-anchor': 'middle' }));
  }

  for (const [ri, row] of spec.rows.entries()) {
    const y = top + ri * rowGap + 8;
    parts.push(text(left - 12, y + barH / 2 + 5, row.label, { fill: theme.ink, 'font-size': 13, 'font-weight': 600, 'text-anchor': 'end' }));
    let start = 0;
    const last = row.values.findLastIndex((v) => v > 0);
    for (const [si, value] of row.values.entries()) {
      if (value <= 0) {
        continue;
      }
      // A 2px gap in the surface color between segments.
      const x0 = x(start) + (start > 0 ? 2 : 0);
      const w = Math.max(x(start + value) - x0, 2);
      parts.push(segment(x0, y, w, barH, theme.series[si], si === last));
      const label = spec.inside ? `${spec.series[si]} ${spec.format(value)}` : null;
      if (label !== null && textWidth(label, 12.5) + 16 < w) {
        parts.push(text(x0 + 8, y + barH / 2 + 4.5, label, { fill: '#ffffff', 'font-size': 12.5, 'font-weight': 600 }));
      } else if (label !== null && spec.callouts) {
        const cx = x0 + w / 2;
        parts.push(`<line x1="${cx}" x2="${cx}" y1="${y + barH + 2}" y2="${y + barH + 12}" stroke="${theme.ink2}" stroke-width="1"/>`);
        parts.push(text(cx, y + barH + 26, label, { fill: theme.ink2, 'font-size': 12.5, 'text-anchor': 'end' }));
      }
      start += value;
    }
    const total = row.values.reduce((a, b) => a + b, 0);
    parts.push(text(x(total) + 8, y + barH / 2 + 5, spec.format(total), { fill: theme.ink, 'font-size': 13, 'font-weight': 600 }));
  }
  return svg(width, height, theme, spec.title, parts.join('\n'));
}

function lineChart(theme, spec) {
  const width = 760;
  const height = 380;
  const m = { left: 56, right: 150, top: 72, bottom: 52 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const x = (v) => m.left + ((v - 1) / (spec.xMax - 1)) * plotW;
  const y = (v) => m.top + plotH - (v / spec.yMax) * plotH;
  const parts = [];

  parts.push(text(24, 28, spec.title, { fill: theme.ink, 'font-size': 16, 'font-weight': 600 }));
  parts.push(legend(theme, spec.series.map((s) => s.name), 52, true));

  for (const t of spec.yTicks) {
    parts.push(`<line x1="${m.left}" x2="${m.left + plotW}" y1="${y(t)}" y2="${y(t)}" stroke="${theme.grid}" stroke-width="1"/>`);
    parts.push(text(m.left - 10, y(t) + 4, spec.formatY(t), { fill: theme.ink2, 'font-size': 12, 'text-anchor': 'end' }));
  }
  for (const t of spec.xTicks) {
    parts.push(text(x(t), m.top + plotH + 20, String(t), { fill: theme.ink2, 'font-size': 12, 'text-anchor': 'middle' }));
  }
  parts.push(text(m.left + plotW / 2, height - 10, spec.xLabel, { fill: theme.ink2, 'font-size': 12, 'text-anchor': 'middle' }));

  const ry = y(spec.reference.value);
  parts.push(`<line x1="${m.left}" x2="${m.left + plotW}" y1="${ry}" y2="${ry}" stroke="${theme.ink2}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
  parts.push(text(m.left + 8, ry - 8, spec.reference.label, { fill: theme.ink, 'font-size': 12.5, 'font-weight': 600 }));

  for (const [si, series] of spec.series.entries()) {
    const color = theme.series[si];
    const points = series.values.map((v, i) => `${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    parts.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    const lastX = x(series.values.length);
    const lastY = y(series.values.at(-1));
    parts.push(`<circle cx="${lastX}" cy="${lastY}" r="4" fill="${color}" stroke="${theme.surface}" stroke-width="2"/>`);
    parts.push(text(lastX + 10, lastY + 4, `${series.short} ${dollars(series.values.at(-1))}`, { fill: theme.ink, 'font-size': 12.5, 'font-weight': 600 }));
  }
  return svg(width, height, theme, spec.title, parts.join('\n'));
}

// The three charts.

const request = {
  title: 'Tokens in one call',
  series: ['System prompt', 'Tool definitions', 'Your message'],
  rows: [{ label: 'One call', values: [SYSTEM, TOOLS, MESSAGE] }],
  max: 13000,
  ticks: [0, 2000, 4000, 6000, 8000, 10000, 12000],
  format: tokens,
  inside: true,
  callouts: true,
  labelWidth: 90,
};

// Default mode is the two Opus calls of one question with a tool call. Auto
// mode adds about six 55,000 token approval checks on Sonnet.
const WORK = callCost(12251, OPUS) + callCost(12401, OPUS);
const CHECKS = 6 * callCost(55000, SONNET, 0);
const auto = {
  title: 'Cost of one question with one tool call',
  series: ['The work (Opus 5.5)', 'Auto mode approval checks (Sonnet 5)'],
  rows: [
    { label: 'Default mode', values: [WORK, 0] },
    { label: 'Auto mode', values: [WORK, CHECKS] },
  ],
  max: 0.9,
  ticks: [0, 0.2, 0.4, 0.6, 0.8],
  format: dollars,
  labelWidth: 120,
};

// A conversation where every call adds 1,500 tokens of history, with and
// without /clear every 20 calls.
const GROWTH = 1500;
const CALLS = 100;
function running(clearEvery) {
  let total = 0;
  return Array.from({ length: CALLS }, (_, i) => {
    const sinceClear = clearEvery === null ? i : i % clearEvery;
    total += callCost(BASE + GROWTH * sinceClear, OPUS);
    return total;
  });
}
const session = {
  title: 'Running total for one conversation on Opus 5.5',
  xMax: CALLS,
  xTicks: [1, 20, 40, 60, 80, 100],
  xLabel: 'Calls in the conversation',
  yMax: 40,
  yTicks: [0, 10, 20, 30, 40],
  formatY: (v) => `$${String(v)}`,
  reference: { value: 30, label: 'A $30 quota (faculty, yours may differ)' },
  series: [
    { name: 'One long conversation', short: 'No /clear', values: running(null) },
    { name: '/clear every 20 calls', short: '/clear', values: running(20) },
  ],
};

mkdirSync(OUT, { recursive: true });
for (const [mode, theme] of Object.entries(THEMES)) {
  writeFileSync(path.join(OUT, `chart-request-${mode}.svg`), stackedBars(theme, request));
  writeFileSync(path.join(OUT, `chart-auto-${mode}.svg`), stackedBars(theme, auto));
  writeFileSync(path.join(OUT, `chart-session-${mode}.svg`), lineChart(theme, session));
}

// The numbers for the tables under each chart.
console.log(`one call: ${tokens(BASE)} tokens, ${dollars(callCost(BASE, OPUS))}`);
console.log(`default ${dollars(WORK)}, auto ${dollars(WORK + CHECKS)}`);
const long = running(null);
const cleared = running(20);
for (const n of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
  console.log(`| ${String(n)} | ${dollars(long[n - 1])} | ${dollars(cleared[n - 1])} |`);
}
