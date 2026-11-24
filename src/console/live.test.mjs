/* Minimal self-check for the external-task selection helper in index.html.
   No dependencies, no browser: the real function source is lifted out of the HTML
   and run in a vm with the same status tables the page uses.
   Run: node src/console/live.test.mjs */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');

/* Lift one top-level declaration out of the page, verbatim. */
function lift(name) {
  const start = html.indexOf('\n  function ' + name + '(');
  assert.notEqual(start, -1, name + ' not found in index.html');
  const i = html.indexOf('{', start);
  let depth = 0;
  for (let k = i; k < html.length; k++) {
    if (html[k] === '{') { depth++; }
    else if (html[k] === '}') { depth--; if (depth === 0) { return html.slice(start + 1, k + 1); } }
  }
  throw new Error('unbalanced braces while reading ' + name);
}
function liftTable(name) {
  const start = html.indexOf('\n  var ' + name + ' = {');
  assert.notEqual(start, -1, name + ' not found in index.html');
  const i = html.indexOf('{', start);
  let depth = 0;
  for (let k = i; k < html.length; k++) {
    if (html[k] === '{') { depth++; }
    else if (html[k] === '}') { depth--; if (depth === 0) { return html.slice(i, k + 1); } }
  }
  throw new Error('unbalanced braces while reading ' + name);
}

const context = vm.createContext({});
vm.runInContext([
  "var EXTERNAL_ROLE = 'unknown';",
  'var TERMINAL = ' + liftTable('TERMINAL') + ';',
  'var ACTIVE_TEXT = ' + liftTable('ACTIVE_TEXT') + ';',
  lift('statusInfo'),
  lift('statusLabel'),
  lift('isExternal'),
  lift('externalPick'),
  'this.api = { externalPick: externalPick };'
].join('\n'), context, { filename: 'console-live-extract.js' });

const externalPick = context.api.externalPick;

/* Newest first, exactly as sortJobs orders state.jobs. */
const ext = (job_id, status, extra) =>
  Object.assign({ job_id: job_id, role: 'unknown', owned: false, snapshot: true, status: status }, extra);

/* 1. An older running external task must outrank a newer finished one. */
{
  const r = externalPick([ext('j-new', 'done'), ext('j-old', 'running')]);
  assert.equal(r.job.job_id, 'j-old', 'active older run must win over latest done');
  assert.equal(r.active, 1);
}

/* 2. Several real active runs are counted. */
{
  const r = externalPick([ext('a', 'running'), ext('b', 'queued'), ext('c', 'done'), ext('d', 'starting')]);
  assert.equal(r.active, 3, 'active count must be the real number of running external tasks');
  assert.equal(r.job.job_id, 'a', 'the newest active one is the one shown');
}

/* 3. All terminal: no activity, fall back to the latest external record. */
{
  const r = externalPick([ext('newest', 'done'), ext('older', 'failed')]);
  assert.equal(r.active, 0, 'terminal states must not count as active');
  assert.equal(r.job.job_id, 'newest', 'with nothing active the latest external record is shown');
}

/* dsh_delegate stages stay active until the workflow returns for review. */
{
  const workflow = ext('workflow', 'planning');
  for (const stage of ['planning', 'judging', 'executing']) {
    workflow.status = stage;
    const r = externalPick([ext('newer-finished', 'done'), workflow]);
    assert.equal(r.active, 1, stage + ' must remain active');
    assert.equal(r.job, workflow);
  }
  workflow.status = 'awaiting_review';
  assert.equal(externalPick([workflow]).active, 0, 'returned workflow must stop activity');
}

/* 4. No external tasks at all: nothing to point at. */
{
  const empty = externalPick([]);
  assert.equal(empty.job, null, 'no external task means no pick');
  assert.equal(empty.active, 0);
  const onlyOwned = externalPick([{ job_id: 'm1', role: 'main', status: 'running' }]);
  assert.equal(onlyOwned.job, null, 'console-owned roles are not external');
  assert.equal(onlyOwned.active, 0);
}

/* ================= the live execution graph (pure data) ================= */

/* The main diagram is pure data derived from one job, so it can be checked
   without a browser: no invented role, no invented parallelism, no invented
   worker while a workflow is still planning. */

vm.runInContext([
  "var EXTERNAL_LABEL = '外部 MCP';",
  "var LV_MAX_CHILDREN = 8;",
  lift('shortId'),
  lift('clipText'),
  lift('childStatusText'),
  lift('liveGraph'),
  'this.api.liveGraph = liveGraph;'
].join('\n'), context, { filename: 'console-live-graph.js' });
const liveGraph = context.api.liveGraph;

