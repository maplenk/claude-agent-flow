import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseJsonlFile, discoverSessions } from './jsonlParser';
import { SessionWatcher } from './sessionWatcher';

let currentPanel: vscode.WebviewPanel | undefined;
let sessionWatcher: SessionWatcher | undefined;
const claudeDir = path.join(os.homedir(), '.claude');

function isValidSessionPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const allowedBase = path.resolve(path.join(claudeDir, 'projects'));
  return resolved.startsWith(allowedBase + path.sep) && resolved.endsWith('.jsonl');
}

export function activate(context: vscode.ExtensionContext) {
  const openCmd = vscode.commands.registerCommand('agentFlow.openPanel', async () => {
    if (currentPanel) { currentPanel.reveal(vscode.ViewColumn.One); return; }
    currentPanel = vscode.window.createWebviewPanel('agentFlow', 'Agent Flow', vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
    });
    currentPanel.webview.html = getInlineWebviewContent();
    currentPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'requestSessions': {
          const sessions = discoverSessions(claudeDir);
          currentPanel?.webview.postMessage({ command: 'sessionsList', sessions });
          break;
        }
        case 'loadSession': {
          if (!isValidSessionPath(msg.filePath)) { break; }
          const parsed = parseJsonlFile(msg.filePath);
          parsed.isLive = true;
          currentPanel?.webview.postMessage({ command: 'sessionData', data: parsed, filePath: msg.filePath });
          startLiveMode(msg.filePath);
          break;
        }
        case 'startLive': {
          if (!isValidSessionPath(msg.filePath)) { break; }
          startLiveMode(msg.filePath);
          break;
        }
        case 'stopLive': { sessionWatcher?.dispose(); sessionWatcher = undefined; break; }
        case 'autoDetect': {
          const w = new SessionWatcher(claudeDir);
          const active = w.findActiveSession();
          w.dispose();
          if (active) {
            const parsed = parseJsonlFile(active);
            parsed.isLive = true;
            currentPanel?.webview.postMessage({ command: 'sessionData', data: parsed, filePath: active });
            startLiveMode(active);
          } else { vscode.window.showInformationMessage('No active Claude Code session found.'); }
          break;
        }
      }
    });
    currentPanel.onDidDispose(() => { currentPanel = undefined; sessionWatcher?.dispose(); sessionWatcher = undefined; });
    setTimeout(() => { currentPanel?.webview.postMessage({ command: 'ready' }); }, 500);
  });

  const selectCmd = vscode.commands.registerCommand('agentFlow.selectSession', async () => {
    const sessions = discoverSessions(claudeDir);
    if (sessions.length === 0) { vscode.window.showInformationMessage('No Claude Code sessions found in ~/.claude/projects/'); return; }
    const items = sessions.slice(0, 50).map(s => ({ label: s.label, description: new Date(s.date).toLocaleString(), filePath: s.filePath }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select a Claude Code session to visualize' });
    if (selected) {
      await vscode.commands.executeCommand('agentFlow.openPanel');
      setTimeout(() => { const p = parseJsonlFile(selected.filePath); p.isLive = true; currentPanel?.webview.postMessage({ command: 'sessionData', data: p, filePath: selected.filePath }); startLiveMode(selected.filePath); }, 300);
    }
  });
  context.subscriptions.push(openCmd, selectCmd);
}

function startLiveMode(filePath: string): void {
  sessionWatcher?.dispose();
  sessionWatcher = new SessionWatcher(claudeDir, 400);

  let debounceTimer: NodeJS.Timeout | undefined;

  sessionWatcher.on('error', (err) => {
    console.error('[AgentFlow] SessionWatcher error:', err);
  });

  sessionWatcher.on('newEntries', () => {
    // Debounce: wait 200ms after last change before re-parsing
    if (debounceTimer) { clearTimeout(debounceTimer); }
    debounceTimer = setTimeout(() => {
      try {
        const parsed = parseJsonlFile(filePath);
        parsed.isLive = true;
        currentPanel?.webview.postMessage({ command: 'liveUpdate', data: parsed, filePath });
      } catch { /* ignore */ }
    }, 200);
  });

  sessionWatcher.watchFile(filePath);
}

function getInlineWebviewContent(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Agent Flow</title>
<style>${CSS}</style>
</head>
<body>
${HTML}
<script>${JS}</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CSS
// ═══════════════════════════════════════════════════════════════════════════════
const CSS = /* css */ `
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg-deep: #0a0e1a; --bg-surface: #111827; --bg-card: #1a2236;
  --border: #2a3550; --text: #e2e8f0; --text-dim: #8892a8;
  --accent: #f59e0b; --accent-glow: rgba(245,158,11,0.3);
  --agent-blue: #3b82f6; --agent-blue-glow: rgba(59,130,246,0.4);
  --tool-cyan: #06b6d4; --tool-cyan-glow: rgba(6,182,212,0.3);
  --user-green: #10b981; --error-red: #ef4444; --live-red: #ef4444;
  --replay-purple: #a855f7;
  --font: 'Segoe UI', system-ui, -apple-system, sans-serif;
  --mono: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
}
body { background: var(--bg-deep); color: var(--text); font-family: var(--font); overflow: hidden; height: 100vh; display: flex; flex-direction: column; }

.toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--bg-surface); border-bottom: 1px solid var(--border); min-height: 38px; flex-shrink: 0; }
.toolbar .tabs { display: flex; gap: 4px; flex: 1; overflow-x: auto; }
.toolbar .tab { padding: 4px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-dim); white-space: nowrap; transition: all 0.15s; }
.toolbar .tab:hover { border-color: var(--accent); color: var(--text); }
.toolbar .tab.active { background: var(--accent); color: #000; border-color: var(--accent); }
.status-pills { display: flex; gap: 8px; align-items: center; font-size: 12px; flex-shrink: 0; }
.pill { padding: 3px 10px; border-radius: 12px; background: var(--bg-card); border: 1px solid var(--border); font-family: var(--mono); font-size: 11px; }
.pill.live { background: var(--live-red); color: #fff; border-color: var(--live-red); animation: pulse-live 1.5s infinite; }
.pill.replay { background: var(--replay-purple); color: #fff; border-color: var(--replay-purple); animation: pulse-live 2s infinite; }
@keyframes pulse-live { 0%,100%{opacity:1}50%{opacity:0.6} }
.pill .label { color: var(--text-dim); margin-right: 4px; }

.view-tabs { display: flex; gap: 0; padding: 0 12px; background: var(--bg-surface); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.view-tab { padding: 6px 16px; font-size: 12px; cursor: pointer; color: var(--text-dim); border-bottom: 2px solid transparent; transition: all 0.15s; }
.view-tab:hover { color: var(--text); }
.view-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

.main-area { flex: 1; position: relative; overflow: hidden; }
#graphCanvas { width: 100%; height: 100%; cursor: grab; }
#graphCanvas:active { cursor: grabbing; }

.side-panel { position: absolute; top: 0; right: 0; width: 380px; height: 100%; background: var(--bg-surface); border-left: 1px solid var(--border); display: none; flex-direction: column; overflow: hidden; z-index: 10; }
.side-panel.visible { display: flex; }
.side-header { padding: 10px 14px; font-size: 13px; font-weight: 600; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.side-body { flex: 1; overflow-y: auto; padding: 10px; }

.chat-entry { margin-bottom: 10px; padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.5; font-family: var(--mono); word-break: break-word; }
.chat-entry.user { background: rgba(16,185,129,0.1); border-left: 3px solid var(--user-green); }
.chat-entry.assistant { background: rgba(59,130,246,0.08); border-left: 3px solid var(--agent-blue); }
.chat-entry.tool { background: rgba(6,182,212,0.08); border-left: 3px solid var(--tool-cyan); }
.chat-entry .role { font-weight: 700; text-transform: uppercase; font-size: 10px; margin-bottom: 4px; }
.chat-entry .role.user { color: var(--user-green); }
.chat-entry .role.assistant { color: var(--agent-blue); }
.chat-entry .role.tool { color: var(--tool-cyan); }

.file-group { margin-bottom: 14px; }
.file-group-header { font-size: 11px; color: var(--accent); font-weight: 600; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; }
.file-group-count { color: var(--text-dim); font-weight: 400; }
.file-item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-family: var(--mono); margin-bottom: 3px; transition: background 0.1s; cursor: default; }
.file-item:hover { background: rgba(255,255,255,0.04); }
.file-action { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; flex-shrink: 0; }
.file-action.read { background: rgba(59,130,246,0.15); color: var(--agent-blue); }
.file-action.write { background: rgba(245,158,11,0.15); color: var(--accent); }
.file-action.edit { background: rgba(168,85,247,0.15); color: #a855f7; }
.file-action.grep { background: rgba(6,182,212,0.15); color: var(--tool-cyan); }
.file-action.glob { background: rgba(136,146,168,0.15); color: var(--text-dim); }
.file-path { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.file-agent { color: var(--text-dim); font-size: 10px; flex-shrink: 0; max-width: 100px; overflow: hidden; text-overflow: ellipsis; }

/* ── Timeline / Replay Bar ─────────────────────────────── */
.timeline-bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--bg-surface); border-top: 1px solid var(--border); min-height: 40px; flex-shrink: 0; }
.tl-time { font-family: var(--mono); font-size: 11px; color: var(--text-dim); min-width: 42px; text-align: center; }
.tl-time.replay-active { color: var(--replay-purple); font-weight: 600; }
.tl-scrubber { flex: 1; position: relative; height: 20px; display: flex; align-items: center; cursor: pointer; }
.tl-track { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); height: 4px; background: var(--bg-card); border-radius: 2px; overflow: hidden; }
.tl-progress { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.05s linear; }
.tl-dots-overlay { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); height: 12px; display: flex; align-items: center; pointer-events: none; }
.tl-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; position: absolute; transform: translateX(-50%); pointer-events: auto; cursor: pointer; transition: transform 0.1s, opacity 0.15s; }
.tl-dot:hover { transform: translateX(-50%) scale(2); }
.tl-dot.dimmed { opacity: 0.25; }
.tl-dot.user { background: var(--user-green); }
.tl-dot.assistant { background: var(--agent-blue); }
.tl-dot.tool { background: var(--tool-cyan); }
.tl-dot.agent { background: var(--accent); }
.tl-dot.orchestrator { background: var(--accent); }
.tl-dot.thinking { background: #94a3b8; }
.tl-handle { position: absolute; top: 50%; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid #fff; transform: translate(-50%, -50%); box-shadow: 0 0 8px var(--accent-glow); pointer-events: none; z-index: 2; transition: left 0.05s linear; }
.tl-handle.replay-active { background: var(--replay-purple); box-shadow: 0 0 10px rgba(168,85,247,0.5); }

.tl-controls { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
.tl-btn { padding: 3px 8px; font-size: 11px; border-radius: 3px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-dim); cursor: pointer; transition: all 0.15s; font-family: var(--mono); }
.tl-btn:hover { border-color: var(--accent); color: var(--text); }
.tl-btn.active { background: var(--accent); color: #000; border-color: var(--accent); }
.tl-btn.play { font-size: 13px; min-width: 28px; text-align: center; }
.tl-btn.review { background: var(--replay-purple); color: #fff; border-color: var(--replay-purple); font-weight: 600; }
.tl-btn.review:hover { background: #9333ea; }
.tl-btn.live-exit { background: var(--live-red); color: #fff; border-color: var(--live-red); font-weight: 600; }
.tl-btn.live-active { background: var(--live-red); color: #fff; border-color: var(--live-red); font-weight: 600; animation: pulse-live 1.5s infinite; }
.tl-sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; }
.tl-event-count { font-family: var(--mono); font-size: 10px; color: var(--text-dim); min-width: 50px; text-align: right; }

/* Welcome */
.welcome { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 20px; }
.welcome h1 { font-size: 22px; color: var(--accent); }
.welcome p { color: var(--text-dim); font-size: 14px; text-align: center; max-width: 400px; }
.welcome .actions { display: flex; gap: 12px; }
.welcome .btn { padding: 8px 20px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text); cursor: pointer; font-size: 13px; transition: all 0.15s; }
.welcome .btn:hover { border-color: var(--accent); background: var(--bg-surface); }
.welcome .btn.primary { background: var(--accent); color: #000; border-color: var(--accent); }

.node-tooltip { position: absolute; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 12px; max-width: 400px; max-height: 300px; overflow-y: auto; font-size: 12px; font-family: var(--mono); line-height: 1.5; pointer-events: none; display: none; z-index: 100; box-shadow: 0 8px 32px rgba(0,0,0,0.5); word-break: break-word; }
.node-tooltip.visible { display: block; pointer-events: auto; }
.node-tooltip .tt-title { font-weight: 700; color: var(--accent); margin-bottom: 6px; }
.node-tooltip .tt-body { color: var(--text-dim); white-space: pre-wrap; }

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: var(--bg-deep); }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
`;

// ═══════════════════════════════════════════════════════════════════════════════
//  HTML
// ═══════════════════════════════════════════════════════════════════════════════
const HTML = /* html */ `
<div class="toolbar">
  <div class="tabs" id="sessionTabs"></div>
  <div class="status-pills">
    <span class="pill" id="livePill" style="display:none"><span class="label">●</span> LIVE</span>
    <span class="pill" id="replayPill" style="display:none"><span class="label">▶</span> REPLAY</span>
    <span class="pill"><span class="label">agents</span> <span id="agentCount">0</span></span>
    <span class="pill"><span class="label">tokens</span> <span id="tokenCount">0</span></span>
    <span class="pill"><span class="label">$</span><span id="costValue">0.00</span></span>
    <span class="pill"><span class="label">files</span> <span id="fileCount">0</span></span>
  </div>
</div>
<div class="view-tabs">
  <div class="view-tab active" data-view="graph">Graph</div>
  <div class="view-tab" data-view="files">Files</div>
  <div class="view-tab" data-view="chat">Chat</div>
  <div class="view-tab" data-view="cost">$Cost</div>
  <div class="view-tab" data-view="timeline">Timeline</div>
</div>
<div class="main-area" id="mainArea">
  <canvas id="graphCanvas"></canvas>
  <div class="side-panel" id="sidePanel"></div>
  <div class="node-tooltip" id="nodeTooltip"></div>
  <div class="welcome" id="welcomeScreen">
    <h1>⬡ Agent Flow</h1>
    <p>Visualize Claude Code multi-agent workflows in real-time with force-directed physics, particle effects, file tracking, and session replay.</p>
    <div class="actions">
      <button class="btn primary" id="btnAutoDetect">Auto-Detect Active Session</button>
      <button class="btn" id="btnBrowse">Browse Sessions</button>
    </div>
  </div>
</div>
<div class="timeline-bar" id="timelineBar">
  <span class="tl-time" id="tlTime">0:00</span>
  <div class="tl-scrubber" id="tlScrubber">
    <div class="tl-track"><div class="tl-progress" id="tlProgress"></div></div>
    <div class="tl-dots-overlay" id="tlDots"></div>
    <div class="tl-handle" id="tlHandle" style="left:0%"></div>
  </div>
  <span class="tl-time" id="tlTotal">0:00</span>
  <div class="tl-sep"></div>
  <div class="tl-controls">
    <button class="tl-btn play" id="btnPlayPause" title="Play/Pause replay">⏸</button>
    <button class="tl-btn" id="btnSpeed" data-speed-idx="2" title="Playback speed">1x</button>
    <div class="tl-sep"></div>
    <button class="tl-btn review" id="btnReview" title="Enter replay mode">▶ Review</button>
    <div class="tl-sep"></div>
    <button class="tl-btn" id="btnLive" title="Toggle live mode">● Live</button>
  </div>
  <span class="tl-event-count" id="tlEventCount"></span>
</div>`;

// ═══════════════════════════════════════════════════════════════════════════════
//  JavaScript
// ═══════════════════════════════════════════════════════════════════════════════
const JS = /* javascript */ `
const vscode = acquireVsCodeApi();

// ═══════════════════════════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════════════════════════
let allNodes = [];       // complete set from parser (with layout positions)
let allEdges = [];       // complete edge set
let nodes = [];          // currently visible nodes (filtered during replay)
let edges = [];          // currently visible edges
let sessionData = null;

let canvas, ctx;
let cameraX = 0, cameraY = 0, zoom = 1;
let isDragging = false, dragStartX = 0, dragStartY = 0;
let draggedNode = null;
let hoveredNode = null;
let starField = [];
let particles = [];
let time = 0;
let currentView = 'graph';
let currentFilePath = null;
let isLiveMode = false;

// Physics
const PHYSICS = {
  repulsion: 8000, attraction: 0.003, edgeLength: 160,
  centerGravity: 0.0008, damping: 0.88, minVelocity: 0.01, maxVelocity: 8,
};
let physicsActive = true;
let settledFrames = 0;

// ── Replay state ──────────────────────────────────────────
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
let replay = {
  active: false,        // replay mode on/off
  playing: false,       // animation playing
  speedIdx: 2,          // index into SPEEDS (default 1x)
  cursorMs: 0,          // current playback position (ms from start)
  startMs: 0,           // earliest timestamp
  endMs: 0,             // latest timestamp
  durationMs: 0,        // endMs - startMs
  sortedEvents: [],     // all nodes sorted by timestamp (with ms field)
  visibleIds: new Set(),
  lastFrameTime: 0,     // for delta-time calculation
};
let scrubDragging = false;

// ═══════════════════════════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('graphCanvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  generateStarField();
  replay.lastFrameTime = performance.now();
  requestAnimationFrame(renderLoop);

  window.addEventListener('resize', resizeCanvas);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDoubleClick);

  document.getElementById('btnAutoDetect').addEventListener('click', () => vscode.postMessage({ command: 'autoDetect' }));
  document.getElementById('btnBrowse').addEventListener('click', () => vscode.postMessage({ command: 'requestSessions' }));
  document.querySelectorAll('.view-tab').forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.view)));

  // Replay controls
  document.getElementById('btnPlayPause').addEventListener('click', togglePlayPause);
  document.getElementById('btnSpeed').addEventListener('click', cycleSpeed);
  document.getElementById('btnReview').addEventListener('click', toggleReplayMode);
  document.getElementById('btnLive').addEventListener('click', toggleLiveMode);

  // Scrubber interaction
  const scrubber = document.getElementById('tlScrubber');
  scrubber.addEventListener('mousedown', onScrubDown);
  window.addEventListener('mousemove', onScrubMove);
  window.addEventListener('mouseup', onScrubUp);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Message Handler
// ═══════════════════════════════════════════════════════════════════════════════
window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.command) {
    case 'sessionData': case 'liveUpdate':
      if (msg.filePath) currentFilePath = msg.filePath;
      loadSessionData(msg.data);
      break;
    case 'sessionsList': showSessionPicker(msg.sessions); break;
  }
});

function loadSessionData(data) {
  const isLiveUpdate = data.isLive && allNodes.length > 0;
  sessionData = data;

  if (isLiveUpdate) {
    // Preserve existing node positions during live updates
    const savedPos = {};
    for (const n of allNodes) {
      savedPos[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy, pinned: n.pinned };
    }
    allNodes = initialLayout(data.nodes, data.edges);
    for (const n of allNodes) {
      if (savedPos[n.id]) {
        n.x = savedPos[n.id].x;
        n.y = savedPos[n.id].y;
        n.vx = savedPos[n.id].vx;
        n.vy = savedPos[n.id].vy;
        n.pinned = savedPos[n.id].pinned;
      }
    }
    allEdges = data.edges;
    physicsActive = true;
    settledFrames = 0;
  } else {
    allNodes = initialLayout(data.nodes, data.edges);
    allEdges = data.edges;
    particles = [];
    physicsActive = true;
    settledFrames = 0;
  }

  document.getElementById('welcomeScreen').style.display = 'none';
  document.getElementById('agentCount').textContent = data.agentCount;
  document.getElementById('tokenCount').textContent = formatTokens(data.totalTokens);
  document.getElementById('costValue').textContent = data.totalCost.toFixed(2);
  const uniqueFiles = new Set((data.touchedFiles || []).map(f => f.filePath));
  document.getElementById('fileCount').textContent = uniqueFiles.size;

  isLiveMode = !!data.isLive;
  if (data.isLive) {
    document.getElementById('livePill').style.display = 'inline';
    document.getElementById('livePill').classList.add('live');
  } else {
    document.getElementById('livePill').style.display = 'none';
    document.getElementById('livePill').classList.remove('live');
  }
  updateLiveButton();

  // Build sorted events for replay
  buildReplayData(data.nodes);
  buildTimelineDots();
  updateTimelineUI();

  // Exit replay on live updates
  if (data.isLive && replay.active) exitReplay();

  // Show all when not replaying
  if (!replay.active) {
    nodes = allNodes;
    edges = allEdges;
  } else {
    applyReplayCursor();
  }

  // Center camera only on initial load, not live updates
  if (!isLiveUpdate && allNodes.length > 0) {
    const avgX = allNodes.reduce((s, n) => s + n.x, 0) / allNodes.length;
    const avgY = allNodes.reduce((s, n) => s + n.y, 0) / allNodes.length;
    cameraX = -avgX + canvas.width / 2;
    cameraY = -avgY + canvas.height / 2;
  }

  if (currentView === 'files') buildFilesView();
  if (currentView === 'chat') buildChatView();
  if (currentView === 'cost') buildCostView();
  if (currentView === 'timeline') buildTimelineView();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REPLAY ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function buildReplayData(rawNodes) {
  // Parse timestamps, sort events
  const events = [];
  let minMs = Infinity, maxMs = -Infinity;

  for (const n of rawNodes) {
    let ms = 0;
    if (n.timestamp) {
      ms = new Date(n.timestamp).getTime();
      if (isNaN(ms)) ms = 0;
    }
    events.push({ id: n.id, ms, type: n.type });
    if (ms > 0 && ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }

  // Nodes without timestamps get placed at minMs (they're always visible)
  for (const ev of events) {
    if (ev.ms === 0) ev.ms = minMs === Infinity ? 0 : minMs;
  }

  events.sort((a, b) => a.ms - b.ms);

  replay.sortedEvents = events;
  replay.startMs = minMs === Infinity ? 0 : minMs;
  replay.endMs = maxMs <= 0 ? 0 : maxMs;
  replay.durationMs = Math.max(1, replay.endMs - replay.startMs);

  // Update total time display
  document.getElementById('tlTotal').textContent = formatTime(Math.floor(replay.durationMs / 1000));
  document.getElementById('tlEventCount').textContent = events.length + ' events';
}

function applyReplayCursor() {
  if (!replay.active) return;

  const cursorAbsMs = replay.startMs + replay.cursorMs;
  replay.visibleIds.clear();

  for (const ev of replay.sortedEvents) {
    if (ev.ms <= cursorAbsMs) {
      replay.visibleIds.add(ev.id);
    }
  }

  // Always include orchestrator
  for (const n of allNodes) {
    if (n.type === 'orchestrator') replay.visibleIds.add(n.id);
  }

  // Filter nodes and edges
  nodes = allNodes.filter(n => replay.visibleIds.has(n.id));
  edges = allEdges.filter(e => replay.visibleIds.has(e.from) && replay.visibleIds.has(e.to));

  // Update time display
  document.getElementById('tlTime').textContent = formatTime(Math.floor(replay.cursorMs / 1000));

  // Update scrubber position
  const pct = replay.durationMs > 0 ? (replay.cursorMs / replay.durationMs) * 100 : 0;
  document.getElementById('tlProgress').style.width = pct + '%';
  document.getElementById('tlHandle').style.left = pct + '%';

  // Dim dots past cursor
  const dots = document.querySelectorAll('.tl-dot');
  dots.forEach(dot => {
    const dotMs = parseFloat(dot.dataset.ms || '0');
    dot.classList.toggle('dimmed', dotMs > cursorAbsMs);
  });

  // Update visible event count
  document.getElementById('tlEventCount').textContent = nodes.length + ' / ' + allNodes.length + ' events';
}

function advanceReplay(dtMs) {
  if (!replay.active || !replay.playing) return;

  const speed = SPEEDS[replay.speedIdx];
  replay.cursorMs += dtMs * speed;

  if (replay.cursorMs >= replay.durationMs) {
    replay.cursorMs = replay.durationMs;
    replay.playing = false;
    document.getElementById('btnPlayPause').textContent = '▶';
  }

  applyReplayCursor();
}

function togglePlayPause() {
  if (!replay.active) {
    // Enter replay mode and start playing
    enterReplay();
    replay.playing = true;
    document.getElementById('btnPlayPause').textContent = '⏸';
    return;
  }

  replay.playing = !replay.playing;
  document.getElementById('btnPlayPause').textContent = replay.playing ? '⏸' : '▶';
  if (replay.playing && replay.cursorMs >= replay.durationMs) {
    replay.cursorMs = 0;  // restart from beginning
    applyReplayCursor();
  }
}

function cycleSpeed() {
  replay.speedIdx = (replay.speedIdx + 1) % SPEEDS.length;
  document.getElementById('btnSpeed').textContent = SPEEDS[replay.speedIdx] + 'x';
}

function toggleLiveMode() {
  if (isLiveMode) {
    vscode.postMessage({ command: 'stopLive' });
    isLiveMode = false;
    document.getElementById('livePill').style.display = 'none';
    document.getElementById('livePill').classList.remove('live');
  } else {
    if (currentFilePath) {
      vscode.postMessage({ command: 'startLive', filePath: currentFilePath });
      isLiveMode = true;
      document.getElementById('livePill').style.display = 'inline';
      document.getElementById('livePill').classList.add('live');
    } else {
      vscode.postMessage({ command: 'autoDetect' });
      return;
    }
  }
  updateLiveButton();
}

function updateLiveButton() {
  const btn = document.getElementById('btnLive');
  if (isLiveMode) {
    btn.textContent = '■ Stop';
    btn.classList.add('live-active');
  } else {
    btn.textContent = '● Live';
    btn.classList.remove('live-active');
  }
}

function toggleReplayMode() {
  if (replay.active) {
    exitReplay();
  } else {
    enterReplay();
  }
}

function enterReplay() {
  replay.active = true;
  replay.cursorMs = 0;
  replay.playing = false;
  replay.lastFrameTime = performance.now();

  document.getElementById('replayPill').style.display = 'inline';
  document.getElementById('replayPill').classList.add('replay');
  document.getElementById('btnReview').textContent = '■ Exit';
  document.getElementById('btnReview').classList.remove('review');
  document.getElementById('btnReview').classList.add('live-exit');
  document.getElementById('btnPlayPause').textContent = '▶';
  document.getElementById('tlTime').classList.add('replay-active');
  document.getElementById('tlHandle').classList.add('replay-active');

  applyReplayCursor();

  // Re-settle physics for the reduced node set
  physicsActive = true;
  settledFrames = 0;
}

function exitReplay() {
  replay.active = false;
  replay.playing = false;
  nodes = allNodes;
  edges = allEdges;

  document.getElementById('replayPill').style.display = 'none';
  document.getElementById('btnReview').textContent = '▶ Review';
  document.getElementById('btnReview').classList.add('review');
  document.getElementById('btnReview').classList.remove('live-exit');
  document.getElementById('btnPlayPause').textContent = '⏸';
  document.getElementById('tlTime').classList.remove('replay-active');
  document.getElementById('tlHandle').classList.remove('replay-active');

  // Show full progress
  document.getElementById('tlProgress').style.width = '100%';
  document.getElementById('tlHandle').style.left = '100%';
  document.getElementById('tlTime').textContent = formatTime(Math.floor(replay.durationMs / 1000));
  document.getElementById('tlEventCount').textContent = allNodes.length + ' events';

  // Un-dim all dots
  document.querySelectorAll('.tl-dot').forEach(d => d.classList.remove('dimmed'));

  physicsActive = true;
  settledFrames = 0;
}

// ── Scrubber interaction ──────────────────────────────────
function onScrubDown(e) {
  scrubDragging = true;
  if (!replay.active) enterReplay();
  seekToScreenX(e);
}

function onScrubMove(e) {
  if (!scrubDragging) return;
  seekToScreenX(e);
}

function onScrubUp() {
  scrubDragging = false;
}

function seekToScreenX(e) {
  const scrubber = document.getElementById('tlScrubber');
  const rect = scrubber.getBoundingClientRect();
  let pct = (e.clientX - rect.left) / rect.width;
  pct = Math.max(0, Math.min(1, pct));
  replay.cursorMs = pct * replay.durationMs;
  applyReplayCursor();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LAYOUT
// ═══════════════════════════════════════════════════════════════════════════════
function initialLayout(rawNodes, rawEdges) {
  if (rawNodes.length === 0) return [];
  const nodeMap = {};
  const childrenOf = {};
  for (const n of rawNodes) {
    nodeMap[n.id] = n;
    if (n.parentId) {
      if (!childrenOf[n.parentId]) childrenOf[n.parentId] = [];
      childrenOf[n.parentId].push(n.id);
    }
  }
  const orch = rawNodes.find(n => n.type === 'orchestrator');
  const cx = canvas ? canvas.width / 2 / (zoom || 1) : 500;
  const cy = canvas ? canvas.height / 2 / (zoom || 1) : 400;
  const positioned = [];
  const placed = new Set();
  function placeNode(id, x, y) {
    if (placed.has(id)) return;
    placed.add(id);
    const node = nodeMap[id];
    if (!node) return;
    positioned.push({ ...node, x, y, radius: getNodeRadius(node), vx: 0, vy: 0, pinned: false });
  }

  // Identify "thread" children (thinking/assistant) vs "branch" children (agent/tool/user)
  function isThreadNode(id) {
    const n = nodeMap[id];
    return n && (n.type === 'thinking' || n.type === 'assistant');
  }

  // Layout branches (agents, tools) radially around their parent
  function layoutBranches(parentId, parentX, parentY, branchIds, baseAngle, depth) {
    if (branchIds.length === 0) return;
    const arcSpan = Math.min(Math.PI * 0.8, branchIds.length * 0.5);
    const startAngle = baseAngle - arcSpan / 2;
    const ringR = 130 + depth * 60;
    for (let i = 0; i < branchIds.length; i++) {
      const angle = startAngle + (branchIds.length > 1 ? (i / (branchIds.length - 1)) * arcSpan : 0);
      const bx = parentX + Math.cos(angle) * ringR;
      const by = parentY + Math.sin(angle) * ringR;
      placeNode(branchIds[i], bx, by);
      // Layout sub-branches (tool children of agents)
      const subChildren = childrenOf[branchIds[i]] || [];
      if (subChildren.length > 0) {
        layoutBranches(branchIds[i], bx, by, subChildren, angle, depth + 1);
      }
    }
  }

  if (orch) {
    placeNode(orch.id, cx, cy);

    // Walk the main thread downward from orchestrator
    let threadX = cx;
    let threadY = cy;
    const threadStep = 100; // vertical spacing between thread nodes
    let currentParent = orch.id;
    let branchSide = 1; // alternates left/right for branches

    while (true) {
      const children = childrenOf[currentParent] || [];
      if (children.length === 0) break;

      // Separate thread continuation from branches
      const threadChild = children.find(id => isThreadNode(id));
      const userChildren = children.filter(id => nodeMap[id]?.type === 'user');
      const branchChildren = children.filter(id => id !== threadChild && !userChildren.includes(id));

      // Place user nodes above/to the left of orchestrator
      if (userChildren.length > 0) {
        const ux = threadX - 150 - userChildren.length * 30;
        for (let i = 0; i < userChildren.length; i++) {
          placeNode(userChildren[i], ux + i * 60, threadY - 40 + i * 30);
        }
      }

      // Place branch children (agents, tools) to alternating sides
      if (branchChildren.length > 0) {
        const branchAngle = branchSide > 0 ? -Math.PI / 4 : -Math.PI * 3 / 4;
        layoutBranches(currentParent, threadX, threadY, branchChildren, branchAngle, 1);
        branchSide *= -1;
      }

      // Advance thread downward
      if (threadChild) {
        threadY += threadStep;
        // Slight horizontal offset to avoid perfect vertical line
        threadX += (Math.random() - 0.5) * 30;
        placeNode(threadChild, threadX, threadY);
        currentParent = threadChild;
      } else {
        break;
      }
    }
  }

  // Place any remaining unplaced nodes
  for (const n of rawNodes) {
    if (!placed.has(n.id)) placeNode(n.id, cx + (Math.random() - 0.5) * 500, cy + (Math.random() - 0.5) * 400);
  }
  return positioned;
}

function getNodeRadius(node) {
  switch (node.type) { case 'orchestrator': return 38; case 'agent': return 26; case 'user': return 18; case 'thinking': return 10; case 'tool': return 13; default: return 13; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHYSICS
// ═══════════════════════════════════════════════════════════════════════════════
function applyPhysics() {
  if (!physicsActive || nodes.length < 2) return;
  const centerX = nodes.reduce((s, n) => s + n.x, 0) / nodes.length;
  const centerY = nodes.reduce((s, n) => s + n.y, 0) / nodes.length;
  const nodeById = {};
  for (const n of nodes) nodeById[n.id] = n;
  let totalEnergy = 0;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (a.pinned) continue;
    let fx = 0, fy = 0;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = 1; }
      const sizeScale = (a.radius + b.radius) / 30;
      const force = PHYSICS.repulsion * sizeScale / (dist * dist);
      fx += (dx / dist) * force; fy += (dy / dist) * force;
    }
    for (const edge of edges) {
      let other = null;
      if (edge.from === a.id) other = nodeById[edge.to];
      else if (edge.to === a.id) other = nodeById[edge.from];
      if (!other) continue;
      const dx = other.x - a.x, dy = other.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;
      let targetLen = PHYSICS.edgeLength;
      // Thread nodes (thinking/assistant) pull closer — tight chain
      const isThreadEdge = (a.type === 'thinking' || a.type === 'assistant') || (other.type === 'thinking' || other.type === 'assistant');
      if (a.type === 'orchestrator' || other.type === 'orchestrator') targetLen = 180;
      else if (isThreadEdge) targetLen = 90;
      else if (a.type === 'agent' || other.type === 'agent') targetLen = 150;
      const force = PHYSICS.attraction * (dist - targetLen);
      fx += (dx / dist) * force; fy += (dy / dist) * force;
    }
    fx += (centerX - a.x) * PHYSICS.centerGravity;
    fy += (centerY - a.y) * PHYSICS.centerGravity;
    a.vx = (a.vx + fx) * PHYSICS.damping;
    a.vy = (a.vy + fy) * PHYSICS.damping;
    const speed = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
    if (speed > PHYSICS.maxVelocity) { a.vx = (a.vx / speed) * PHYSICS.maxVelocity; a.vy = (a.vy / speed) * PHYSICS.maxVelocity; }
    totalEnergy += speed;
  }
  for (const n of nodes) { if (!n.pinned) { n.x += n.vx; n.y += n.vy; } }
  if (totalEnergy / nodes.length < PHYSICS.minVelocity) { settledFrames++; if (settledFrames > 60) physicsActive = false; }
  else settledFrames = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PARTICLES
// ═══════════════════════════════════════════════════════════════════════════════
function spawnParticles() {
  if (time % 3 !== 0 || edges.length === 0) return;
  const edge = edges[Math.floor(Math.random() * edges.length)];
  particles.push({ fromId: edge.from, toId: edge.to, t: 0, speed: 0.008 + Math.random() * 0.008, alpha: 0.6 + Math.random() * 0.4, size: 1.5 + Math.random() * 1.5 });
}
function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) { particles[i].t += particles[i].speed; if (particles[i].t >= 1) particles.splice(i, 1); }
}
function drawParticles() {
  const byId = {}; for (const n of nodes) byId[n.id] = n;
  for (const p of particles) {
    const from = byId[p.fromId], to = byId[p.toId];
    if (!from || !to) continue;
    const x = from.x + (to.x - from.x) * p.t, y = from.y + (to.y - from.y) * p.t;
    ctx.shadowColor = nodeColor(to, 0.6); ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(x, y, p.size, 0, Math.PI * 2); ctx.fillStyle = nodeColor(to, p.alpha); ctx.fill();
    const tl = 0.04;
    const tx = from.x + (to.x - from.x) * Math.max(0, p.t - tl), ty = from.y + (to.y - from.y) * Math.max(0, p.t - tl);
    ctx.shadowBlur = 0; ctx.strokeStyle = nodeColor(to, p.alpha * 0.3); ctx.lineWidth = p.size * 0.6;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RENDERING
// ═══════════════════════════════════════════════════════════════════════════════
function renderLoop(now) {
  const dt = now - replay.lastFrameTime;
  replay.lastFrameTime = now;
  time++;

  advanceReplay(dt);
  applyPhysics();
  spawnParticles();
  updateParticles();
  render();
  requestAnimationFrame(renderLoop);
}

function render() {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, w, h);
  drawStarField();
  ctx.save(); ctx.translate(cameraX, cameraY); ctx.scale(zoom, zoom);
  for (const edge of edges) {
    const from = nodes.find(n => n.id === edge.from), to = nodes.find(n => n.id === edge.to);
    if (from && to) drawEdge(from, to);
  }
  drawParticles();

  // During replay, compute "just appeared" time for entrance animation
  const cursorAbsMs = replay.active ? replay.startMs + replay.cursorMs : 0;
  for (const node of nodes) {
    let entranceScale = 1;
    if (replay.active && node.timestamp) {
      const nodeMs = new Date(node.timestamp).getTime();
      const age = cursorAbsMs - nodeMs;
      if (age >= 0 && age < 600) {
        entranceScale = 0.3 + 0.7 * Math.min(1, age / 600);  // scale up over 600ms
      }
    }
    drawNode(node, node === hoveredNode, entranceScale);
  }
  // Draw text bubbles on top of nodes
  for (const node of nodes) {
    if (node.type === 'user' || node.type === 'thinking' || node.type === 'assistant') {
      let entranceScale = 1;
      if (replay.active && node.timestamp) {
        const nodeMs = new Date(node.timestamp).getTime();
        const age = cursorAbsMs - nodeMs;
        if (age >= 0 && age < 600) entranceScale = 0.3 + 0.7 * Math.min(1, age / 600);
      }
      if (entranceScale > 0.6) drawTextBubble(node);
    }
  }
  ctx.restore();
}

function drawStarField() {
  for (const star of starField) {
    const flicker = 0.85 + 0.15 * Math.sin(time * 0.02 + star.x * 0.1);
    const sx = ((star.x + cameraX * star.parallax * 0.03) % canvas.width + canvas.width) % canvas.width;
    const sy = ((star.y + cameraY * star.parallax * 0.03) % canvas.height + canvas.height) % canvas.height;
    ctx.fillStyle = 'rgba(255,255,255,' + (star.brightness * flicker) + ')';
    ctx.beginPath(); ctx.arc(sx, sy, star.size, 0, Math.PI * 2); ctx.fill();
  }
}

function drawEdge(from, to) {
  const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
  grad.addColorStop(0, nodeColor(from, 0.5)); grad.addColorStop(1, nodeColor(to, 0.5));
  // Neon glow layer
  ctx.save();
  ctx.shadowColor = nodeColor(to, 0.6);
  ctx.shadowBlur = 12;
  ctx.strokeStyle = grad; ctx.lineWidth = 1.8; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  // Bright core line
  ctx.shadowBlur = 0;
  const coreGrad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
  coreGrad.addColorStop(0, nodeColor(from, 0.15)); coreGrad.addColorStop(1, nodeColor(to, 0.15));
  ctx.strokeStyle = coreGrad; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawNode(node, isHovered, scale) {
  const x = node.x, y = node.y;
  const r = node.radius * scale;
  const color = nodeColor(node, 1);
  const pulse = node.type === 'orchestrator' ? (0.8 + 0.2 * Math.sin(time * 0.04)) : 1;

  if (node.type === 'orchestrator') {
    // Strong cyan aura — multiple layered glows
    ctx.save();
    const auraR = r * 2.2;
    const auraGrad = ctx.createRadialGradient(x, y, r * 0.5, x, y, auraR);
    auraGrad.addColorStop(0, 'rgba(6,182,212,0.18)');
    auraGrad.addColorStop(0.5, 'rgba(6,182,212,0.08)');
    auraGrad.addColorStop(1, 'rgba(6,182,212,0)');
    ctx.fillStyle = auraGrad;
    ctx.beginPath(); ctx.arc(x, y, auraR, 0, Math.PI * 2); ctx.fill();
    // Second pulse layer
    const pulseAura = 0.12 + 0.06 * Math.sin(time * 0.03);
    const auraGrad2 = ctx.createRadialGradient(x, y, r, x, y, auraR * 1.3);
    auraGrad2.addColorStop(0, 'rgba(6,182,212,' + pulseAura + ')');
    auraGrad2.addColorStop(1, 'rgba(6,182,212,0)');
    ctx.fillStyle = auraGrad2;
    ctx.beginPath(); ctx.arc(x, y, auraR * 1.3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.shadowColor = 'rgba(6,182,212,0.5)'; ctx.shadowBlur = isHovered ? 50 : 30;
    drawHexagon(x, y, r * pulse, color, isHovered);

    // Spinning asterisk/star icon
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.translate(x, y);
    ctx.rotate(time * 0.02);
    ctx.fillStyle = color;
    const starR = r * 0.35;
    const spokes = 6;
    ctx.beginPath();
    for (let i = 0; i < spokes; i++) {
      const a = (Math.PI * 2 / spokes) * i;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * starR, Math.sin(a) * starR);
    }
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    // Center dot
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();

    // Token usage progress bar below orchestrator
    if (sessionData) {
      ctx.save();
      ctx.shadowBlur = 0;
      const barW = r * 2.4, barH = 5;
      const barX = x - barW / 2, barY = y + r + 18;
      const totalTokens = sessionData.totalTokens || 0;
      const maxTokens = 1000000;
      const pct = Math.min(1, totalTokens / maxTokens);
      // Bar background
      ctx.fillStyle = 'rgba(30,40,60,0.8)';
      ctx.beginPath();
      ctx.roundRect(barX, barY, barW, barH, 2.5);
      ctx.fill();
      // Bar fill with glow
      if (pct > 0) {
        ctx.shadowColor = 'rgba(6,182,212,0.6)'; ctx.shadowBlur = 6;
        const fillGrad = ctx.createLinearGradient(barX, barY, barX + barW * pct, barY);
        fillGrad.addColorStop(0, 'rgba(6,182,212,0.9)');
        fillGrad.addColorStop(1, 'rgba(59,130,246,0.9)');
        ctx.fillStyle = fillGrad;
        ctx.beginPath();
        ctx.roundRect(barX, barY, barW * pct, barH, 2.5);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      // Token label
      const tokenLabel = formatTokens(totalTokens) + ' / 1000k';
      ctx.font = '9px "Segoe UI",system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(148,163,184,0.8)';
      ctx.fillText(tokenLabel, x, barY + barH + 3);
      ctx.restore();
    }
  } else if (node.type === 'agent') {
    ctx.shadowColor = nodeColor(node, 0.45); ctx.shadowBlur = isHovered ? 35 : 20;
    drawHexagon(x, y, r * pulse, color, isHovered);
  } else if (node.type === 'thinking') {
    // Small gray dot for thinking nodes
    ctx.shadowColor = nodeColor(node, 0.3); ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? color : 'rgba(10,14,26,0.8)'; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
  } else {
    ctx.shadowColor = nodeColor(node, 0.35); ctx.shadowBlur = (isHovered ? 35 : 16) * pulse;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? color : 'rgba(10,14,26,0.8)'; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = isHovered ? 2.5 : 1.2; ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // Draw label below node (skip for types that get text bubbles and orchestrator)
  const hasBubble = node.type === 'user' || node.type === 'thinking' || node.type === 'assistant';
  if (scale > 0.5 && node.type !== 'orchestrator' && !hasBubble) {
    ctx.font = '11px "Segoe UI",system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = isHovered ? '#fff' : 'rgba(226,232,240,0.8)';
    ctx.fillText(truncText(ctx, node.label || node.type, 150), x, y + r + 5);
  }
  // Orchestrator label below token bar
  if (scale > 0.5 && node.type === 'orchestrator') {
    ctx.font = '12px "Segoe UI",system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = isHovered ? '#fff' : 'rgba(226,232,240,0.8)';
    ctx.fillText('orchestrator', x, y + r + 34);
  }
}

function drawHexagon(x, y, r, color, isHovered) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) { const a = (Math.PI/3)*i - Math.PI/6; const hx = x+r*Math.cos(a), hy = y+r*Math.sin(a); i===0?ctx.moveTo(hx,hy):ctx.lineTo(hx,hy); }
  ctx.closePath(); ctx.fillStyle = 'rgba(10,14,26,0.75)'; ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = isHovered ? 3 : 2; ctx.setLineDash([6,3]); ctx.stroke(); ctx.setLineDash([]);
}

function drawTextBubble(node) {
  if (node.type !== 'user' && node.type !== 'thinking' && node.type !== 'assistant') return;
  const text = node.label || '';
  if (!text || text.length < 2) return;

  const x = node.x, y = node.y, r = node.radius;
  ctx.save();
  ctx.shadowBlur = 0;

  // Bubble config by type
  let bgColor, borderColor, textColor, headerText, headerColor, glowColor;
  if (node.type === 'user') {
    bgColor = 'rgba(245,158,11,0.08)';
    borderColor = 'rgba(245,158,11,0.35)';
    textColor = 'rgba(226,232,240,0.9)';
    headerText = 'USER';
    headerColor = 'rgba(245,158,11,1)';
    glowColor = 'rgba(245,158,11,0.15)';
  } else if (node.type === 'thinking') {
    bgColor = 'rgba(100,116,139,0.08)';
    borderColor = 'rgba(148,163,184,0.25)';
    textColor = 'rgba(148,163,184,0.8)';
    headerText = 'THINKING';
    headerColor = 'rgba(148,163,184,0.9)';
    glowColor = 'rgba(148,163,184,0.08)';
  } else {
    bgColor = 'rgba(6,182,212,0.08)';
    borderColor = 'rgba(6,182,212,0.3)';
    textColor = 'rgba(226,232,240,0.9)';
    headerText = 'CLAUDE';
    headerColor = 'rgba(6,182,212,1)';
    glowColor = 'rgba(6,182,212,0.12)';
  }

  // Position bubble to the right of the node
  const bubbleX = x + r + 16;
  const bubbleY = y - 18;
  const maxW = 220;
  const padding = 10;

  // Measure & wrap text
  ctx.font = '11px "Segoe UI",system-ui,sans-serif';
  const displayText = text.length > 120 ? text.slice(0, 117) + '...' : text;
  const words = displayText.split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    if (ctx.measureText(testLine).width > maxW - padding * 2) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  if (lines.length > 4) { lines.length = 4; lines[3] = lines[3].slice(0, -3) + '...'; }

  const lineH = 15;
  const headerH = 18;
  const bubbleH = headerH + lines.length * lineH + padding * 2;
  const bubbleW = maxW;

  // Subtle glow behind bubble
  ctx.shadowColor = glowColor; ctx.shadowBlur = 20;
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 8);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 8);
  ctx.stroke();

  // Left accent bar
  ctx.fillStyle = headerColor;
  ctx.beginPath();
  ctx.roundRect(bubbleX, bubbleY, 3, bubbleH, [8, 0, 0, 8]);
  ctx.fill();

  // Connecting line from node to bubble
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 0.8;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x + r + 2, y);
  ctx.lineTo(bubbleX, bubbleY + bubbleH / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Header
  ctx.font = 'bold 9px "Segoe UI",system-ui,sans-serif';
  ctx.fillStyle = headerColor;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(headerText, bubbleX + padding + 4, bubbleY + padding);

  // Body text
  ctx.font = '11px "Segoe UI",system-ui,sans-serif';
  ctx.fillStyle = textColor;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], bubbleX + padding + 4, bubbleY + padding + headerH + i * lineH);
  }

  ctx.restore();
}

function nodeColor(node, alpha) {
  switch (node.type) {
    case 'orchestrator': return 'rgba(245,158,11,'+alpha+')';
    case 'agent': return 'rgba(59,130,246,'+alpha+')';
    case 'user': return 'rgba(16,185,129,'+alpha+')';
    case 'tool': return 'rgba(6,182,212,'+alpha+')';
    case 'thinking': return 'rgba(148,163,184,'+alpha+')';
    default: return 'rgba(226,232,240,'+alpha+')';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INTERACTION
// ═══════════════════════════════════════════════════════════════════════════════
function hitTest(mx, my) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i], dx = mx - n.x, dy = my - n.y;
    if (dx*dx + dy*dy < (n.radius+6)*(n.radius+6)) return n;
  }
  return null;
}
function screenToWorld(sx, sy) { return { x: (sx - cameraX) / zoom, y: (sy - cameraY) / zoom }; }
function onMouseDown(e) {
  const w = screenToWorld(e.offsetX, e.offsetY); const hit = hitTest(w.x, w.y);
  if (hit) { draggedNode = hit; hit.pinned = true; physicsActive = true; settledFrames = 0; }
  else { isDragging = true; dragStartX = e.clientX - cameraX; dragStartY = e.clientY - cameraY; }
}
function onMouseMove(e) {
  if (draggedNode) { const w = screenToWorld(e.offsetX, e.offsetY); draggedNode.x = w.x; draggedNode.y = w.y; draggedNode.vx = 0; draggedNode.vy = 0; return; }
  if (isDragging) { cameraX = e.clientX - dragStartX; cameraY = e.clientY - dragStartY; return; }
  const w = screenToWorld(e.offsetX, e.offsetY); const hit = hitTest(w.x, w.y);
  hoveredNode = hit; canvas.style.cursor = hit ? 'pointer' : 'grab';
  const tt = document.getElementById('nodeTooltip');
  if (hit) {
    tt.innerHTML = '<div class="tt-title">'+esc(hit.type.toUpperCase()+': '+hit.label)+'</div><div class="tt-body">'+esc(hit.detail||'')+'</div>';
    tt.style.left = (e.offsetX+15)+'px'; tt.style.top = (e.offsetY+15)+'px'; tt.classList.add('visible');
  } else { tt.classList.remove('visible'); }
}
function onMouseUp() { if (draggedNode) { draggedNode.pinned = false; draggedNode = null; } isDragging = false; }
function onWheel(e) {
  e.preventDefault(); const d = e.deltaY > 0 ? 0.92 : 1.08; const oz = zoom;
  zoom = Math.max(0.08, Math.min(6, zoom * d));
  cameraX = e.offsetX - (e.offsetX - cameraX) * (zoom / oz); cameraY = e.offsetY - (e.offsetY - cameraY) * (zoom / oz);
}
function onDoubleClick(e) {
  if (!hoveredNode) return;
  const tt = document.getElementById('nodeTooltip');
  tt.innerHTML = '<div class="tt-title">'+esc(hoveredNode.type.toUpperCase()+': '+(hoveredNode.toolName||hoveredNode.label))+'</div><div class="tt-body">'+esc(hoveredNode.detail||'No detail')+'</div>';
  tt.style.left = (e.offsetX+15)+'px'; tt.style.top = (e.offsetY+15)+'px'; tt.classList.add('visible');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS
// ═══════════════════════════════════════════════════════════════════════════════
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-view="'+view+'"]').classList.add('active');
  const panel = document.getElementById('sidePanel');
  if (view === 'chat') { panel.classList.add('visible'); buildChatView(); }
  else if (view === 'files') { panel.classList.add('visible'); buildFilesView(); }
  else if (view === 'cost') { panel.classList.add('visible'); buildCostView(); }
  else if (view === 'timeline') { panel.classList.add('visible'); buildTimelineView(); }
  else { panel.classList.remove('visible'); }
}

function buildChatView() {
  if (!sessionData) return;
  const panel = document.getElementById('sidePanel');
  const oldBody = document.getElementById('chatBody');
  const wasAtBottom = oldBody ? (oldBody.scrollTop + oldBody.clientHeight >= oldBody.scrollHeight - 20) : true;
  const prevScroll = oldBody ? oldBody.scrollTop : 0;
  panel.innerHTML = '<div class="side-header"><span>TRANSCRIPT</span><span style="color:var(--text-dim)">'+sessionData.nodes.length+' events</span></div><div class="side-body" id="chatBody"></div>';
  const body = document.getElementById('chatBody');
  for (const node of sessionData.nodes) {
    if (node.type === 'orchestrator') continue;
    const div = document.createElement('div');
    div.className = 'chat-entry ' + node.type;
    const rc = node.type === 'user' ? 'user' : (node.type === 'tool' ? 'tool' : 'assistant');
    div.innerHTML = '<div class="role '+rc+'">'+esc(node.toolName||node.type)+'</div><div>'+esc(trunc(node.detail||node.label,500))+'</div>';
    body.appendChild(div);
  }
  if (wasAtBottom) {
    body.scrollTop = body.scrollHeight;
  } else {
    body.scrollTop = prevScroll;
  }
}

function buildFilesView() {
  if (!sessionData || !sessionData.touchedFiles) return;
  const panel = document.getElementById('sidePanel');
  const files = sessionData.touchedFiles;
  const dirMap = {};
  for (const f of files) {
    const parts = f.filePath.split('/'); const fn = parts.pop() || f.filePath; const dir = parts.join('/') || '.';
    if (!dirMap[dir]) dirMap[dir] = [];
    dirMap[dir].push({ ...f, fileName: fn });
  }
  let html = '<div class="side-header"><span>FILES TOUCHED</span><span style="color:var(--text-dim)">'+files.length+' ops</span></div><div class="side-body">';
  for (const dir of Object.keys(dirMap).sort()) {
    const items = dirMap[dir]; const uf = new Set(items.map(i => i.fileName));
    html += '<div class="file-group"><div class="file-group-header"><span>'+esc(dir)+'</span><span class="file-group-count">'+uf.size+' files</span></div>';
    const seen = new Set();
    for (const item of items) {
      const key = item.fileName+'|'+item.action+'|'+item.agentLabel;
      if (seen.has(key)) continue; seen.add(key);
      html += '<div class="file-item"><span class="file-action '+item.action+'">'+item.action.toUpperCase()+'</span>';
      html += '<span class="file-path" title="'+esc(item.filePath)+'">'+esc(item.fileName)+'</span>';
      html += '<span class="file-agent" title="'+esc(item.agentLabel)+'">'+esc(item.agentLabel.length > 18 ? item.agentLabel.slice(0,15)+'...' : item.agentLabel)+'</span></div>';
    }
    html += '</div>';
  }
  html += '</div>'; panel.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COST VIEW
// ═══════════════════════════════════════════════════════════════════════════════
function buildCostView() {
  if (!sessionData) return;
  const panel = document.getElementById('sidePanel');
  const data = sessionData;

  // Aggregate tool usage counts
  const toolCounts = {};
  const agentToolCounts = {};
  for (const n of data.nodes) {
    if (n.type === 'tool' && n.toolName) {
      toolCounts[n.toolName] = (toolCounts[n.toolName] || 0) + 1;
      // Find parent agent
      const parentNode = data.nodes.find(p => p.id === n.parentId);
      const agentLabel = parentNode ? (parentNode.label || parentNode.type) : 'orchestrator';
      if (!agentToolCounts[agentLabel]) agentToolCounts[agentLabel] = { calls: 0, tools: {} };
      agentToolCounts[agentLabel].calls++;
      agentToolCounts[agentLabel].tools[n.toolName] = (agentToolCounts[agentLabel].tools[n.toolName] || 0) + 1;
    }
  }

  let html = '<div class="side-header"><span>COST BREAKDOWN</span><span style="color:var(--text-dim)">$' + data.totalCost.toFixed(2) + ' total</span></div><div class="side-body">';

  // Summary bar
  html += '<div style="margin-bottom:16px;padding:12px;background:var(--bg-card);border-radius:8px;border:1px solid var(--border)">';
  html += '<div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:var(--accent);font-weight:600;font-size:13px">Total Cost</span><span style="color:var(--accent);font-family:var(--mono);font-size:16px;font-weight:700">$' + data.totalCost.toFixed(4) + '</span></div>';
  html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim)"><span>Tokens</span><span style="font-family:var(--mono)">' + formatTokens(data.totalTokens) + '</span></div>';
  html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-top:4px"><span>Agents</span><span style="font-family:var(--mono)">' + data.agentCount + '</span></div>';
  html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-top:4px"><span>Tool Calls</span><span style="font-family:var(--mono)">' + Object.values(toolCounts).reduce((a,b) => a+b, 0) + '</span></div>';
  html += '</div>';

  // Tool usage breakdown
  html += '<div style="margin-bottom:14px"><div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border)">TOOL USAGE</div>';
  const sortedTools = Object.entries(toolCounts).sort((a,b) => b[1] - a[1]);
  const maxCount = sortedTools.length > 0 ? sortedTools[0][1] : 1;
  for (const [tool, count] of sortedTools) {
    const pct = Math.round((count / maxCount) * 100);
    html += '<div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px"><span style="font-family:var(--mono);color:var(--text)">' + esc(tool) + '</span><span style="color:var(--text-dim)">' + count + '</span></div>';
    html += '<div style="height:4px;background:var(--bg-deep);border-radius:2px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:var(--tool-cyan);border-radius:2px"></div></div></div>';
  }
  html += '</div>';

  // Per-agent breakdown
  html += '<div><div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border)">BY AGENT</div>';
  const sortedAgents = Object.entries(agentToolCounts).sort((a,b) => b[1].calls - a[1].calls);
  for (const [agent, info] of sortedAgents) {
    html += '<div style="margin-bottom:10px;padding:8px;background:var(--bg-card);border-radius:6px;border:1px solid var(--border)">';
    html += '<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-size:11px;font-weight:600;color:var(--agent-blue);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(agent) + '</span><span style="font-size:10px;color:var(--text-dim);font-family:var(--mono)">' + info.calls + ' calls</span></div>';
    const toolList = Object.entries(info.tools).sort((a,b) => b[1] - a[1]);
    for (const [t, c] of toolList) {
      html += '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim);margin-left:8px"><span style="font-family:var(--mono)">' + esc(t) + '</span><span>' + c + '</span></div>';
    }
    html += '</div>';
  }
  html += '</div></div>';
  panel.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TIMELINE VIEW
// ═══════════════════════════════════════════════════════════════════════════════
function buildTimelineView() {
  if (!sessionData) return;
  const panel = document.getElementById('sidePanel');
  const data = sessionData;

  // Sort nodes by timestamp
  const events = data.nodes
    .filter(n => n.type !== 'orchestrator' && n.timestamp)
    .map(n => ({ ...n, ms: new Date(n.timestamp).getTime() }))
    .filter(n => !isNaN(n.ms))
    .sort((a, b) => a.ms - b.ms);

  const startMs = events.length > 0 ? events[0].ms : 0;

  let html = '<div class="side-header"><span>TIMELINE</span><span style="color:var(--text-dim)">' + events.length + ' events</span></div><div class="side-body">';

  let lastAgentId = null;
  for (const ev of events) {
    const relSec = Math.floor((ev.ms - startMs) / 1000);
    const timeStr = formatTime(relSec);
    const typeColors = { user: 'var(--user-green)', tool: 'var(--tool-cyan)', agent: 'var(--accent)', assistant: 'var(--agent-blue)' };
    const color = typeColors[ev.type] || 'var(--text-dim)';

    // Show agent header when parent changes
    if (ev.parentId && ev.parentId !== lastAgentId) {
      lastAgentId = ev.parentId;
      const parentNode = data.nodes.find(p => p.id === ev.parentId);
      if (parentNode && parentNode.type === 'agent') {
        html += '<div style="margin:10px 0 4px 0;padding:4px 8px;background:rgba(59,130,246,0.08);border-radius:4px;font-size:10px;color:var(--agent-blue);font-weight:600;border-left:3px solid var(--agent-blue)">▶ ' + esc(parentNode.label || 'Agent') + '</div>';
      }
    }

    html += '<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px;padding:4px 0">';
    html += '<span style="font-family:var(--mono);font-size:10px;color:var(--text-dim);min-width:36px;flex-shrink:0;padding-top:2px">' + timeStr + '</span>';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:'+color+';flex-shrink:0;margin-top:4px"></div>';
    html += '<div style="flex:1;min-width:0">';
    html += '<div style="font-size:10px;font-weight:600;color:'+color+';text-transform:uppercase">' + esc(ev.toolName || ev.type) + '</div>';
    html += '<div style="font-size:11px;font-family:var(--mono);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(trunc(ev.label || '', 120)) + '</div>';
    html += '</div></div>';
  }

  if (events.length === 0) {
    html += '<div style="text-align:center;color:var(--text-dim);padding:40px 0;font-size:13px">No timestamped events found</div>';
  }

  html += '</div>';
  const body = panel.querySelector('.side-body');
  const wasAtBottom = body ? (body.scrollTop + body.clientHeight >= body.scrollHeight - 20) : true;
  const prevScroll = body ? body.scrollTop : 0;
  panel.innerHTML = html;
  const newBody = panel.querySelector('.side-body');
  if (newBody) {
    if (wasAtBottom) {
      newBody.scrollTop = newBody.scrollHeight;
    } else {
      newBody.scrollTop = prevScroll;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TIMELINE DOTS (scrubber bar)
// ═══════════════════════════════════════════════════════════════════════════════
function buildTimelineDots() {
  if (!replay.sortedEvents || replay.sortedEvents.length === 0) return;
  const container = document.getElementById('tlDots');
  container.innerHTML = '';
  const events = replay.sortedEvents;
  for (const ev of events) {
    if (ev.type === 'orchestrator') continue;
    const dot = document.createElement('div');
    dot.className = 'tl-dot ' + ev.type;
    const pct = replay.durationMs > 0 ? ((ev.ms - replay.startMs) / replay.durationMs) * 100 : 0;
    dot.style.left = pct + '%';
    dot.dataset.ms = ev.ms;
    dot.title = ev.type;
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!replay.active) enterReplay();
      replay.cursorMs = ev.ms - replay.startMs;
      applyReplayCursor();
    });
    container.appendChild(dot);
  }
}

function updateTimelineUI() {
  if (!replay.active) {
    document.getElementById('tlProgress').style.width = '100%';
    document.getElementById('tlHandle').style.left = '100%';
    document.getElementById('tlTime').textContent = formatTime(Math.floor(replay.durationMs / 1000));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SESSION PICKER
// ═══════════════════════════════════════════════════════════════════════════════
function showSessionPicker(sessions) {
  if (!sessions || sessions.length === 0) return;
  const el = document.getElementById('sessionTabs'); el.innerHTML = '';
  for (const s of sessions.slice(0, 10)) {
    const tab = document.createElement('div'); tab.className = 'tab'; tab.textContent = s.label;
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); tab.classList.add('active');
      vscode.postMessage({ command: 'loadSession', filePath: s.filePath });
    });
    el.appendChild(tab);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function resizeCanvas() { const a = document.getElementById('mainArea'); canvas.width = a.clientWidth; canvas.height = a.clientHeight; }
function generateStarField() {
  starField = [];
  for (let i = 0; i < 250; i++) starField.push({ x: Math.random()*2000, y: Math.random()*1500, size: Math.random()*1.5+0.2, brightness: Math.random()*0.35+0.08, parallax: Math.random()*3+1 });
}
function formatTokens(n) { if (n>=1e6) return (n/1e6).toFixed(1)+'M'; if (n>=1e3) return (n/1e3).toFixed(0)+'k'; return String(n); }
function formatTime(sec) { const m = Math.floor(sec/60), s = sec%60; return m+':'+String(s).padStart(2,'0'); }
function truncText(ctx, text, maxW) { if (ctx.measureText(text).width <= maxW) return text; let t = text; while (t.length > 3 && ctx.measureText(t+'...').width > maxW) t = t.slice(0,-1); return t+'...'; }
function trunc(s, max) { return s.length > max ? s.slice(0,max-3)+'...' : s; }
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
`;

export function deactivate() { }
