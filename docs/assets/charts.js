// Small hand-rolled charts for the how-it-works page: a horizontal stacked bar
// and a line chart, each with a legend, hover tooltips and a table view. Colors
// come from CSS variables, so light and dark mode need no redraw. It is a plain
// script, not a module, so the page also works opened straight from disk.

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  if (parent !== null) {
    parent.append(node);
  }
  return node;
}

function text(parent, x, y, content, attrs = {}) {
  const node = el('text', { x, y, fill: 'var(--ink-2)', 'font-size': 13, ...attrs }, parent);
  node.textContent = content;
  return node;
}

function niceTicks(max, count) {
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw);
  const ticks = [];
  for (let value = 0; value <= max + step / 2; value += step) {
    ticks.push(value);
  }
  return ticks;
}

function legend(container, series, kind) {
  const box = document.createElement('div');
  box.className = 'legend';
  for (const item of series) {
    const span = document.createElement('span');
    const swatch = document.createElement('i');
    if (kind === 'line') {
      swatch.className = 'line';
    }
    swatch.style.background = item.color;
    span.append(swatch, item.name);
    box.append(span);
  }
  container.append(box);
}

function tooltip(container) {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'status');
  container.append(tip);
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.classList.add('show');
      const box = container.getBoundingClientRect();
      const width = tip.offsetWidth;
      const left = Math.min(Math.max(x - box.left + 14, 8), box.width - width - 8);
      tip.style.left = `${left}px`;
      tip.style.top = `${y - box.top - tip.offsetHeight - 12}px`;
    },
    hide() {
      tip.classList.remove('show');
    },
  };
}

function row(color, label, value) {
  return `<div class="row"><i style="background:${color}"></i>${label} <b>${value}</b></div>`;
}