const ROLE_WORDS = ['worker', 'explorer', 'researcher', 'architect', 'JEV', 'main'];
const mentionsRole = g => g.nodes.some(n =>
  ROLE_WORDS.some(w => (n.title + ' ' + n.meta).toLowerCase().includes(w.toLowerCase())));
const childNodes = g => g.nodes.filter(n => n.kind === 'child');
const liveNodesIn = g => g.nodes.filter(n => n.live);
const liveEdgesIn = g => g.edges.filter(e => e.live);

/* 1. A real dsh_start task is one execution node. It is never split into roles. */
{
  const g = liveGraph(ext('start-1', 'running', { task_preview: 'read the repo' }));
  assert.equal(childNodes(g).length, 0, 'a dsh_start task has no child nodes');
  assert.equal(g.nodes.filter(n => n.kind === 'exec').length, 1, 'a dsh_start task has exactly one execution node');
  assert.ok(!mentionsRole(g), 'the main diagram must not draw main/worker/explorer/architect/JEV');
  assert.ok(g.nodes.some(n => (n.meta + n.title).includes('角色未知')), 'an external task must say its role is unknown');
}

/* 2. A workflow expands exactly the children workflow_result recorded. */
const wf = (status, children, extra) => ext('wf-1', status,
  Object.assign({ kind: 'workflow', phase: 'executing', workflow_result: { kind: 'workflow', children } }, extra));
{
  const g = liveGraph(wf('executing', [
    { task_id: 'read', job_id: 'j1', status: 'done', summary: 'read the file' },
    { task_id: 'patch', job_id: 'j2', status: 'running', summary: '' },
    { task_id: 'verify', job_id: null, status: 'blocked', summary: '' }
  ]));
  /* Arrays built inside the vm are joined to plain strings: deepEqual compares
     prototypes, and a vm array is not a host array. */
  assert.equal(childNodes(g).map(n => n.title).join(','), 'read,patch,verify', 'children are drawn as recorded');
  assert.ok(!mentionsRole(g), 'a workflow must not be relabelled into the three proposed roles');
  assert.ok(!childNodes(g).find(n => n.title === 'verify').sub.includes('job '), 'a child with no job_id is not invented');

  /* Only the wire into a node that is genuinely active carries a dash. */
  assert.equal(liveEdgesIn(g).map(e => e.id).sort().join(','), 'dsh-1,in-dsh', 'only the active path may flow');
  for (const edge of g.edges) {
    const target = g.nodes.find(n => n.key === edge.to);
    assert.equal(edge.live, !!target.live, 'an edge flows exactly when its target node is active');
  }
  assert.equal(liveNodesIn(g).length, 2, 'only the running nodes breathe');
}

/* 3. Returned means returned: nothing flows any more. */
{
  const g = liveGraph(wf('awaiting_review', [{ task_id: 'patch', job_id: 'j2', status: 'done', summary: 'done' }]));
  assert.equal(g.active, false, 'a returned workflow is not active');
  assert.equal(liveEdgesIn(g).length, 0, 'a returned workflow stops every dash');
  assert.equal(liveNodesIn(g).length, 0, 'a returned workflow stops every breathing node');
  const d = liveGraph(wf('failed', [{ task_id: 'patch', job_id: 'j2', status: 'failed' }]));
  assert.equal(d.active, false, 'a failed workflow is not active');
  const stale = liveGraph(wf('awaiting_review', [{ task_id: 'old', job_id: 'j3', status: 'running' }]));
  assert.equal(stale.active, false, 'terminal parent overrides stale running child snapshots');
}

/* 4. A planning or judging phase with no children yet shows that phase, and no
      worker is invented to fill the gap. */
{
  const g = liveGraph(wf('planning', [], { phase: 'planning' }));
  assert.equal(childNodes(g).length, 0, 'no children means no worker nodes');
  assert.ok(g.nodes.some(n => n.title.includes('planning')), 'the real phase is shown');
  assert.equal(liveEdgesIn(g).map(e => e.id).join(','), 'in-dsh', 'planning flows into dispatch only');
  const loading = liveGraph(ext('cold-workflow', 'planning', { kind: 'workflow', phase: 'planning' }));
  assert.equal(loading.kind, 'workflow', 'workflow identity does not depend on a loaded detail');
  assert.equal(loading.nodes.filter(n => n.kind === 'exec').length, 0, 'missing workflow details do not invent a single worker');
}

/* 5. An unknown status is not activity. */
{
  const g = liveGraph(ext('u-1', 'banana'));
  assert.equal(g.active, false, 'an unknown status must not light the diagram');
  assert.equal(liveEdgesIn(g).length, 0, 'an unknown status moves nothing');
}

