import * as fs from 'fs';
import * as path from 'path';

export interface GraphNode {
  id: string;
  type: 'orchestrator' | 'user' | 'assistant' | 'agent' | 'tool' | 'thinking';
  label: string;
  detail: string;
  timestamp: string;
  tokens?: number;
  cost?: number;
  agentId?: string;
  agentType?: string;
  toolName?: string;
  status?: 'running' | 'complete' | 'error';
  parentId?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface FileTouch {
  filePath: string;
  action: 'read' | 'write' | 'edit' | 'grep' | 'glob';
  agentLabel: string;
  agentId: string;
  timestamp: string;
  toolNodeId: string;
}

export interface ParsedSession {
  sessionId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalTokens: number;
  totalCost: number;
  agentCount: number;
  startTime?: string;
  isLive: boolean;
  touchedFiles: FileTouch[];
}

interface JsonlEntry {
  type: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  summary?: string;
  sessionId?: string;
  gitBranch?: string;
  agentId?: string;
  agentType?: string;
  parentAgentId?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  content?: string;
}

const INPUT_COST_PER_M = 3.0;
const OUTPUT_COST_PER_M = 15.0;

const FILE_ACTION_MAP: Record<string, FileTouch['action']> = {
  'Read': 'read',
  'Write': 'write',
  'Edit': 'edit',
  'MultiEdit': 'edit',
  'Grep': 'grep',
  'Glob': 'glob',
};

function extractFilePath(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return String(input.file_path || input.path || '') || null;
    case 'Grep':
      return String(input.path || input.include || input.pattern || '') || null;
    case 'Glob':
      return String(input.pattern || input.path || '') || null;
    default:
      return null;
  }
}

function processToolBlock(
  block: ContentBlock,
  ts: string,
  parentNodeId: string,
  agentLabel: string,
  agentId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  touchedFiles: FileTouch[],
  nodeCounter: { v: number }
): void {
  if (block.type !== 'tool_use' || !block.name) { return; }

  const toolNodeId = `n_${nodeCounter.v++}`;
  const toolLabel = formatToolLabel(block.name, block.input);
  nodes.push({
    id: toolNodeId,
    type: 'tool',
    label: toolLabel,
    detail: JSON.stringify(block.input || {}, null, 2),
    timestamp: ts,
    toolName: block.name,
    parentId: parentNodeId,
  });
  edges.push({ from: parentNodeId, to: toolNodeId });

  const action = FILE_ACTION_MAP[block.name];
  if (action && block.input) {
    const fp = extractFilePath(block.name, block.input);
    if (fp) {
      touchedFiles.push({ filePath: fp, action, agentLabel, agentId, timestamp: ts, toolNodeId });
    }
  }
}