function tableView(container, head, rows) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'table-toggle';
  button.textContent = 'Show the numbers';
  const table = document.createElement('table');
  table.hidden = true;
  table.innerHTML =
    `<thead><tr>${head.map((h, i) => `<th class="${i === 0 ? '' : 'num'}">${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows
      .map((r) => `<tr>${r.map((c, i) => `<td class="${i === 0 ? '' : 'num'}">${c}</td>`).join('')}</tr>`)
      .join('')}</tbody>`;
  button.addEventListener('click', () => {
    table.hidden = !table.hidden;
    button.textContent = table.hidden ? 'Show the numbers' : 'Hide the numbers';
  });
  container.append(button, table);
}

/**
 * Horizontal stacked bars. spec: { rows: [{ label, values }], series: [{ name,
 * color }], max, ticks, format, total, inside, callouts }.
 */
function stackedBars(container, spec) {
  legend(container, spec.series, 'bar');
  const W = 860;
  const left = spec.labelWidth ?? 140;
  const right = 70;
  const bar = 24;
  const gap = 34;
  const top = 8;
  const calloutRoom = spec.callouts ? 34 : 0;
  const plotH = spec.rows.length * (bar + gap) - gap;
  const H = top + plotH + calloutRoom + 34;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': spec.label }, container);
  const x = (v) => left + ((W - left - right) * v) / spec.max;
  const tip = tooltip(container);

  for (const t of spec.ticks) {
    el('line', { x1: x(t), x2: x(t), y1: top - 4, y2: top + plotH + 4, stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    text(svg, x(t), H - 8 - (spec.callouts ? 0 : 0), spec.format(t), {
      'text-anchor': 'middle',
      fill: 'var(--axis-ink)',
      'font-size': 12,
    });
  }

  spec.rows.forEach((r, ri) => {
    const y = top + ri * (bar + gap);
    text(svg, left - 12, y + bar / 2 + 5, r.label, { 'text-anchor': 'end', fill: 'var(--ink)', 'font-weight': 600 });
    let start = 0;
    const last = r.values.reduce((index, v, i) => (v > 0 ? i : index), -1);
    r.values.forEach((v, si) => {
      if (v <= 0) {
        return;
      }
      const x0 = x(start);
      const x1 = x(start + v);
      const end = si === last ? x1 : x1 - 2;
      const w = Math.max(end - x0, 1.5);
      const color = spec.series[si].color;
      let mark;
      if (si === last) {
        const radius = Math.min(4, w / 2);
        mark = el('path', {
          d: `M${x0},${y} H${x0 + w - radius} Q${x0 + w},${y} ${x0 + w},${y + radius} V${y + bar - radius} Q${x0 + w},${y + bar} ${x0 + w - radius},${y + bar} H${x0} Z`,
          fill: color,
        }, svg);
      } else {
        mark = el('rect', { x: x0, y, width: w, height: bar, fill: color }, svg);
      }
      const html = `<strong>${r.label}</strong>${row(color, spec.series[si].name, spec.format(v))}`;
      const hit = el('rect', { x: x0, y: y - 6, width: Math.max(w, 12), height: bar + 12, fill: 'transparent' }, svg);
      for (const target of [mark, hit]) {
        target.addEventListener('mousemove', (e) => tip.show(html, e.clientX, e.clientY));
        target.addEventListener('mouseleave', () => tip.hide());
      }
      const name = spec.inside ? spec.series[si].name : null;
      if (name !== null) {
        const label = `${name} ${spec.format(v)}`;
        if (label.length * 7.2 + 16 < w) {
          text(svg, x0 + 8, y + bar / 2 + 5, label, { fill: '#ffffff', 'font-size': 12.5, 'font-weight': 600, 'pointer-events': 'none' });
        } else if (spec.callouts) {
          el('line', { x1: x0 + w / 2, x2: x0 + w / 2, y1: y + bar + 2, y2: y + bar + 16, stroke: 'var(--muted)', 'stroke-width': 1 }, svg);
          text(svg, x0 + w / 2 - 4, y + bar + 30, label, { 'text-anchor': 'end', 'font-size': 12.5 });
        }
      }
      start += v;
    });
    if (spec.total) {
      text(svg, x(start) + 8, y + bar / 2 + 5, spec.format(start), { fill: 'var(--ink)', 'font-weight': 700 });
    }
  });

  el('line', { x1: x(0), x2: x(0), y1: top - 4, y2: top + plotH + 4, stroke: 'var(--axis)', 'stroke-width': 1 }, svg);

  tableView(
    container,
    ['', ...spec.series.map((s) => s.name), ...(spec.total ? ['Total'] : [])],
    spec.rows.map((r) => [
      r.label,
      ...r.values.map((v) => spec.format(v)),
      ...(spec.total ? [spec.format(r.values.reduce((a, b) => a + b, 0))] : []),
    ]),
  );
}

/**
 * A line chart. spec: { xs, series: [{ name, color, values }], xMax, yMax,
 * xTicks, yTicks, xLabel, formatY, reference: { value, label } }.
 */
function lineChart(container, spec) {
  legend(container, spec.series, 'line');
  const W = 860;
  const H = 360;
  const m = { left: 56, right: 170, top: 16, bottom: 44 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': spec.label }, container);
  const x = (v) => m.left + ((W - m.left - m.right) * (v - spec.xs[0])) / (spec.xMax - spec.xs[0]);
  const y = (v) => H - m.bottom - ((H - m.top - m.bottom) * v) / spec.yMax;
  const tip = tooltip(container);

  for (const t of spec.yTicks) {
    el('line', { x1: m.left, x2: W - m.right, y1: y(t), y2: y(t), stroke: t === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
    text(svg, m.left - 10, y(t) + 4, spec.formatY(t), { 'text-anchor': 'end', fill: 'var(--axis-ink)', 'font-size': 12 });
  }
  for (const t of spec.xTicks) {
    text(svg, x(t), H - m.bottom + 20, String(t), { 'text-anchor': 'middle', fill: 'var(--axis-ink)', 'font-size': 12 });
  }
  text(svg, m.left + (W - m.left - m.right) / 2, H - 6, spec.xLabel, { 'text-anchor': 'middle', fill: 'var(--axis-ink)', 'font-size': 12 });

  if (spec.reference) {
    const ry = y(spec.reference.value);
    el('line', { x1: m.left, x2: W - m.right, y1: ry, y2: ry, stroke: 'var(--ink-2)', 'stroke-width': 1.5 }, svg);
    text(svg, m.left + 8, ry - 8, spec.reference.label, { fill: 'var(--ink)', 'font-size': 12.5, 'font-weight': 600 });
  }

  for (const s of spec.series) {
    const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(spec.xs[i]).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    const lx = x(spec.xs.at(-1));
    const ly = y(s.values.at(-1));
    el('circle', { cx: lx, cy: ly, r: 5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    text(svg, lx + 12, ly + 4, `${s.short ?? s.name} ${spec.formatY(s.values.at(-1), true)}`, { fill: 'var(--ink)', 'font-size': 12.5, 'font-weight': 600 });
  }

  const cross = el('line', { y1: m.top, y2: H - m.bottom, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' }, svg);
  const dots = spec.series.map((s) =>
    el('circle', { r: 5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg),
  );
  const overlay = el('rect', { x: m.left, y: m.top, width: W - m.left - m.right, height: H - m.top - m.bottom, fill: 'transparent' }, svg);
  overlay.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let index = 0;
    for (let i = 0; i < spec.xs.length; i += 1) {
      if (Math.abs(x(spec.xs[i]) - px) < Math.abs(x(spec.xs[index]) - px)) {
        index = i;
      }
    }
    const cx = x(spec.xs[index]);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    spec.series.forEach((s, si) => {
      dots[si].setAttribute('cx', cx);
      dots[si].setAttribute('cy', y(s.values[index]));
      dots[si].setAttribute('visibility', 'visible');
    });
    const html =
      `<strong>${spec.xName} ${spec.xs[index]}</strong>` +
      spec.series.map((s) => row(s.color, s.name, spec.formatY(s.values[index], true))).join('');
    tip.show(html, e.clientX, e.clientY);
  });
  overlay.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    for (const dot of dots) {
      dot.setAttribute('visibility', 'hidden');
    }
    tip.hide();
  });

  const every = spec.tableEvery ?? 10;
  tableView(
    container,
    [spec.xName, ...spec.series.map((s) => s.name)],
    spec.xs
      .map((xv, i) => [xv, ...spec.series.map((s) => spec.formatY(s.values[i], true))])
      .filter((r) => r[0] === 1 || r[0] % every === 0),
  );
}

window.Charts = { stackedBars, lineChart };