/* 6. An idle console draws nothing at all rather than a plausible fiction. */
{
  const g = liveGraph(null);
  assert.equal(g.nodes.length, 0, 'with no real task there are no nodes');
  assert.equal(g.active, false);
}

/* 7. Hundreds of real children are clipped, and the clip says how many. */
{
  const many = Array.from({ length: 12 }, (_, i) => ({ task_id: 't' + i, job_id: 'j' + i, status: 'done' }));
  const g = liveGraph(wf('executing', many));
  assert.equal(childNodes(g).length, 8, 'the main diagram expands a bounded number of children');
  assert.ok(g.note.includes('12'), 'the note reports the real child count');
  assert.ok(g.note.includes('4'), 'the note reports how many were left out');
}

/* Exercise the actual renderer: foreign role labels must never light role nodes. */
const roles = ['main', 'worker', 'explorer', 'researcher', 'architect'];
function node(role, live) {
  const classes = new Set();
  return {
    textContent: '', dataset: {}, classes,
    getAttribute: name => name === 'data-role' ? role : name === 'data-live' ? live : null,
    classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) }
  };
}
const buttons = roles.map(role => node(role));
const badges = roles.map(role => node(null, role));
const elements = Object.fromEntries(
  ['cad-mcp-live', 'n-ext', 'n-ext-live', 'n-ext-count', 'lv-head', 'lv-note', 'lv-tag']
    .map(id => [id, node()]));

/* A DOM just real enough for the diagram renderer: enough to count what it
   creates, so a redraw that rebuilt the nodes would be visible here. */
function fakeEl(tag) {
  const el = {
    tag, textContent: '', type: '', hidden: false, attrs: {}, children: [], classes: new Set(),
    parentNode: null,
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  };
  el.classList = { toggle: (n, on) => on ? el.classes.add(n) : el.classes.delete(n) };
  return el;
}
let created = 0;
const lvFlow = fakeEl('div');
elements['lv-flow'] = lvFlow;
Object.assign(context, {
  ROLES: roles, POLL_MS: 8000, ROLE_LABEL: Object.fromEntries(roles.map(r => [r, r])),
  EXTERNAL_LABEL: '外部 MCP',
  state: { jobs: roles.map(role => ext(role, 'running', { role })) },
  liveNodes: badges, root: { querySelectorAll: () => buttons },
  document: { getElementById: id => elements[id], createElement: tag => { created++; return fakeEl(tag); } },
  jobsState: node(), lvFlow: lvFlow,
  lvHead: elements['lv-head'], lvNote: elements['lv-note'], lvTag: elements['lv-tag']
});
vm.runInContext([
  'var lvNodes = {};', 'var lvSlots = [];', 'var lvSig = "";', 'var lvGraph = { nodes: [], edges: [] };',
  lift('clear'), lift('shortId'), lift('countActive'), lift('anyActive'), lift('roleLabel'), lift('renderLive'),
  lift('findJob'), lift('livePick'), lift('lvSlotContainers'), lift('lvNodeEl'), lift('renderLiveGraph'),
  'this.renderLiveGraph = renderLiveGraph;'
].join('\n'), context);
context.renderLive();
assert.ok(buttons.every(button => !button.classes.has('is-on')), 'external known roles must not light role nodes');
assert.ok(badges.every(badge => badge.textContent === ''), 'external known roles must not write role badges');
assert.ok(elements['n-ext'].classes.has('is-busy'), 'real external activity must light the MCP node');
assert.equal(elements['cad-mcp-live'].dataset.jobId, elements['n-ext'].dataset.jobId);
for (const job of context.state.jobs) job.status = 'done';
context.renderLive();
assert.ok(!elements['n-ext'].classes.has('is-busy'), 'returned jobs must stop the MCP activity');
context.state.jobs = [{ job_id: 'owned-main', role: 'main', owned: true, status: 'running' }];
context.renderLive();
assert.ok(buttons[0].classes.has('is-on'), 'console-owned main still lights its role node');
context.state.jobs.unshift(ext('older-done', 'done'));
assert.equal(context.livePick().job_id, 'owned-main', 'owned active task outranks unrelated external history');
context.state.graphId = 'older-done';
assert.equal(context.livePick().job_id, 'older-done', 'explicit history selection stays on that workflow');
context.state.graphId = null;
context.state.jobs = [ext('new-child', 'running'), wf('executing', [])];
assert.equal(context.livePick().kind, 'workflow', 'auto-follow shows the parent workflow rather than a newer child job');