export function parseJsonlFile(filePath: string): ParsedSession {
  const sessionId = path.basename(filePath, '.jsonl');
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.trim());

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const agentIds = new Set<string>();
  const touchedFiles: FileTouch[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let startTime: string | undefined;
  const nodeCounter = { v: 0 };
  let lastNodeId: string | null = null;

  const orchestratorId = `orch_${sessionId.slice(0, 8)}`;
  nodes.push({
    id: orchestratorId,
    type: 'orchestrator',
    label: 'orchestrator',
    detail: `Session: ${sessionId}`,
    timestamp: '',
    status: 'running'
  });

  for (const line of lines) {
    let entry: JsonlEntry;
    try { entry = JSON.parse(line); } catch { continue; }

    const ts = entry.timestamp || '';
    if (!startTime && ts) { startTime = ts; }
    const nodeId = `n_${nodeCounter.v++}`;

    if (entry.type === 'user') {
      const textContent = extractTextContent(entry.message?.content);
      const truncated = textContent.length > 80 ? textContent.slice(0, 77) + '...' : textContent;
      nodes.push({ id: nodeId, type: 'user', label: truncated, detail: textContent, timestamp: ts });
      edges.push({ from: nodeId, to: orchestratorId });
      lastNodeId = orchestratorId;
    }

    if (entry.type === 'assistant') {
      const contentBlocks = entry.message?.content;
      if (Array.isArray(contentBlocks)) {
        for (const block of contentBlocks) {
          // Tool calls
          if (block.type === 'tool_use' && block.name) {
            // Task/Agent → subagent spawn
            if (block.name === 'Task' || block.name === 'Agent') {
              const input = block.input as Record<string, unknown>;
              const agId = (input?.agentId as string) || block.id || `task_${nodeCounter.v}`;
              const agType = (input?.description as string) || (input?.prompt as string) || 'SubAgent';
              const truncType = agType.length > 40 ? agType.slice(0, 37) + '...' : agType;
              if (!agentIds.has(agId)) {
                agentIds.add(agId);
                nodes.push({
                  id: `agent_${agId}`, type: 'agent', label: truncType, detail: agType,
                  timestamp: ts, agentId: agId, agentType: truncType, status: 'running', parentId: orchestratorId,
                });
                edges.push({ from: orchestratorId, to: `agent_${agId}` });
              }
            } else {
              processToolBlock(block, ts, lastNodeId || orchestratorId, 'orchestrator', orchestratorId,
                nodes, edges, touchedFiles, nodeCounter);
            }
          }

          // Thinking blocks
          if (block.type === 'thinking' && (block.thinking || block.text)) {
            const thinkText = block.thinking || block.text || '';
            const truncated = thinkText.length > 100 ? thinkText.slice(0, 97) + '...' : thinkText;
            const thinkNodeId = `n_${nodeCounter.v++}`;
            nodes.push({
              id: thinkNodeId, type: 'thinking', label: truncated,
              detail: thinkText, timestamp: ts, parentId: lastNodeId || orchestratorId,
            });
            edges.push({ from: lastNodeId || orchestratorId, to: thinkNodeId });
          }

          // Assistant text mentioning agent spawns
          if (block.type === 'text' && block.text) {
            const agentMatch = block.text.match(/launch(?:ed|ing)?\s+(\d+)\s+(?:parallel\s+)?(?:research\s+)?agents?/i);
            if (agentMatch) {
              const blockNodeId = `n_${nodeCounter.v++}`;
              nodes.push({
                id: blockNodeId, type: 'assistant', label: block.text.slice(0, 120),
                detail: block.text, timestamp: ts, parentId: orchestratorId,
              });
              edges.push({ from: orchestratorId, to: blockNodeId });
              lastNodeId = blockNodeId;
            }
          }
        }
      }

      const usage = entry.message?.usage;
      if (usage) {
        totalInputTokens += usage.input_tokens || 0;
        totalOutputTokens += usage.output_tokens || 0;
      }
    }

    // Subagent entries
    if (entry.type === 'agent' || (entry.agentId && entry.type !== 'assistant')) {
      const agId = entry.agentId || `agent_${nodeCounter.v}`;
      if (!agentIds.has(agId)) {
        agentIds.add(agId);
        const agLabel = entry.agentType || 'SubAgent';
        nodes.push({
          id: `agent_${agId}`, type: 'agent', label: `Agent: ${agLabel}`,
          detail: JSON.stringify(entry, null, 2), timestamp: ts, agentId: agId,
          agentType: agLabel, status: 'running', parentId: orchestratorId,
        });
        edges.push({ from: orchestratorId, to: `agent_${agId}` });
      }
    }
  }

  // Parse subagent transcripts
  const subagentDir = path.join(path.dirname(filePath), sessionId, 'subagents');
  if (fs.existsSync(subagentDir)) {
    for (const sf of fs.readdirSync(subagentDir).filter(f => f.endsWith('.jsonl'))) {
      const agIdMatch = sf.match(/agent-(.+)\.jsonl/);
      if (!agIdMatch) { continue; }
      const agId = agIdMatch[1];
      const parentNodeId = `agent_${agId}`;
      const agentNode = nodes.find(n => n.id === parentNodeId);
      const subAgentLabel = agentNode?.label || agId;

      try {
        const subContent = fs.readFileSync(path.join(subagentDir, sf), 'utf-8');
        for (const subLine of subContent.trim().split('\n').filter(l => l.trim())) {
          let subEntry: JsonlEntry;
          try { subEntry = JSON.parse(subLine); } catch { continue; }

          if (subEntry.type === 'assistant' && Array.isArray(subEntry.message?.content)) {
            for (const block of subEntry.message!.content as ContentBlock[]) {
              processToolBlock(block, subEntry.timestamp || '', parentNodeId, subAgentLabel, parentNodeId,
                nodes, edges, touchedFiles, nodeCounter);
            }
            const usage = subEntry.message?.usage;
            if (usage) {
              totalInputTokens += usage.input_tokens || 0;
              totalOutputTokens += usage.output_tokens || 0;
            }
          }
        }
      } catch { /* skip */ }
    }
  }

  if (startTime && nodes.length > 0) { nodes[0].timestamp = startTime; }

  const totalCost =
    (totalInputTokens / 1_000_000) * INPUT_COST_PER_M +
    (totalOutputTokens / 1_000_000) * OUTPUT_COST_PER_M;

  return {
    sessionId, nodes, edges,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCost, agentCount: agentIds.size, startTime, isLive: false, touchedFiles,
  };
}

function extractTextContent(content: string | ContentBlock[] | undefined): string {
  if (!content) { return ''; }
  if (typeof content === 'string') { return content; }
  return content.filter(b => b.type === 'text' && b.text).map(b => b.text!).join(' ');
}

function formatToolLabel(name: string, input?: Record<string, unknown>): string {
  if (!input) { return name; }
  switch (name) {
    case 'Bash': return `Bash: ${truncate(String(input.command || ''), 40)}`;
    case 'Read': return `Read: ${truncate(String(input.file_path || input.path || ''), 40)}`;
    case 'Grep': return `Grep: ${truncate(String(input.pattern || ''), 30)}`;
    case 'Glob': return `Glob: ${truncate(String(input.pattern || ''), 30)}`;
    case 'Write': case 'Edit': case 'MultiEdit':
      return `${name}: ${truncate(String(input.file_path || input.path || ''), 40)}`;
    case 'WebSearch': return `WebSearch: ${truncate(String(input.query || ''), 35)}`;
    case 'ToolSearch': return `ToolSearch: ${truncate(String(input.query || ''), 35)}`;
    case 'TodoWrite': return `TodoWrite`;
    case 'Task': case 'Agent': return `Agent: ${truncate(String(input.description || input.prompt || ''), 35)}`;
    default: return name;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

export function discoverSessions(claudeDir: string): { label: string; filePath: string; date: string }[] {
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) { return []; }
  const sessions: { label: string; filePath: string; date: string }[] = [];
  for (const projDir of fs.readdirSync(projectsDir)) {
    const projPath = path.join(projectsDir, projDir);
    if (!fs.statSync(projPath).isDirectory()) { continue; }
    for (const jf of fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'))) {
      const fullPath = path.join(projPath, jf);
      const stats = fs.statSync(fullPath);
      const decodedProject = projDir.replace(/^-/, '/').replace(/-/g, '/');
      sessions.push({ label: `${decodedProject} — ${jf.slice(0, 8)}...`, filePath: fullPath, date: stats.mtime.toISOString() });
    }
  }
  sessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return sessions;
}
