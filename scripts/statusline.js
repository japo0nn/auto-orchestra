#!/usr/bin/env node
'use strict';
// Status line: model | context % | session cost, with a warning above statusline.warnPercent.
const C = require('./lib/common');

(async () => {
  let out = '';
  try {
    const d = await C.readInput();
    if (!d) return;
    const proj = (d.workspace && (d.workspace.project_dir || d.workspace.current_dir)) || d.cwd || process.cwd();
    const cfg = C.loadConfig(proj);
    const warn = Number(cfg.statusline.warnPercent) || 60;
    const color = !process.env.NO_COLOR;
    const paint = (c, s) => color ? '\u001b[' + c + 'm' + s + '\u001b[0m' : s;
    const bits = [];
    if (d.model && (d.model.display_name || d.model.id)) bits.push(d.model.display_name || d.model.id);
    const cw = d.context_window || {};
    const pct = typeof cw.used_percentage === 'number' ? Math.round(cw.used_percentage) : null;
    if (pct !== null) {
      const txt = 'ctx ' + pct + '%';
      if (pct >= warn + 20) bits.push(paint('31', txt + ' ⚠ /compact · /auto-orchestra:handoff · use a subagent'));
      else if (pct >= warn) bits.push(paint('33', txt + ' ⚠ /compact · /auto-orchestra:handoff · or delegate to a subagent'));
      else bits.push(txt);
    }
    const cost = d.cost && typeof d.cost.total_cost_usd === 'number' ? d.cost.total_cost_usd : null;
    if (cost !== null) bits.push('$' + cost.toFixed(2));
    out = bits.join(' │ ');
  } catch (e) { out = ''; }
  process.stdout.write(out);
})();