/* ================= the live execution graph ================= */

/* 8. A redraw must not rebuild the diagram. The clock ticks every second and the
      poll every 8s; recreating the same nodes would restart every dash and every
      breath, which is exactly the "still picture" this diagram has to escape. */
{
  context.state.jobs = [wf('executing', [
    { task_id: 'read', job_id: 'j1', status: 'queued' },
    { task_id: 'patch', job_id: 'j2', status: 'queued' }
  ])];
  context.renderLiveGraph();
  const afterFirst = created;
  const inEl = lvFlow.children[0].children[0];
  const hubEl = lvFlow.children[1].children[0];
  const firstChild = lvFlow.children[2].children[0];

  /* Same run, later tick: the child's own status moved, the shape did not. */
  context.state.jobs[0].workflow_result.children[1].status = 'running';
  context.renderLiveGraph();
  assert.equal(created, afterFirst, 'a redraw of the same structure creates no new element');
  assert.equal(lvFlow.children[0].children[0], inEl, 'the input node keeps its element');
  assert.equal(lvFlow.children[1].children[0], hubEl, 'the dispatch node keeps its element');
  assert.equal(lvFlow.children[2].children[0], firstChild, 'a child node keeps its element');

  /* Only the running nodes carry the breathing class, and only the wire into a
     running node carries the dash — the done sibling stays still. */
  const drawn = lvFlow.children.flatMap(slot => slot.children);
  assert.equal(drawn.filter(el => el.classes.has('is-live')).length, 2, 'only the running nodes breathe');
  const g = context.lvGraph;
  assert.equal(g.edges.filter(e => e.live).map(e => e.id).sort().join(','), 'dsh-1,in-dsh', 'only the active path flows');

  /* A genuinely new child may rebuild the middle group; the other nodes stand. */
  context.state.jobs[0].workflow_result.children.push({ task_id: 'verify', job_id: 'j3', status: 'done' });
  context.renderLiveGraph();
  assert.equal(lvFlow.children[2].children.length, 3, 'a real new child is drawn');
  assert.equal(lvFlow.children[0].children[0], inEl, 'a new child does not disturb the input node');
  assert.equal(lvFlow.children[1].children[0], hubEl, 'a new child does not disturb the dispatch node');
}

/* Check the actual view switch and geometry adapter that the browser exposed. */
Object.assign(context, {
  roleBoard: fakeEl('div'), roleLegend: fakeEl('div'), wires: fakeEl('svg'),
  extNodeEl: fakeEl('button'), liveView: fakeEl('div'), liveWires: fakeEl('svg'),
  viewToggle: fakeEl('button'), viewNote: fakeEl('span'),
  window: { requestAnimationFrame() {} }, draw() {}, stage: { clientWidth: 600 },
  mkTag(tag, attrs) { const el = fakeEl(tag); for (const [key,value] of Object.entries(attrs)) el.setAttribute(key,value); return el; }
});
vm.runInContext([
  'var lvPaths = {}; var lvEdgeSig = "";',
  lift('clamp'), lift('resolveSide'), lift('anchor'), lift('layoutEdge'), lift('drawLive'), lift('applyViewMode')
].join('\n'), context);
context.state.view = 'live';
context.applyViewMode();
assert.equal(context.roleBoard.hidden, true, 'live mode hides the proposed architecture');
assert.equal(context.liveView.hidden, false);
context.state.view = 'roles';
context.applyViewMode();
assert.equal(context.roleBoard.hidden, false, 'roles mode preserves the manual diagram');
assert.equal(context.liveView.hidden, true);
context.state.view = 'live';
context.applyViewMode();
context.state.jobs = [ext('geometry-run', 'running')];
context.renderLiveGraph();
assert.equal(context.lvNodes.exec.el.getAttribute('data-slot'), '2', 'execution sits above the return slot');
const boxes = Object.fromEntries(context.lvGraph.nodes.map((n,i) => [n.key,
  { left: 0, top: i*30, width: 20, height: 10, cx: 10, cy: i*30+5, right: 20, bottom: i*30+10 }]));
context.lvBox = key => boxes[key];
context.drawLive();
assert.ok(Object.values(context.lvPaths).every(path => /^M/.test(path.attrs.d)), 'live edges must resolve real endpoints into visible SVG paths');
context.state.jobs = [];
context.renderLiveGraph();
context.drawLive();
assert.equal(lvFlow.children.reduce((n,slot) => n+slot.children.length,0), 0, 'idle graph removes stale nodes');

console.log('live.test.mjs ok · selection, stages, role boundaries, lifecycle, graph geometry and view switching');
